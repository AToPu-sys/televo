import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  decryptBytes,
  decryptMessage,
  encryptBytes,
  encryptMessage,
  generateSessionKey,
  getOrCreateDeviceKeyPair,
  parseEnvelope,
  serializeEnvelope,
  unwrapSessionKey,
  wrapSessionKey,
  type KeyPair,
} from "../lib/e2e";
import { supabase } from "../lib/supabase";

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

  useEffect(() => {
    if (!userId) return;
    let active = true;

    (async () => {
      const pair = await getOrCreateDeviceKeyPair();
      if (!active) return;
      setKeyPair(pair);

      // Publish the public key if this profile doesn't have one yet (or it
      // changed — e.g. a reinstall generated a new device keypair).
      const { data: profile } = await supabase
        .from("profiles")
        .select("e2e_public_key")
        .eq("id", userId)
        .single();

      if (profile && profile.e2e_public_key !== pair.publicKey) {
        await supabase.from("profiles").update({ e2e_public_key: pair.publicKey }).eq("id", userId);
      }

      setReady(true);
    })();

    return () => {
      active = false;
    };
  }, [userId]);

  const loadSessionKey = useCallback(
    async (conversationId: string): Promise<Uint8Array | null> => {
      const cached = sessionKeys.current.get(conversationId);
      if (cached) return cached;
      if (!userId || !keyPair) return null;

      const { data } = await supabase
        .from("encrypted_session_keys")
        .select("encrypted_key, nonce, sender_public_key")
        .eq("conversation_id", conversationId)
        .eq("recipient_id", userId)
        .maybeSingle();

      if (!data) return null;

      const unwrapped = unwrapSessionKey(
        data.encrypted_key,
        data.nonce,
        data.sender_public_key,
        keyPair.secretKey
      );
      if (!unwrapped) return null;

      sessionKeys.current.set(conversationId, unwrapped);
      return unwrapped;
    },
    [userId, keyPair]
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
        .select("id, display_name, e2e_public_key")
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

      const { error: markError } = await supabase
        .from("conversations")
        .update({ is_encrypted: true })
        .eq("id", conversationId);
      if (markError) throw markError;

      const { error: keysError } = await supabase.from("encrypted_session_keys").insert(
        (profiles ?? []).map((profile) => {
          const wrapped = wrapSessionKey(sessionKey, profile.e2e_public_key!, keyPair.secretKey);
          return {
            conversation_id: conversationId,
            recipient_id: profile.id,
            sender_public_key: keyPair.publicKey,
            encrypted_key: wrapped.encryptedKey,
            nonce: wrapped.nonce,
          };
        })
      );
      if (keysError) throw keysError;

      sessionKeys.current.set(conversationId, sessionKey);
    },
    [userId, keyPair]
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
        throw new Error("No encryption key available for this chat yet.");
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

  return (
    <E2eeContext.Provider
      value={{
        ready,
        publicKey: keyPair?.publicKey ?? null,
        startEncryptedChat,
        encryptForConversation,
        encryptBytesForConversation,
        decryptBytesForConversation,
        decryptForConversation,
      }}
    >
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
