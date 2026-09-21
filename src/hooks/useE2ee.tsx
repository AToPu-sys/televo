import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  decapCallKemSecret,
  decryptBytes,
  decryptMessage,
  decryptSignal,
  encryptBytes,
  encryptMessage,
  encryptSignal,
  generateCallKemSecret,
  generateSessionKey,
  getOrCreateDeviceKeyPair,
  getTrustedPeerKey,
  parseEnvelope,
  serializeEnvelope,
  setTrustedPeerKey,
  unwrapSessionKey,
  wrapSessionKey,
  type KeyPair,
  type SignalEnvelope,
} from "../lib/e2e";
import { supabase } from "../lib/supabase";

/** Thrown by encryptForConversation when this device has no session key for
 * a conversation the server has marked encrypted. Its own class rather than
 * matching on the message text, so a caller can distinguish "recoverable —
 * just re-run startEncryptedChat" from any other failure (network, RLS). */
export class MissingSessionKeyError extends Error {
  constructor() {
    super("No encryption key available for this chat yet.");
    this.name = "MissingSessionKeyError";
  }
}

type E2eeContextValue = {
  ready: boolean;
  publicKey: string | null;
  /** Marks a direct conversation as encrypted and deposits a wrapped session
   * key for the other participant. Call once, when starting a Secret Chat. */
  startEncryptedChat: (conversationId: string, otherUserId?: string) => Promise<void>;
  /** Encrypts a plaintext body for a conversation; throws if no session key
   * is available yet (the other side hasn't set one up, or it's still loading). */
  encryptForConversation: (conversationId: string, plaintext: string) => Promise<string>;
  /** Encrypts raw file bytes for a Secret Chat. Returns null when the chat
   * has no session key, so callers can refuse rather than upload in clear. */
  encryptBytesForConversation: (
    conversationId: string,
    data: Uint8Array
  ) => Promise<{ ciphertext: Uint8Array; nonce: string } | null>;
  decryptBytesForConversation: (
    conversationId: string,
    ciphertext: Uint8Array,
    nonce: string
  ) => Promise<Uint8Array | null>;
  /** Decrypts a stored body for a conversation; returns null if it can't be
   * decrypted (wrong/missing key, or the body isn't actually encrypted). */
  decryptForConversation: (conversationId: string, body: string) => Promise<string | null>;
  /** Conversation ids where the peer's public key no longer matches the one
   * this device trusted before — a reinstall, a new device, or someone in the
   * middle swapping keys look identical from here. Surfaced so the chat
   * screen can show a "peer's key changed, re-verify" banner instead of
   * silently accepting it. */
  peerKeyChanged: Set<string>;
  /** Call once the user has seen and acknowledged a key-change banner (e.g.
   * after re-verifying the safety number), so it doesn't keep reappearing. */
  acknowledgeKeyChange: (conversationId: string) => void;
  /** Deposits a wrapped copy of an already-established session key for any
   * participant who's missing one — never mints a new key, so it can't
   * desync anyone who already has a working copy. No-ops if this device
   * doesn't hold the key either. Safe to call every time a chat opens. */
  repairMissingSessionKeys: (conversationId: string) => Promise<void>;
  /** Repairs every encrypted conversation at once — see the implementation
   * for why the per-chat version alone leaves chats permanently broken. */
  repairAllSessionKeys: () => Promise<void>;
  /** True if this device can currently decrypt in this conversation — i.e.
   * loadSessionKey succeeds. Used to detect the rare case where a
   * conversation is flagged encrypted but no participant has a readable key
   * row left at all (e.g. every local keypair changed since the rows were
   * wrapped), which needs re-initializing from zero rather than repairing. */
  hasWorkingSessionKey: (conversationId: string) => Promise<boolean>;
  /** True if ANY participant has a wrapped session-key row for this
   * conversation — regardless of whether THIS device can open it. The
   * correct gate before minting a replacement key from zero: see its own
   * definition for the incident this exists to prevent. */
  anySessionKeyExists: (conversationId: string) => Promise<boolean>;
  /** Encrypts one call-signaling message (SDP/ICE) directly to a peer's
   * public key. Used so a call's offer/answer/ICE candidates — which carry
   * real IP addresses — aren't sent as plain JSON over Realtime broadcast.
   * The device's own private key never leaves this provider. Pass
   * callKemSecret (from generateCallKemSecret/decapCallKemSecret) once it's
   * established for the call, and kemCiphertext only on the one message that
   * should carry it (the caller's first signal). */
  encryptSignalToPeer: (
    payload: unknown,
    peerPublicKey: string,
    callKemSecret?: Uint8Array | null,
    kemCiphertext?: string
  ) => SignalEnvelope | null;
  /** Reverses encryptSignalToPeer; returns null if the keys don't match or
   * the envelope was tampered with. */
  decryptSignalFromPeer: <T = unknown>(
    envelope: SignalEnvelope,
    peerPublicKey: string,
    callKemSecret?: Uint8Array | null
  ) => T | null;
  /** Caller's side of establishing a call's one-per-call ML-KEM secret — see
   * generateCallKemSecret in lib/e2e. Null if this device has no keypair yet
   * or the peer has no Kyber key on file (falls back to X25519-only). */
  startCallKem: (
    peerKyberPublicKey: string | null | undefined
  ) => Promise<{ ciphertext: string; secret: Uint8Array } | null>;
  /** Callee's side: recovers the call secret the caller attached to its
   * first signal. Null if this device has no Kyber keypair yet. */
  receiveCallKem: (kemCiphertext: string) => Promise<Uint8Array | null>;
};

const E2eeContext = createContext<E2eeContextValue | undefined>(undefined);

export function E2eeProvider({
  userId,
  children,
}: {
  userId: string | undefined;
  children: ReactNode;
}) {
  const [keyPair, setKeyPair] = useState<KeyPair | null>(null);
  const [ready, setReady] = useState(false);
  // Decrypted session keys, kept in memory only — never persisted, never
  // sent anywhere. Re-derived from encrypted_session_keys each app launch.
  const sessionKeys = useRef(new Map<string, Uint8Array>());
  const [peerKeyChanged, setPeerKeyChanged] = useState(new Set<string>());

  useEffect(() => {
    // Decrypted per-conversation keys belong to whichever account was
    // signed in when they were derived. Without clearing here, signing out
    // and a DIFFERENT account signing in within the same process lifetime
    // (no force-quit in between) left the previous user's decrypted keys
    // resident in memory — never persisted to disk, so not reachable by
    // "the next person picking up the device" after a real relaunch, but
    // real residue for an in-process account switch.
    sessionKeys.current.clear();
    setKeyPair(null);
    setReady(false);
    setPeerKeyChanged(new Set());

    if (!userId) return;
    let active = true;

    (async () => {
      // Wrapped end to end: this runs as an unawaited IIFE the instant a
      // session appears (the same tick sign-in resolves), and there was no
      // try/catch anywhere in it. A throw here — SecureStore failing right
      // after a fresh sign-in, a dropped network request, or profiles'
      // .single() finding zero/多 rows because handle_new_user's trigger
      // hasn't committed yet — became an unhandled promise rejection with no
      // Error Boundary anywhere in the tree to catch it. On Hermes/release
      // builds that surfaced as the whole JS context silently resetting:
      // the user would see Chats for an instant right after signing in, then
      // land back on the Welcome screen with no visible error at all.
      try {
        const pair = await getOrCreateDeviceKeyPair();
        if (!active) return;
        setKeyPair(pair);

        // Publish both public keys if this profile doesn't have them yet (or
        // either changed — e.g. a reinstall generated a new device keypair, or
        // an existing device backfilled its ML-KEM half on this launch).
        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("e2e_public_key, e2e_kyber_public_key")
          .eq("id", userId)
          .single();
        if (profileError) {
          // Most commonly PGRST116 (no row yet) — a real race right after
          // signup, before handle_new_user's trigger has committed the
          // profiles row. Not fatal: this device just isn't ready to publish
          // its keys yet, so it retries next time this effect re-runs.
          console.error("[E2eeProvider] failed to read profile keys:", profileError.message);
        } else if (
          profile &&
          (profile.e2e_public_key !== pair.publicKey ||
            profile.e2e_kyber_public_key !== pair.kyberPublicKey)
        ) {
          await supabase
            .from("profiles")
            .update({ e2e_public_key: pair.publicKey, e2e_kyber_public_key: pair.kyberPublicKey })
            .eq("id", userId);
        }
      } catch (error) {
        console.error("[E2eeProvider] initialization failed:", error);
      } finally {
        if (active) setReady(true);
      }
    })();

    return () => {
      active = false;
    };
  }, [userId]);

  const loadSessionKey = useCallback(
    async (conversationId: string): Promise<Uint8Array | null> => {
      const cached = sessionKeys.current.get(conversationId);
      if (cached) return cached;
      if (!userId || !keyPair) {
        console.warn("[useE2ee] loadSessionKey: no userId/keyPair yet", {
          conversationId,
          hasUserId: !!userId,
          hasKeyPair: !!keyPair,
        });
        return null;
      }

      const { data, error: queryError } = await supabase
        .from("encrypted_session_keys")
        .select("encrypted_key, nonce, sender_public_key, kem_ciphertext")
        .eq("conversation_id", conversationId)
        .eq("recipient_id", userId)
        .maybeSingle();

      if (queryError) {
        console.error("[useE2ee] loadSessionKey: query failed", queryError.message, { conversationId });
      }
      if (!data) {
        console.warn("[useE2ee] loadSessionKey: no session-key row for this device", { conversationId, userId });
        return null;
      }

      // Detect a peer key swap BEFORE trusting it to unwrap anything — a
      // reinstall/new device and a MITM key substitution look identical from
      // here, and only this check tells the user something changed at all.
      // Skipped on first contact (nothing trusted yet): that first key is
      // trust-on-first-use, same as every other app doing this without an
      // out-of-band verification step at signup.
      const trusted = await getTrustedPeerKey(conversationId);
      if (trusted && trusted !== data.sender_public_key) {
        setPeerKeyChanged((current) => new Set(current).add(conversationId));
      } else if (!trusted) {
        await setTrustedPeerKey(conversationId, data.sender_public_key);
      }

      const unwrapped = await unwrapSessionKey(
        data.encrypted_key,
        data.nonce,
        data.sender_public_key,
        keyPair.secretKey,
        data.kem_ciphertext,
        keyPair.kyberSecretKey
      );
      if (!unwrapped) {
        console.warn(
          "[useE2ee] loadSessionKey: row exists but this device's keypair cannot unwrap it — deleting stale row",
          { conversationId, userId }
        );
        // A row EXISTS but this device's current keypair cannot open it —
        // permanently, not transiently. This happens after a reinstall or a
        // new device: getOrCreateDeviceKeyPair() mints a fresh keypair, but
        // the row here is still wrapped under whatever key this account held
        // when the sender last wrapped it. Retrying (what the UI's "tap to
        // retry" on a failed photo does) reads the exact same unopenable row
        // every time, which is why "Image unavailable" never recovers on its
        // own — see 016_harden_encryption_and_edit.sql's AUDIT FIX 4, which
        // added the RLS to allow this delete but never got a caller.
        //
        // Deleting it is safe and the correct repair: this device owns this
        // row (RLS restricts DELETE to `recipient_id = auth.uid()`), and
        // repairMissingSessionKeys() already re-deposits a fresh wrap for
        // any recipient who has NO row the next time a device that still
        // holds the real session key (the sender, or any other participant
        // who could already decrypt) opens this conversation — it just never
        // ran here because a row existed, even though it was useless. This
        // is what actually closes the loop: without it, the row stays
        // forever and no repair path is ever triggered again.
        void supabase
          .from("encrypted_session_keys")
          .delete()
          .eq("conversation_id", conversationId)
          .eq("recipient_id", userId)
          .then(({ error }) => {
            if (error) {
              console.error(
                "[useE2ee] failed to clear unwrappable session key row:",
                error.message,
                { conversationId }
              );
            }
          });
        return null;
      }

      sessionKeys.current.set(conversationId, unwrapped);
      return unwrapped;
    },
    [userId, keyPair]
  );

  const acknowledgeKeyChange = useCallback(
    (conversationId: string) => {
      setPeerKeyChanged((current) => {
        if (!current.has(conversationId)) return current;
        const next = new Set(current);
        next.delete(conversationId);
        return next;
      });
      if (!userId) return;
      // Re-arm trust-on-first-use for the new key so the banner doesn't
      // reappear on the same key next launch — the user has now (re)verified
      // it. Scoped to this device's own row: a group chat has one row per
      // recipient, and every other recipient's sender_public_key is a
      // different person's key entirely.
      sessionKeys.current.delete(conversationId);
      void supabase
        .from("encrypted_session_keys")
        .select("sender_public_key")
        .eq("conversation_id", conversationId)
        .eq("recipient_id", userId)
        .maybeSingle()
        .then(({ data }) => {
          if (data?.sender_public_key) void setTrustedPeerKey(conversationId, data.sender_public_key);
        });
    },
    [userId]
  );

  /**
   * Turns on encryption for a conversation. Works for groups as well as
   * direct chats: one random session key is generated and wrapped separately
   * to EVERY participant's public key, so each member can unwrap their own
   * copy and nobody else's. Previously groups had no encryption at all.
   */
  const startEncryptedChat = useCallback(
    async (conversationId: string, _otherUserId?: string) => {
      if (!userId || !keyPair) throw new Error("Encryption isn't ready yet.");

      const { data: participants, error: participantsError } = await supabase
        .from("conversation_participants")
        .select("user_id")
        .eq("conversation_id", conversationId);
      if (participantsError) throw participantsError;

      const memberIds = (participants ?? []).map((row) => row.user_id);
      if (memberIds.length === 0) throw new Error("This conversation has no members.");

      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id, display_name, e2e_public_key, e2e_kyber_public_key")
        .in("id", memberIds);
      if (profilesError) throw profilesError;

      const withoutKeys = (profiles ?? []).filter((profile) => !profile.e2e_public_key);
      if (withoutKeys.length > 0) {
        // Naming them makes this actionable instead of a dead end.
        throw new Error(
          `${withoutKeys.map((p) => p.display_name).join(", ")} hasn't opened the app on a version that supports encryption yet.`
        );
      }

      const sessionKey = generateSessionKey();

      // Keys inserted BEFORE marking the conversation encrypted, and in that
      // order deliberately: these are two separate writes (no transaction
      // spans a Postgres RLS-checked REST call from here), so if only one of
      // them can happen, it must be this one. Marking is_encrypted=true first
      // and having the key insert fail afterward would leave the
      // conversation flagged encrypted with NO session key for anyone — every
      // future loadSessionKey/repairMissingSessionKeys call would find
      // nothing to work with and the chat would be stuck exactly like the
      // original bug, just via a different trigger (a transient error here
      // instead of a batched-upsert RLS conflict). Doing the insert first
      // means a failure here simply leaves is_encrypted at its old value,
      // and the auto-encrypt effect tries again next time the chat opens.
      //
      // Plain insert, not upsert: the whole conversation shares ONE session
      // key, so if a row for some recipient already exists, some OTHER
      // device already generated a key and every message in this chat is
      // encrypted with it — silently overwriting that row with a freshly
      // generated key here would desync this device from everyone who
      // already has the real one. The RLS insert policy lets any
      // participant deposit a row for anyone (004_e2e_encryption.sql:43-46);
      // it's the UPDATE policy that's recipient-only, which is why a naive
      // upsert batching every participant died with "row-level security
      // policy" the moment ANY one of those rows already existed — including
      // this device's own row, which was otherwise perfectly insertable on
      // its own. This function is therefore only meant to run on a
      // conversation with NO existing session key at all (guarded by the
      // caller checking is_encrypted); recovering a single missing row on an
      // already-encrypted conversation is repairMissingSessionKeys' job.
      // Deposited one-by-one through the SECURITY DEFINER RPC rather than as
      // one batch insert. A batch fails as a whole the moment ANY row already
      // exists — which happens routinely: two devices opening the same chat
      // at once both see is_encrypted=false and both get here, and the loser
      // used to surface a red primary-key/RLS error even though the
      // conversation ended up perfectly encrypted by the winner. The RPC
      // skips a row that already exists (returns false) instead of failing,
      // so the loser of that race silently converges on the winner's key —
      // in theory. In practice this only checked THIS device's own row,
      // which is not the same claim.
      //
      // Real incident this caused (2026-09-19): two participants opened the
      // same never-encrypted 1:1 chat within moments of each other. Device A
      // deposited its own row first (won), then deposited a row FOR B — but
      // B had, in the same window, already deposited its OWN row first, so
      // A's deposit-for-B silently no-op'd on the conflict. Symmetrically, B
      // deposited its own row (won) and its deposit-for-A lost to A's
      // earlier row. Both devices then checked only `profile.id === userId`
      // — which was true for BOTH of them, since each device's OWN row
      // really did win its own race — so both concluded "I won" and both
      // cached and sent under their own, DIFFERENT session key from then on.
      // Neither side's `loadSessionKey` fallback below ever ran, because it
      // was gated on the wrong condition. Every message either side sent
      // was permanently unreadable by the other, symmetrically, with no
      // error surfaced anywhere — indistinguishable from a healthy chat
      // until someone actually read a reply.
      //
      // The only claim that's actually safe to trust is "every row in this
      // batch was newly inserted" — if even one row (ANY recipient's, not
      // just this device's own) lost its conflict, some other device's key
      // is already the real one for at least part of this conversation, and
      // this device's freshly generated key must be discarded in favor of
      // it, not just when its own row specifically lost.
      let allRowsInserted = true;
      for (const profile of profiles ?? []) {
        const wrapped = await wrapSessionKey(
          sessionKey,
          profile.e2e_public_key!,
          keyPair.secretKey,
          profile.e2e_kyber_public_key
        );
        const { data: inserted, error: depositError } = await supabase.rpc(
          "deposit_session_key_if_missing",
          {
            p_conversation_id: conversationId,
            p_recipient_id: profile.id,
            p_sender_public_key: keyPair.publicKey,
            p_encrypted_key: wrapped.encryptedKey,
            p_nonce: wrapped.nonce,
            p_kem_ciphertext: wrapped.kemCiphertext ?? undefined,
          }
        );
        if (depositError) throw depositError;
        if (inserted !== true) allRowsInserted = false;
      }

      // If ANY row in this batch already existed — this device's own row or
      // anyone else's — another device's key may already be (partly or
      // fully) in effect for this conversation. Load the real one from the
      // database instead of trusting the one generated locally; the
      // generated key is simply discarded. See allRowsInserted's comment for
      // the incident this replaces the narrower (and wrong) own-row-only
      // check that used to be here.
      if (!allRowsInserted) {
        sessionKeys.current.delete(conversationId);
        await loadSessionKey(conversationId);
        return;
      }

      const { error: markError } = await supabase
        .from("conversations")
        .update({ is_encrypted: true })
        .eq("id", conversationId);
      if (markError) {
        // The keys are already safely deposited at this point; only the
        // client-visible flag failed to flip. Not fatal — loadSessionKey
        // doesn't check is_encrypted at all, so encryption is already
        // functionally active. Log it since it means a plaintext-looking
        // conversation is actually encrypted underneath until this retries.
        // eslint-disable-next-line no-console
        console.error("[startEncryptedChat] marking conversation encrypted failed:", markError.message, {
          conversationId,
        });
        throw markError;
      }

      sessionKeys.current.set(conversationId, sessionKey);
    },
    [userId, keyPair, loadSessionKey]
  );

  /**
   * Fixes a conversation where the session key exists (this device can
   * already decrypt/encrypt in it — loadSessionKey succeeded), but one or
   * more OTHER participants have no wrapped copy of it — the state a batch
   * upsert used to leave things in (see startEncryptedChat's own comment).
   * Deposits a wrapped copy of the ALREADY-ESTABLISHED key for whoever is
   * missing one, via plain insert (never touching an existing row, so this
   * can never desync anyone who already has a working copy).
   *
   * Runs automatically whenever a chat screen opens on an encrypted
   * conversation and this device holds the key — cheap (one extra select),
   * and it means the fix propagates from whichever device happens to open
   * the chat next, no explicit user action required.
   */
  const repairMissingSessionKeys = useCallback(
    async (conversationId: string) => {
      if (!userId || !keyPair) return;
      const sessionKey = await loadSessionKey(conversationId);
      if (!sessionKey) return; // Nothing this device can do without the real key.

      const { data: participants } = await supabase
        .from("conversation_participants")
        .select("user_id")
        .eq("conversation_id", conversationId);
      // No self-check here on purpose: the SELECT RLS policy on
      // encrypted_session_keys restricts every read to `recipient_id =
      // auth.uid()` (004_e2e_encryption.sql:36-39), so a query for OTHER
      // participants' rows always comes back empty regardless of what
      // actually exists — this device literally cannot see whether a peer
      // already has a row. An earlier version of this function tried to
      // pre-filter to only the "missing" recipients using exactly that
      // unreadable query, which meant it always treated everyone but itself
      // as missing and then inserted for all of them in one batch — the
      // moment even one of those rows genuinely already existed, the WHOLE
      // batch INSERT failed on the primary-key conflict and the actually
      // missing recipient was never repaired either.
      const otherMemberIds = (participants ?? [])
        .map((row) => row.user_id)
        .filter((id) => id !== userId);
      if (otherMemberIds.length === 0) return;

      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, e2e_public_key, e2e_kyber_public_key")
        .in("id", otherMemberIds);
      const withKeys = (profiles ?? []).filter(
        (profile): profile is typeof profile & { e2e_public_key: string } => !!profile.e2e_public_key
      );
      if (withKeys.length === 0) return;

      // One RPC call per recipient instead of a client-side upsert: Postgres
      // runs an INSERT policy's WITH CHECK against the proposed row even
      // under ON CONFLICT DO NOTHING, before it knows the row will conflict
      // — so upsert(..., {ignoreDuplicates: true}) still threw an RLS
      // violation ("new row violates row-level security policy") for every
      // recipient who already had a row, which is the common case here.
      // There's also no way to check for that row client-side first: the
      // SELECT policy on this table is recipient-only, so this device can
      // never read whether a PEER already has one. deposit_session_key_if_missing
      // (022_deposit_session_key_rpc.sql) is SECURITY DEFINER, so it can see
      // and skip an existing row atomically server-side instead.
      for (const profile of withKeys) {
        try {
          // wrapSessionKey base64-decodes profile.e2e_public_key and feeds it
          // straight into nacl.box — a malformed or wrong-length key (e.g. a
          // stale row from an old client build) throws synchronously here.
          // Caught per-recipient so one bad peer's key can't stop the others
          // from being repaired too.
          const wrapped = await wrapSessionKey(
            sessionKey,
            profile.e2e_public_key,
            keyPair.secretKey,
            profile.e2e_kyber_public_key
          );
          const { error } = await supabase.rpc("deposit_session_key_if_missing", {
            p_conversation_id: conversationId,
            p_recipient_id: profile.id,
            p_sender_public_key: keyPair.publicKey,
            p_encrypted_key: wrapped.encryptedKey,
            p_nonce: wrapped.nonce,
            p_kem_ciphertext: wrapped.kemCiphertext ?? undefined,
          });
          if (error) {
            // eslint-disable-next-line no-console
            console.error("[repairMissingSessionKeys] deposit failed for one recipient:", error.message, {
              conversationId,
              recipientId: profile.id,
            });
          }
        } catch (caught) {
          // eslint-disable-next-line no-console
          console.error("[repairMissingSessionKeys] wrap failed for one recipient:", caught, {
            conversationId,
            recipientId: profile.id,
          });
        }
        // Either way, keep going — one recipient failing (bad key, RLS edge
        // case, network) must not stop the others from getting repaired.
      }
    },
    [userId, keyPair, loadSessionKey]
  );

  /**
   * Runs repairMissingSessionKeys across EVERY encrypted conversation this
   * device takes part in, rather than only the one currently on screen.
   *
   * Why this is needed on top of the per-chat repair: a participant whose
   * wrapped key row is missing cannot fix it themselves — repair starts
   * from loadSessionKey, which is exactly what fails for them. Only a peer
   * who still holds the key can re-deposit it. With repair wired solely to
   * the chat screen, that peer had to happen to OPEN that specific
   * conversation, so a chat stayed unreadable indefinitely for the affected
   * side while looking perfectly normal to the other.
   *
   * Measured 2026-09-19: three 1:1 conversations were in exactly this
   * state, all with the same participant missing a row after a keypair
   * rotation (profiles.e2e_public_key updated 17:54 that day, while the
   * peers' rows dated from 2026-09-05). Each would only have healed when
   * that particular peer next opened that particular thread.
   *
   * Sweeping from the chat LIST closes that gap: opening the app is enough
   * for a device to top up everyone it can, in every thread it holds a key
   * for. Cost is one select plus one deposit RPC per genuinely missing
   * recipient — the RPC is SECURITY DEFINER and skips recipients who
   * already have a row server-side, so the steady-state cost is a single
   * cheap no-op call per conversation.
   */
  const repairAllSessionKeys = useCallback(async () => {
    if (!userId || !keyPair) return;
    const { data: rows, error } = await supabase
      .from("conversation_participants")
      .select("conversation_id, conversations!inner(is_encrypted)")
      .eq("user_id", userId)
      .eq("conversations.is_encrypted", true);
    if (error || !rows) return;

    // Sequential rather than Promise.all: this runs at app open, competing
    // with the chat list's own queries, and a burst of parallel wraps (each
    // one an X25519 + ML-KEM operation) on the JS thread is visible as a
    // stutter on the list it is running behind.
    for (const row of rows) {
      try {
        await repairMissingSessionKeys(row.conversation_id);
      } catch {
        // Per-conversation failure must not stop the sweep — the whole
        // point is to repair as many as possible from whoever can.
      }
    }
  }, [userId, keyPair, repairMissingSessionKeys]);

  const hasWorkingSessionKey = useCallback(
    async (conversationId: string): Promise<boolean> => {
      const key = await loadSessionKey(conversationId);
      return !!key;
    },
    [loadSessionKey]
  );

  /** True if ANY participant — not just this device — has a wrapped session
   * key row for this conversation. Distinct from hasWorkingSessionKey, which
   * only answers "can THIS device decrypt," and was, until 2026-09-19, the
   * ONLY check app/chat/[id].tsx's "reinit from zero" effect made before
   * generating a brand new session key. That effect's own comment claimed
   * doing so was "safe... because there is no readable key anywhere left to
   * desync from" — which this device genuinely cannot know from
   * hasWorkingSessionKey alone. The real incident this caused: a device that
   * lost its local keypair (a reinstall — see src/lib/e2e.ts) opens an
   * already-encrypted 1:1 chat, hasWorkingSessionKey correctly says false
   * for THIS device, the effect concludes "nobody has a key" and calls
   * startEncryptedChat, which mints and deposits a NEW session key. The
   * other participant's row — deposited days earlier under the real,
   * still-working shared key — is untouched (deposit_session_key_if_missing
   * only ever ADDS a missing row, never overwrites one that exists), so the
   * two participants end up on two different, mutually undecryptable keys.
   * Every message either side sends afterward is permanently unreadable by
   * the other. This is exactly the "Unable to decrypt for everyone, not
   * just me" report from 2026-09-19, and it reproduced identically after
   * being manually repaired in the database, because the underlying trigger
   * — a device opening a chat whose OWN copy of the key is gone — was still
   * there. The correct question before minting a replacement key is "does
   * ANY row exist for this conversation," which this function answers by
   * reading encrypted_session_keys directly rather than trying to unwrap
   * anything.
   *
   * Goes through the any_session_key_exists RPC (050_any_session_key_exists
   * _rpc.sql), not a direct table query: encrypted_session_keys' own SELECT
   * policy restricts every row to `recipient_id = auth.uid()` — correct for
   * reading the key material itself, but it means a plain
   * `.from("encrypted_session_keys").select(...)` from here would see ONLY
   * this device's own row and never the other participant's, making this
   * function behave identically to hasWorkingSessionKey for exactly the
   * device this exists to fix. The RPC is SECURITY DEFINER specifically to
   * see past that per-row restriction, while still only ever returning a
   * boolean — never the wrapped key — to the client. */
  const anySessionKeyExists = useCallback(async (conversationId: string): Promise<boolean> => {
    const { data, error } = await supabase.rpc("any_session_key_exists", {
      p_conversation_id: conversationId,
    });
    if (error) {
      console.error("[useE2ee] any_session_key_exists failed:", error.message, { conversationId });
      // Fail closed toward NOT reinitializing: an RPC error is far more
      // likely to be transient (network, a cold Postgres connection) than
      // proof that zero rows exist, and wrongly minting a replacement key
      // here is exactly the desync this function exists to prevent.
      return true;
    }
    return data === true;
  }, []);

  const encryptSignalToPeer = useCallback(
    (
      payload: unknown,
      peerPublicKey: string,
      callKemSecret?: Uint8Array | null,
      kemCiphertext?: string
    ): SignalEnvelope | null => {
      if (!keyPair) return null;
      return encryptSignal(payload, peerPublicKey, keyPair.secretKey, callKemSecret, kemCiphertext);
    },
    [keyPair]
  );

  const decryptSignalFromPeer = useCallback(
    <T,>(envelope: SignalEnvelope, peerPublicKey: string, callKemSecret?: Uint8Array | null): T | null => {
      if (!keyPair) return null;
      return decryptSignal<T>(envelope, peerPublicKey, keyPair.secretKey, callKemSecret);
    },
    [keyPair]
  );

  const startCallKem = useCallback(
    async (
      peerKyberPublicKey: string | null | undefined
    ): Promise<{ ciphertext: string; secret: Uint8Array } | null> => {
      if (!peerKyberPublicKey) return null;
      return generateCallKemSecret(peerKyberPublicKey);
    },
    []
  );

  const receiveCallKem = useCallback(
    async (kemCiphertext: string): Promise<Uint8Array | null> => {
      if (!keyPair) return null;
      return decapCallKemSecret(kemCiphertext, keyPair.kyberSecretKey);
    },
    [keyPair]
  );

  const encryptBytesForConversation = useCallback(
    async (conversationId: string, data: Uint8Array) => {
      const sessionKey = await loadSessionKey(conversationId);
      if (!sessionKey) return null;
      return encryptBytes(data, sessionKey);
    },
    [loadSessionKey]
  );

  const decryptBytesForConversation = useCallback(
    async (conversationId: string, ciphertext: Uint8Array, nonce: string) => {
      const sessionKey = await loadSessionKey(conversationId);
      if (!sessionKey) return null;
      return decryptBytes(ciphertext, nonce, sessionKey);
    },
    [loadSessionKey]
  );

  const encryptForConversation = useCallback(
    async (conversationId: string, plaintext: string) => {
      const sessionKey = await loadSessionKey(conversationId);
      if (!sessionKey) {
        throw new MissingSessionKeyError();
      }
      return serializeEnvelope(encryptMessage(plaintext, sessionKey));
    },
    [loadSessionKey]
  );

  const decryptForConversation = useCallback(
    async (conversationId: string, body: string) => {
      const envelope = parseEnvelope(body);
      if (!envelope) return null;

      const sessionKey = await loadSessionKey(conversationId);
      if (!sessionKey) return null;

      return decryptMessage(envelope, sessionKey);
    },
    [loadSessionKey]
  );

  // Memoised, and this matters far more than it looks. An unmemoised value
  // object is a NEW object on every render of this provider — and it
  // re-renders whenever peerKeyChanged updates. Everything downstream that
  // depends on a function from this context (useIncomingCalls' subscription,
  // useMessages' realtime channel, useChats' loader) would then tear its
  // subscription down and rebuild it. Supabase Realtime has no replay, so an
  // event arriving inside that window is lost for good — an incoming call
  // that simply never appears, or a message that never shows up until the
  // thread is reopened.
  const value = useMemo(
    () => ({
      ready,
      publicKey: keyPair?.publicKey ?? null,
      startEncryptedChat,
      encryptForConversation,
      encryptBytesForConversation,
      decryptBytesForConversation,
      decryptForConversation,
      peerKeyChanged,
      acknowledgeKeyChange,
      repairMissingSessionKeys,
      repairAllSessionKeys,
      hasWorkingSessionKey,
      anySessionKeyExists,
      encryptSignalToPeer,
      decryptSignalFromPeer,
      startCallKem,
      receiveCallKem,
    }),
    [
      ready,
      keyPair,
      startEncryptedChat,
      encryptForConversation,
      encryptBytesForConversation,
      decryptBytesForConversation,
      decryptForConversation,
      peerKeyChanged,
      acknowledgeKeyChange,
      repairMissingSessionKeys,
      repairAllSessionKeys,
      hasWorkingSessionKey,
      anySessionKeyExists,
      encryptSignalToPeer,
      decryptSignalFromPeer,
      startCallKem,
      receiveCallKem,
    ]
  );

  return (
    <E2eeContext.Provider value={value}>
      {children}
    </E2eeContext.Provider>
  );
}

export function useE2ee() {
  const context = useContext(E2eeContext);
  if (!context) {
    throw new Error("useE2ee must be used within an E2eeProvider");
  }
  return context;
}
