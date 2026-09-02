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
  decryptMessage,
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
  startEncryptedChat: (conversationId: string, otherUserId: string) => Promise<void>;
  /** Encrypts a plaintext body for a conversation; throws if no session key
   * is available yet (the other side hasn't set one up, or it's still loading). */
  encryptForConversation: (conversationId: string, plaintext: string) => Promise<string>;
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

  const startEncryptedChat = useCallback(
    async (conversationId: string, otherUserId: string) => {
      if (!userId || !keyPair) throw new Error("Encryption isn't ready yet.");

      const { data: otherProfile, error: profileError } = await supabase
        .from("profiles")
        .select("e2e_public_key")
        .eq("id", otherUserId)
        .single();
      if (profileError) throw profileError;
      if (!otherProfile?.e2e_public_key) {
        throw new Error("The other person hasn't opened the app on this version yet.");
      }

      const sessionKey = generateSessionKey();

      // Wrap one copy for the other participant, and one for this device —
      // so this device can also decrypt its own sent messages later.
      const wrappedForOther = wrapSessionKey(sessionKey, otherProfile.e2e_public_key, keyPair.secretKey);
      const wrappedForSelf = wrapSessionKey(sessionKey, keyPair.publicKey, keyPair.secretKey);

      const { error: markError } = await supabase
        .from("conversations")
        .update({ is_encrypted: true })
        .eq("id", conversationId);
      if (markError) throw markError;

      const { error: keysError } = await supabase.from("encrypted_session_keys").insert([
        {
          conversation_id: conversationId,
          recipient_id: otherUserId,
          sender_public_key: keyPair.publicKey,
          encrypted_key: wrappedForOther.encryptedKey,
          nonce: wrappedForOther.nonce,
        },
        {
          conversation_id: conversationId,
          recipient_id: userId,
          sender_public_key: keyPair.publicKey,
          encrypted_key: wrappedForSelf.encryptedKey,
          nonce: wrappedForSelf.nonce,
        },
      ]);
      if (keysError) throw keysError;

      sessionKeys.current.set(conversationId, sessionKey);
    },
    [userId, keyPair]
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
