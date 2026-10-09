import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, AppState, Keyboard, Platform } from "react-native";

import * as Device from "expo-device";
import * as Notifications from "expo-notifications";

import {
  consumeAnsweredCall,
  consumePendingIncomingCall,
  consumePendingVoipToken,
  onVoipToken,
  endCallKitCall,
  onCallKitAnswer,
  onCallKitEnd,
  onCallKitMuteChanged,
  reportIncomingCall,
  reportIncomingCallAnswered,
  reportOutgoingCallConnected,
  reportOutgoingCallStarted,
} from "expo-callkit";

import { markNextCallAsAnsweredViaCallKit } from "../components/WebRtcBridge";
import { decodeSessionIdFromAccessToken, supabase } from "../lib/supabase";
import { callsSupported } from "../lib/webrtcModule";
import type { Database } from "../types/database";
import { useAuth } from "./useAuth";
import { useCall } from "./useCall";
import { useE2ee } from "./useE2ee";
import { useIncomingCalls } from "./useIncomingCalls";

type CallKind = Database["public"]["Enums"]["call_kind"];
type CallRow = Database["public"]["Tables"]["calls"]["Row"];

type PeerInfo = {
  name: string;
  avatarUrl: string | null;
  publicKey?: string | null;
  /** ML-KEM-768 public key, for the hybrid post-quantum call signaling
   * secret (see startCallKem in useE2ee). Absent for a peer on a pre-upgrade
   * build — signaling then falls back to X25519-only, same as always. */
  kyberPublicKey?: string | null;
  /** Groups have no single peer key, so their cache entry is complete without one. */
  isGroup?: boolean;
};

type CallManagerValue = ReturnType<typeof useCall> & {
  peer: PeerInfo | null;
  placeCall: (conversationId: string, kind: CallKind) => Promise<void>;
  /** Whether CallOverlay is currently showing the minimized swipe-down
   * widget instead of the full-screen call UI. Lifted up from CallOverlay
   * into this shared context — rather than kept as that component's own
   * local state — specifically so RootNavigator (app/_layout.tsx) can read
   * it too: the minimized widget's green bar needs the REST of the app to
   * make room for it (push its content down, the way iOS's own "call in
   * progress" status bar banner does for every app), which only the root
   * layout can do. CallOverlay still owns setting it; this context is
   * just where the value lives so both places can see it. */
  minimized: boolean;
  setMinimized: (value: boolean) => void;
};

const CallManagerContext = createContext<CallManagerValue | undefined>(undefined);

export function CallManagerProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { ready: e2eeReady } = useE2ee();
  const [peer, setPeer] = useState<PeerInfo | null>(null);
  const call = useCall(user?.id, peer?.publicKey);

  // Uploads the VoIP push token PKPushRegistry obtained — possibly before
  // this component ever mounted, on a cold launch driven purely by push
  // registration (see CallKitAppDelegateSubscriber).
  //
  // Retries rather than giving up on the first failure. The observed failure
  // is "JWT issued in the future": GoTrue stamps a freshly refreshed access
  // token's `iat`, PostgREST validates it, and a sub-second clock difference
  // between those two services makes the token briefly look future-dated.
  // Mounting happens to coincide with a token refresh often enough to hit
  // it, and without a retry the device would then have NO VoIP token
  // registered until the app was restarted — meaning calls silently don't
  // ring, which is far worse than the transient error itself.
  useEffect(() => {
    if (!user?.id) return;
    const userId = user.id;
    let cancelled = false;
    let attempt = 0;
    let token: string | null = null;

    const register = async () => {
      if (!token) return;
      if (cancelled) return;
      // claim_voip_push_token, not an upsert: the token identifies a DEVICE,
      // so a second account signing in on the same phone has to take it over
      // rather than add itself as a second owner. Two owners means the
      // server sends the wake-up push to both, and the phone rings for calls
      // belonging to whoever used it previously — while the account actually
      // being called may have no usable row at all. Removing the other
      // account's row needs SECURITY DEFINER; RLS only lets a client delete
      // its own.
      const { data: sessionData } = await supabase.auth.getSession();
      const sessionId = sessionData.session
        ? decodeSessionIdFromAccessToken(sessionData.session.access_token)
        : null;
      const { error } = await supabase.rpc("claim_voip_push_token", {
        p_token: token,
        p_device_name: Device.deviceName ?? undefined,
        p_session_id: sessionId ?? undefined,
        p_device_model: Device.modelName ?? undefined,
      });
      if (!error || cancelled) return;

      attempt += 1;
      if (attempt <= 3) {
        // Backs off a few seconds: clock skew of this kind resolves on the
        // next token refresh, and the retry costs nothing if it doesn't.
        setTimeout(register, attempt * 3000);
        return;
      }
      console.error("[useCallManager] voip token registration failed:", error.message);
    };

    // Two sources, because either alone loses the token:
    //  - the stored value covers a launch where PushKit delivered before the
    //    JS bridge existed;
    //  - the live event covers the opposite order, which is the common one,
    //    and is what a REINSTALL hits. Reading the store once (and clearing
    //    it) meant a reinstalled app kept advertising the token iOS had just
    //    invalidated, so incoming calls silently never rang.
    token = consumePendingVoipToken();
    void register();

    const subscription = onVoipToken((fresh) => {
      // Re-registering the same token is harmless; claim_voip_push_token is
      // idempotent for the same owner.
      token = fresh;
      attempt = 0;
      void register();
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [user?.id]);
  // Keyed only by conversationId, not by which account is signed in — a
  // deliberate simplification that broke the instant two different accounts
  // shared this device. resolvePeer's "the other participant" is computed
  // relative to `user.id`, so a conversation resolved once under account A
  // and again under account B has two DIFFERENT correct answers for the same
  // key. The cache doesn't know that: it just returns whatever it resolved
  // first. On a phone used for multi-account testing (or a real device that
  // signs out and back in as someone else), this is why an incoming call
  // could show a stranger's name/photo, or — as observed — a leftover
  // "Debug User" test-profile name from whichever account had FIRST resolved
  // that conversation earlier in the process's lifetime, even though the
  // native CallKit screen (which gets the caller name fresh in every VoIP
  // push payload, not from this cache) showed the real caller correctly.
  // Clearing it on every account change is the fix: it's a same-process,
  // in-memory cache, so there's no persistence to also clean up.
  const conversationPeerCache = useRef(new Map<string, PeerInfo>());
  useEffect(() => {
    conversationPeerCache.current.clear();
  }, [user?.id]);
  // The device keypair loads asynchronously (SecureStore + a profile sync).
  // Signaling started before it lands can neither encrypt nor decrypt, so
  // both call paths wait for it rather than silently falling back to
  // plaintext on one side only.
  const e2eeReadyRef = useRef(e2eeReady);
  e2eeReadyRef.current = e2eeReady;
  // The call id handleIncoming has already started processing — set
  // SYNCHRONOUSLY at the top of that function, before any `await`.
  //
  // Real incident this fixes (2026-09-19): the same incoming call reaches
  // handleIncoming through two independent paths — a VoIP push (cold
  // launch, reports to CallKit natively before JS runs) and the Realtime
  // "ringing" row INSERT — and the function's own comment already
  // acknowledged this as expected, guarding against it via
  // `call.state.phase !== "idle" && call.state.phase !== "ended"`. That
  // guard reads `call.state`, which only updates on a React commit AFTER
  // `listenForOffer` has already run several `await`s deep (resolvePeer,
  // waitForE2ee can each take real time). If both paths fire within that
  // window, both read phase as still "idle" and BOTH proceed to call
  // `call.listenForOffer(incomingCall)` — subscribing to the same
  // `call:${callId}` signaling channel twice. The caller's single offer
  // then reaches TWO handlers, each independently creating and sending its
  // own SDP answer: the caller applies the first answer fine, then the
  // second `setRemoteDescription` fails with "Called in wrong state:
  // stable" and the call drops. A plain ref set before any await closes
  // the race a state-derived check structurally cannot.
  const incomingCallHandledRef = useRef<string | null>(null);

  const waitForE2ee = useCallback(async () => {
    if (e2eeReadyRef.current) return true;
    const startedAt = Date.now();
    return new Promise<boolean>((resolve) => {
      const poll = setInterval(() => {
        if (e2eeReadyRef.current) {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() - startedAt > 5000) {
          clearInterval(poll);
          resolve(false);
        }
      }, 50);
    });
  }, []);

  // Refresh for a cache HIT: re-fetches display_name/avatar_url AND the
  // E2EE keys, and patches both the cache entry and, if this conversation
  // is the one currently on screen, the live `peer` state. Called two ways
  // by resolvePeer below: fire-and-forget for a GROUP hit (no per-peer call
  // key to go stale), and awaited for a 1:1 hit — a call must not start
  // signaling under whatever key happened to be cached before this
  // resolves.
  //
  // The keys are included now, not skipped as an "expensive to re-derive"
  // optimization. That framing was backwards: a SELECT against profiles
  // costs nothing, and skipping it is what silently broke every call
  // signal — confirmed live: a call between two accounts whose PLAIN CHAT
  // decrypted fine (that path reads the sender's key straight from
  // encrypted_session_keys, never from this cache) still had every single
  // signal (offer/answer/ICE) rejected with "decryption failed", because
  // conversationPeerCache had pinned a publicKey from before the peer's
  // key changed (reinstall, new device, or a Kyber-key backfill — see
  // useE2ee's "publish both public keys if... either changed") and never
  // checked it again for the rest of the process's lifetime. A stale NAME
  // just looks wrong; a stale KEY makes every call permanently
  // undecryptable with no error visible anywhere outside the trace log.
  const refreshPeerDisplay = useCallback(
    async (conversationId: string, cached: PeerInfo) => {
      if (cached.isGroup) return;
      // Wrapped end to end: resolvePeer now AWAITS this for a 1:1 cache hit
      // (see below), so an unhandled rejection here — a network error on a
      // flaky connection, which is exactly the kind of link a cross-city
      // call runs over — would otherwise propagate out of resolvePeer and
      // abort placeCall/handleIncoming entirely, turning a transient
      // network hiccup into "the call never starts". Falling back to the
      // cached entry is always safe: it's the same value this call would
      // have used before this refresh existed at all.
      try {
        const { data } = await supabase
          .from("conversations")
          .select("conversation_participants ( user_id )")
          .eq("id", conversationId)
          .single();
        const other = (data?.conversation_participants ?? []).find(
          (participant) => participant.user_id !== user?.id
        );
        if (!other) return;

        const { data: profile } = await supabase
          .from("profiles")
          .select("display_name, avatar_url, e2e_public_key, e2e_kyber_public_key")
          .eq("id", other.user_id)
          .single();
        if (!profile) return;
        if (
          profile.display_name === cached.name &&
          profile.avatar_url === cached.avatarUrl &&
          profile.e2e_public_key === cached.publicKey &&
          profile.e2e_kyber_public_key === cached.kyberPublicKey
        ) {
          return;
        }

        const updated = {
          ...cached,
          name: profile.display_name,
          avatarUrl: profile.avatar_url,
          publicKey: profile.e2e_public_key,
          kyberPublicKey: profile.e2e_kyber_public_key,
        };
        conversationPeerCache.current.set(conversationId, updated);
        setPeer((current) => (current === cached ? updated : current));
      } catch (error) {
        console.error("[useCallManager] refreshPeerDisplay failed:", error);
      }
    },
    [user?.id]
  );

  const resolvePeer = useCallback(
    async (conversationId: string): Promise<PeerInfo> => {
      const cached = conversationPeerCache.current.get(conversationId);
      // Re-resolve if the cached entry has no public key: it may have been
      // captured before the peer published one, and reusing it would pin
      // every later call in this conversation to unencrypted signaling for
      // the rest of the session. Groups legitimately have no peer key, so
      // they stay cached as-is — and can return synchronously, since a
      // group has no per-peer call key to go stale in the first place.
      if (cached && cached.isGroup) {
        void refreshPeerDisplay(conversationId, cached);
        return cached;
      }
      // A 1:1 cache hit AWAITS the refresh before returning, unlike the
      // group case above — the key must be current before a caller (
      // placeCall/handleIncoming) uses it to start signaling a call, not
      // just eventually correct for some LATER call. This was fire-and-
      // forget before, which is exactly what let a call start signaling
      // under a publicKey this cache had pinned from before the peer's key
      // actually changed (reinstall, new device, or a Kyber-key backfill).
      // The peer's PLAIN CHAT still decrypted fine throughout — that path
      // reads the sender's key from encrypted_session_keys, never from this
      // cache — so the call's signals silently failing looked exactly like
      // "CallKit works, the call itself does nothing": every offer/answer/
      // ICE candidate was rejected as undecryptable, with no error visible
      // anywhere except the call trace log ("decryption failed").
      //
      // Still cheap: this is one indexed SELECT against profiles, not a
      // cryptographic operation — the old comment here called the key
      // "expensive to re-derive" and used that to justify skipping the
      // check that would have caught it; the actual cost is a single
      // network round trip, negligible next to a call's own setup latency.
      if (cached && cached.publicKey) {
        // Bounded, not an unconditional await: refreshPeerDisplay's own
        // try/catch already stops a network ERROR from propagating, but a
        // slow connection that neither errors nor resolves — the failure
        // mode a cross-city call is far more likely to hit than a clean
        // rejection — would otherwise stall the call indefinitely with no
        // error at all. 2.5s is generous next to an ordinary SELECT
        // round trip and still short next to how long a caller will
        // tolerate "Calling..." doing nothing before assuming it's broken.
        await Promise.race([
          refreshPeerDisplay(conversationId, cached),
          new Promise<void>((resolve) => setTimeout(resolve, 2500)),
        ]);
        return conversationPeerCache.current.get(conversationId) ?? cached;
      }

      const { data } = await supabase
        .from("conversations")
        .select("kind, title, conversation_participants ( user_id )")
        .eq("id", conversationId)
        .single();

      if (!data) return { name: "Unknown", avatarUrl: null };

      if (data.kind === "group") {
        const info = { name: data.title ?? "Group", avatarUrl: null, isGroup: true };
        conversationPeerCache.current.set(conversationId, info);
        return info;
      }

      const other = (data.conversation_participants ?? []).find(
        (participant) => participant.user_id !== user?.id
      );
      if (!other) return { name: "Unknown", avatarUrl: null };

      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name, avatar_url, e2e_public_key, e2e_kyber_public_key")
        .eq("id", other.user_id)
        .single();

      const info = {
        name: profile?.display_name ?? "Unknown",
        avatarUrl: profile?.avatar_url ?? null,
        publicKey: profile?.e2e_public_key ?? null,
        kyberPublicKey: profile?.e2e_kyber_public_key ?? null,
      };
      conversationPeerCache.current.set(conversationId, info);
      return info;
    },
    [user?.id]
  );

  const placeCall = useCallback(
    async (conversationId: string, kind: CallKind) => {
      // Calls need the native WebRTC module, which Expo Go does not ship.
      // Saying so is better than starting a call that can never open the
      // microphone and appears to hang.
      if (!callsSupported()) {
        Alert.alert(
          "Calls need the full app",
          "Voice and video calls use a native module that Expo Go can't load. Install the development build to make calls."
        );
        return;
      }
      // Mirrors handleIncoming's busy guard: without it, tapping "call" on a
      // different chat while one call is already ringing/active tore down
      // that call's signaling state mid-flight (startCall resets roleRef,
      // pendingOfferRef, etc. unconditionally) — the in-progress call went
      // silently dead for both sides while this device dialed a second one.
      if (call.state.phase !== "idle" && call.state.phase !== "ended") {
        Alert.alert("Call in progress", "End the current call before starting a new one.");
        return;
      }
      // The boolean is checked, not discarded. waitForE2ee gives up after
      // 5s and returns false; proceeding anyway meant useCall captured a
      // null keypair for the whole call, so decodeFromWire dropped EVERY
      // incoming signal as undecryptable — a call that rings forever and
      // can never connect, with no error anywhere. Failing loudly is far
      // better than a silent dead call.
      if (!(await waitForE2ee())) {
        Alert.alert(
          "Encryption isn't ready",
          "Televo is still unlocking this device's encryption keys. Try the call again in a moment."
        );
        return;
      }
      const info = await resolvePeer(conversationId);
      setPeer(info);
      // Synchronously, before startCall: setPeer only lands on the next
      // render, so useCall would still be holding the previous key and would
      // sign the offer with the wrong one (or none).
      call.setPeerPublicKey(info.publicKey);
      call.setPeerKyberPublicKey(info.kyberPublicKey);
      await call.startCall(conversationId, kind);
    },
    [call, resolvePeer, waitForE2ee]
  );

  const handleIncoming = useCallback(
    async (incomingCall: CallRow) => {
      // Without the native module there is no way to answer, so ringing would
      // only offer an Accept button that cannot work.
      if (!callsSupported()) return;
      // Synchronous dedup, checked and set BEFORE any await below (the
      // busyState/phase check a few lines down runs too, but that one reads
      // React state that hasn't committed yet on a fast double-fire — see
      // incomingCallHandledRef's own comment for the exact race this closes
      // that the phase check alone cannot).
      if (incomingCallHandledRef.current === incomingCall.id) return;
      incomingCallHandledRef.current = incomingCall.id;
      // Already busy: ignore rather than clobber. This used to run
      // unconditionally, so a second call (or two people ringing each other
      // at once) tore down the in-progress call's signaling channel and left
      // both sides stuck with an offer that could never arrive.
      //
      // Checked against the CURRENT call's id, not phase alone — an earlier
      // version of this guard declined based on a phaseRef that lags one
      // React commit behind, so a call that had just ended could still read
      // as "active"/"incoming" for one tick. Declining on phase alone meant
      // a genuinely NEW incoming call landing in that exact window got
      // silently declined — including telling CallKit to end its own
      // report, which killed a call the user was actively answering: CallKit
      // shows connected, the app has already told the server (and CallKit)
      // the call is over. Same call id reaching here twice (the VoIP-push
      // cold-launch path and the Realtime "ringing" row both calling in) is
      // the actual duplicate case this guard exists for — that's a genuine
      // no-op, not something to decline.
      const busyState = call.state;
      const busyWithDifferentCall =
        busyState.phase !== "idle" && busyState.phase !== "ended" && busyState.call.id !== incomingCall.id;
      if (busyWithDifferentCall) {
        void supabase.from("calls").update({ status: "declined" }).eq("id", incomingCall.id);
        // The VoIP-push path already reported THIS call to CallKit natively,
        // before JS ran — declining it here in the DB alone leaves iOS still
        // showing the full-screen incoming-call UI for a call the app has
        // already closed out. Left alone, answering that phantom screen later
        // fires onCallKitAnswer for a dead uuid while the real call is
        // active, arming acceptFromCallKit against the WRONG call.
        endCallKitCall(incomingCall.id, "declined");
        return;
      }
      if (busyState.phase !== "idle" && busyState.phase !== "ended") {
        // Same call id already being handled — nothing to do.
        return;
      }
      // The CallOverlay now renders in a native Modal so it always shows
      // above the keyboard, but dismissing it too avoids a stray keyboard
      // fighting the ringing UI for focus/space.
      Keyboard.dismiss();
      // Unlike placeCall, an incoming call is NOT abandoned when the keypair
      // is slow — the caller is already ringing and refusing outright would
      // look like a dropped call. But the timeout must not pass silently:
      // without a keypair, useCall captures a decoder that drops every
      // encrypted signal for the whole call, so the ringing UI appears and
      // Accept then does nothing. Logged so this is diagnosable instead of
      // looking like a random failure, and the call still proceeds in case
      // the keys land before the offer does.
      if (!(await waitForE2ee())) {
        console.error(
          "[useCallManager] E2EE keys not ready after 5s — incoming call may be undecryptable",
          { callId: incomingCall.id }
        );
      }
      const info = await resolvePeer(incomingCall.conversation_id);
      setPeer(info);
      // Same ordering requirement as placeCall: the key must be in place
      // before we join the signaling channel, or the caller's encrypted
      // offer arrives and can't be decrypted — which looked exactly like
      // "Accept does nothing and the phone keeps ringing".
      call.setPeerPublicKey(info.publicKey);
      call.setPeerKyberPublicKey(info.kyberPublicKey);
      call.listenForOffer(incomingCall);
    },
    [call, resolvePeer, waitForE2ee]
  );

  // Kept fresh so the CallKit-answer effect below can call the CURRENT
  // handleIncoming without listing it as a dependency. It can't be a
  // dependency: its identity changes whenever resolvePeer's peer cache
  // mutates, and re-running that effect would re-read native keys that have
  // already been consumed. Capturing it once instead would freeze it at the
  // first render's resolvePeer — the same stale-closure shape that once
  // stopped incoming calls from being answerable at all.
  const handleIncomingRef = useRef(handleIncoming);
  handleIncomingRef.current = handleIncoming;

  useIncomingCalls(user?.id, handleIncoming);

  // Android's whole path to an incoming call, since there is no
  // ConnectionService/CallKit-equivalent integration here (deliberately out
  // of scope — see send-call-push's header comment). useIncomingCalls alone
  // only rings while this device's JS is ALREADY running and subscribed,
  // which is exactly the gap that made "calling Android, or Android calling
  // out" not work at all: an Android recipient whose app was backgrounded
  // or killed had a Realtime subscription that wasn't live yet, and the
  // push that reached them (send-call-push, routed through
  // notify_incoming_call) carried no way for the client to tell a call push
  // apart from a message push — so tapping it just opened the chat, with
  // nothing on screen that could ever answer.
  //
  // Two listeners cover the two ways a push reaches this device:
  //  - received: the app is alive (foreground or background, not killed) —
  //    fires the instant the push lands, same as a live Realtime row, so
  //    the ringer/CallOverlay comes up immediately rather than waiting for
  //    a tap that may never come if the caller hangs up first.
  //  - response (tap): covers both a backgrounded app and, critically, a
  //    COLD START — Notifications queues the response and this listener
  //    receives it the moment this effect mounts, same mechanism
  //    consumePendingIncomingCall uses for iOS's VoIP-push cold launch.
  //
  // iOS is deliberately excluded (Platform.OS check below): it already has
  // the strictly better VoIP-push + CallKit path above, which wakes the
  // process even when fully killed — something a plain Expo push cannot do
  // on either platform. Running this on iOS too would just mean a second,
  // redundant handleIncoming call for the same call id once a VoIP-token
  // build is in use (harmless — handleIncoming dedupes on call id — but
  // pointless, and it would be the ONLY path for an iOS build that somehow
  // has no VoIP token, which would mask that misconfiguration).
  useEffect(() => {
    if (Platform.OS !== "android") return;

    const handleCallPush = (data: unknown) => {
      if (!callsSupported()) return;
      if (typeof data !== "object" || data === null) return;
      const { kind, callId } = data as { kind?: unknown; callId?: unknown };
      if (kind !== "call" || typeof callId !== "string") return;

      void (async () => {
        const { data: callRow } = await supabase.from("calls").select("*").eq("id", callId).single();
        // The call may already have ended (caller hung up, or it was
        // answered/declined on another device) by the time this push is
        // processed — nothing to do.
        if (!callRow || callRow.status !== "ringing") return;
        await handleIncomingRef.current(callRow);
      })();
    };

    const receivedSubscription = Notifications.addNotificationReceivedListener((event) => {
      handleCallPush(event.request.content.data);
    });
    const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      handleCallPush(response.notification.request.content.data);
    });

    return () => {
      receivedSubscription.remove();
      responseSubscription.remove();
    };
  }, []);

  // accept/decline/hangup each branch on call.state.phase directly (not a
  // ref), so a copy of them captured once at mount would forever see phase
  // from that first render — the exact stale-closure shape that broke
  // incoming calls earlier (see useIncomingCalls). Read through a ref kept
  // fresh on every render instead, so the CallKit listeners (registered
  // below) always invoke the CURRENT call object's functions.
  const callRef = useRef(call);
  callRef.current = call;

  // If this launch was triggered by a VoIP push (CallKitAppDelegateSubscriber
  // already reported the call to CallKit before this component — or any JS —
  // existed), reconnect the JS call state machine to that already-showing
  // report. Without this, the system call screen would be up but Accept on
  // it would have nothing on the JS side to actually join the signaling
  // channel — the call would look answerable but never connect audio/video.
  // Checked on mount AND on every return to the foreground. Mount alone is
  // not enough: when the app is merely backgrounded (not terminated),
  // answering from the lock screen wakes it without remounting anything, so
  // a mount-only check never runs and the stored answer sits unread — the
  // app comes up showing its own Accept screen while iOS says the call is
  // connected. Native events can't be relied on here either: the JS listener
  // may not be subscribed at the instant CallKit fires.
  // Holds a uuid handed to checkForCallKitAnswer before user?.id existed yet
  // (see the guard inside it) so it can be replayed once auth lands, instead
  // of being dropped and silently re-derived a second time.
  const deferredAnsweredIdRef = useRef<string | null>(null);

  const checkForCallKitAnswer = useCallback(
    // knownAnsweredId lets the LIVE onCallKitAnswer handler pass the uuid it
    // already received as an event argument, instead of re-deriving it by
    // reading consumeAnsweredCall() from UserDefaults a second time. That
    // second read is the only mechanism for the COLD-launch path (there is
    // no live JS listener yet to hand the id to), but on the live path it
    // was a needless indirection through a store that a prior mount's own
    // call to this same function may have already drained — e.g. this
    // function also runs once on mount and on every AppState "active"
    // transition, any of which could have already consumed and cleared the
    // UserDefaults value before the live event fires. When that happened,
    // this function silently did nothing at all for a call CallKit had
    // already connected: the exact "CallKit shows Connected, app shows
    // Ringing forever" symptom.
    (knownAnsweredId?: string) => {
      if (!user?.id) {
        // A cold launch races auth against CallKit: onAnswerCall (subscribed
        // from the very first mount, before user?.id exists) can fire before
        // supabase.auth.getSession() resolves. Bailing here used to just
        // drop the uuid on the floor — the later re-run (once user?.id
        // lands) falls back to consumeAnsweredCall(), which usually still
        // has it, but by then answeredViaCallKitIdRef/markNextCallAsAnswered-
        // ViaCallKit had already been armed once by the discarded event and
        // get armed AGAIN by the retry, leaving one extra arm with only one
        // consumer. Stashing it here and replaying it once auth lands avoids
        // re-deriving it via a second, redundant native read.
        if (knownAnsweredId) deferredAnsweredIdRef.current = knownAnsweredId;
        return;
      }
      // A VoIP push stores pendingIncomingCall; answering from CallKit's UI
      // stores answeredCall. They arrive together on a cold launch, but a
      // phone that was merely LOCKED (app still alive, call delivered over
      // Realtime) produces only the second — and the previous version
      // bailed out before ever reading it, so answering from the lock
      // screen did nothing at all in exactly that case.
      const pending = consumePendingIncomingCall();
      const deferred = deferredAnsweredIdRef.current;
      deferredAnsweredIdRef.current = null;
      const answeredId = knownAnsweredId ?? deferred ?? consumeAnsweredCall();
      if (!pending && !answeredId) return;

    void (async () => {
      const callId = pending?.callId ?? answeredId;
      if (!callId) return;

      const { data: callRow } = await supabase
        .from("calls")
        .select("*")
        .eq("id", callId)
        .single();
      // The call may have ended (caller hung up) in the time it took this
      // device to cold-launch and reach this point — nothing to reconnect to.
      if (!callRow || callRow.status !== "ringing") return;

      // Only set up the call from scratch if it isn't already in progress —
      // when the app was alive the whole time, useIncomingCalls has already
      // done this and re-running it would tear down its signaling channel.
      const phase = callRef.current.state.phase;
      if (phase === "idle" || phase === "ended") {
        await handleIncomingRef.current(callRow);
      }

      if (answeredId === callId) {
        markNextCallAsAnsweredViaCallKit();
        // acceptFromCallKit, not accept(): accept() reads the phase from the
        // closure it was built in, which can still say "idle" here, so it
        // would hit its own guard and silently do nothing.
        callRef.current.acceptFromCallKit(callRow.kind);
      }
    })();
    },
    // Deliberately depends on user?.id alone: handleIncoming is reached
    // through handleIncomingRef (see above) precisely so this callback stays
    // stable and the AppState listener isn't torn down mid-call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.id]
  );

  // Reached from onCallKitAnswer below, which is declared (and therefore
  // needs a stable handle to this) before checkForCallKitAnswer would
  // otherwise be in scope.
  const checkForCallKitAnswerRef = useRef(checkForCallKitAnswer);
  checkForCallKitAnswerRef.current = checkForCallKitAnswer;

  useEffect(() => {
    checkForCallKitAnswer();

    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") checkForCallKitAnswer();
    });
    return () => subscription.remove();
  }, [checkForCallKitAnswer]);

  useEffect(() => {
    if (call.state.phase === "idle") {
      setPeer(null);
    }
  }, [call.state.phase]);

  // Reports this call's phase transitions to CallKit so an incoming call
  // shows iOS's native system call screen (over the lock screen, above
  // every other app, with the OS's own ringtone) instead of only the custom
  // React Native overlay, which is invisible unless Televo is frontmost.
  // Tracked by the CallRow's own id — stable for the life of one call and
  // already the thing every phase in CallState carries.
  const reportedCallIdRef = useRef<string | null>(null);
  // True once THIS device is the one that answered/ended the call from
  // CallKit's own UI — those actions already update call state via
  // call.accept()/call.hangup() below, so the "ended" effect must not call
  // endCallKitCall a second time and report a call CallKit already knows is
  // over.
  const endedViaCallKitRef = useRef(false);
  // The call id that was answered from CallKit's OWN UI. Stored as an id
  // rather than a boolean: the boolean was cleared by the "incoming" branch
  // below, and on the lock-screen path CallKit's answer arrives BEFORE
  // listenForOffer moves the phase to "incoming" — so the flag was wiped
  // between being set and being read, and the in-app answer was reported to
  // CallKit for a call CallKit had itself just answered. An id survives that
  // ordering because the branch only clears state for a DIFFERENT call.
  const answeredViaCallKitIdRef = useRef<string | null>(null);
  // Calls this side has already told CallKit were answered, so the report is
  // sent exactly once. Needed because the transition it keys off can be
  // observed more than once (the effect re-runs on any `call` identity
  // change) and, on the in-app path, may not be observed in the "connecting"
  // phase at all — answerCall sets "connecting" and "active" in the same
  // synchronous block, which React batches into a single render.
  const reportedAnsweredIdRef = useRef<string | null>(null);

  useEffect(() => {
    const { state } = call;

    if (state.phase === "idle") {
      reportedCallIdRef.current = null;
      endedViaCallKitRef.current = false;
      answeredViaCallKitIdRef.current = null;
      reportedAnsweredIdRef.current = null;
      return;
    }

    // "ended" carries no CallRow (just a reason) — the id to close out is
    // whatever this effect already reported, tracked in the ref itself.
    if (state.phase === "ended") {
      const callId = reportedCallIdRef.current;
      reportedCallIdRef.current = null;
      // Clears the dedup guard so a genuinely new incoming call — including
      // a new call that happens to reuse this same id is impossible, but a
      // NEXT call is not — is handled normally rather than silently
      // dropped by incomingCallHandledRef still pointing at the call that
      // just ended.
      incomingCallHandledRef.current = null;
      if (callId && !endedViaCallKitRef.current) {
        endCallKitCall(callId, state.reason);
      }
      return;
    }

    const callId = state.call.id;

    if (state.phase === "incoming" && reportedCallIdRef.current !== callId) {
      reportedCallIdRef.current = callId;
      endedViaCallKitRef.current = false;
      // Only reset the answer bookkeeping for a call this side has not
      // already been told about — see answeredViaCallKitIdRef.
      if (answeredViaCallKitIdRef.current !== callId) {
        answeredViaCallKitIdRef.current = null;
        reportedAnsweredIdRef.current = null;
      }
      // Do NOT re-report a call the user has already answered from CallKit.
      // On the lock-screen path the VoIP push reported this call to CallKit
      // before JS existed and the user answered it there; reaching this
      // branch afterwards (handleIncoming runs on the way to answering)
      // reported a SECOND incoming call for the same conversation, which is
      // the banner that stays on screen over the running call and breaks it
      // when tapped.
      if (answeredViaCallKitIdRef.current !== callId) {
        reportIncomingCall(callId, peer?.name ?? "Televo", state.call.kind === "video");
      }
    } else if (state.phase === "outgoing" && reportedCallIdRef.current !== callId) {
      reportedCallIdRef.current = callId;
      endedViaCallKitRef.current = false;
      reportOutgoingCallStarted(callId, peer?.name ?? "Televo");
    } else if (
      (state.phase === "connecting" || state.phase === "active") &&
      reportedCallIdRef.current === callId
    ) {
      // The user answered from inside the app. CallKit still believes the
      // call is ringing, so its banner stays on screen over a call that is
      // already running — and tapping that banner then fights the in-app
      // call.
      //
      // Keyed off "connecting OR active", not "connecting" alone: answerCall
      // sets both phases in one synchronous block, so React batches them and
      // the "connecting" render is frequently never committed — the report
      // then never fired at all, which is why the banner stayed up for
      // ordinary in-app answers. reportedAnsweredIdRef keeps it to one call.
      //
      // Skipped when the answer came from CallKit's own UI, which has
      // already moved CallKit's own state.
      if (
        answeredViaCallKitIdRef.current !== callId &&
        reportedAnsweredIdRef.current !== callId &&
        // Only an INCOMING call needs this; an outgoing one was never
        // reported to CallKit as ringing here, and asking CallKit to answer
        // it would be nonsense.
        state.call.caller_id !== user?.id
      ) {
        reportedAnsweredIdRef.current = callId;
        reportIncomingCallAnswered(callId);
      }
      if (state.phase === "active" && state.call.caller_id === user?.id) {
        // Only meaningful for the caller side — CXStartCallAction is what
        // needs connectedAt; an incoming call's report already started
        // "answered" the moment CallKit's own answer action fired.
        reportOutgoingCallConnected(callId);
      }
    }
  }, [call, peer?.name, user?.id]);

  // The system call screen's own Answer/Decline/hang-up controls fire these
  // instead of anything in the JS UI — route them into the same state
  // machine CallOverlay's buttons use, so a call answered from the lock
  // screen behaves identically to one answered by tapping in-app.
  useEffect(() => {
    const answerSub = onCallKitAnswer(({ uuid }) => {
      endedViaCallKitRef.current = false;
      // Recorded by id so the phase effect can tell "this exact call was
      // answered from CallKit" apart from "a new incoming call arrived",
      // even though the answer reaches us BEFORE the phase becomes
      // "incoming" on the lock-screen path.
      answeredViaCallKitIdRef.current = uuid;
      markNextCallAsAnsweredViaCallKit();
      const current = callRef.current;
      if (current.state.phase === "incoming") {
        void current.accept();
      } else if (current.state.phase !== "idle" && current.state.phase !== "ended") {
        // Answered from the lock screen while this side was still setting
        // the call up — accept() would bail on its phase guard, so arm the
        // deferred path instead. It answers as soon as the offer lands.
        current.acceptFromCallKit(current.state.call.kind);
      } else {
        // No call state at all yet: this is the cold-launch answer, and the
        // CallRow (with the real kind) has not been fetched. checkForCall-
        // KitAnswer does that — reads consumeAnsweredCall, fetches the row,
        // answers with the ACTUAL kind. Guessing "audio" here would be worse
        // than deferring: it would arm the accept path with video off, so an
        // answered video call opens only the microphone and the caller sees
        // a connected call with no picture, while the peer never gets a
        // video track at all.
        //
        // The comment here USED to say "checkForCallKitAnswer runs on the
        // same foregrounding" and left it at that — true only when this
        // event happens to coincide with an AppState transition to
        // "active". It answered from CallKit while the process was ALREADY
        // active (locked-but-alive, or simply mid-foreground) reaches this
        // branch with no pending AppState transition to trigger it, and the
        // call was then stuck showing "Ringing…" forever despite CallKit's
        // own screen reporting connected — call it explicitly instead of
        // hoping a side effect fires it.
        // Pass the uuid this event already carries — see checkForCall-
        // KitAnswer's own comment on knownAnsweredId for why re-deriving it
        // from consumeAnsweredCall() here is the actual bug this fixes.
        void checkForCallKitAnswerRef.current(uuid);
      }
    });
    const endSub = onCallKitEnd(({ uuid }) => {
      const current = callRef.current;
      const { state } = current;
      if (state.phase === "idle" || state.phase === "ended") return;
      // A stale/phantom CallKit report (see handleIncoming's busy-decline
      // path) can be dismissed by the user after this device has already
      // moved on to a DIFFERENT call. Without checking which call CallKit is
      // actually reporting, that dismissal tore down whatever call was
      // currently live and wrote "ended" against the wrong calls row.
      if (state.call.id !== uuid) return;
      endedViaCallKitRef.current = true;
      // declineFromCallKit, not decline(): decline() reads phase from the
      // closure it was created in, which can still say something other than
      // "incoming" in the same same-tick race acceptFromCallKit exists for —
      // silently doing nothing and leaving the caller ringing for the full
      // timeout. declineFromCallKit reads the call row from a ref set
      // synchronously in listenForOffer instead.
      if (state.phase === "incoming") void current.declineFromCallKit();
      else void current.hangup();
    });
    // The system call screen's own mute toggle. Without this subscription,
    // muting from CallKit's UI showed muted there while the mic kept
    // transmitting — the app's own `muted` state never moved and the WebRTC
    // track was never disabled.
    const muteSub = onCallKitMuteChanged(({ uuid, muted: nextMuted }) => {
      const { state } = callRef.current;
      if (state.phase === "idle" || state.phase === "ended") return;
      if (state.call.id !== uuid) return;
      callRef.current.setMuteState(nextMuted);
    });
    return () => {
      answerSub.remove();
      endSub.remove();
      muteSub.remove();
    };
  }, []);

  const [minimized, setMinimized] = useState(false);
  // Reset on "ended" too, not just "idle" — the auto-reset from "ended" to
  // "idle" runs on a 1.5s timer (see CallOverlay's onDismissEnded effect),
  // and if the call was minimized when it ended, `minimized` stayed true for
  // that whole window: TouchPassthrough kept passthroughEnabled on, and the
  // ended-call Modal content kept rendering shrunk/transparent instead of
  // full-screen. Real device log (2026-10-03, rootkali) showed exactly this —
  // the call ended, then touches stopped reaching anything for ~1.5s+, with
  // CallOverlay's own render tree still thinking it was minimized for a
  // phase it was never designed to be minimized through.
  useEffect(() => {
    if (call.state.phase === "idle" || call.state.phase === "ended") setMinimized(false);
  }, [call.state.phase]);

  return (
    <CallManagerContext.Provider value={{ ...call, peer, placeCall, minimized, setMinimized }}>
      {children}
    </CallManagerContext.Provider>
  );
}

export function useCallManager() {
  const context = useContext(CallManagerContext);
  if (!context) {
    throw new Error("useCallManager must be used within a CallManagerProvider");
  }
  return context;
}
