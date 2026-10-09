import "react-native-url-polyfill/auto";

import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";

import type { Database } from "../types/database";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    "Missing Supabase configuration. Copy .env.example to .env and set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY."
  );
}

/**
 * The session token lives in the OS keystore (Keychain / Android Keystore),
 * not AsyncStorage. AsyncStorage is plaintext on disk, so anyone with
 * filesystem or backup access to the device could lift the token and take
 * over the account outright — the passcode lock only hid the UI, it never
 * protected this.
 *
 * SecureStore caps a value at ~2KB, and a Supabase session (JWT + refresh
 * token + user object) can exceed that, so values are split across numbered
 * chunks and reassembled on read.
 */
const CHUNK_SIZE = 1536;

const secureStorage = {
  getItem: async (key: string) => {
    const head = await SecureStore.getItemAsync(`${key}.0`);
    if (head === null) return null;

    let value = head;
    for (let index = 1; ; index += 1) {
      const chunk = await SecureStore.getItemAsync(`${key}.${index}`);
      if (chunk === null) break;
      value += chunk;
    }
    return value;
  },
  setItem: async (key: string, value: string) => {
    // Clear any longer previous value first, or stale chunks would be
    // appended to the new one on read.
    await secureStorage.removeItem(key);
    for (let index = 0; index * CHUNK_SIZE < value.length; index += 1) {
      await SecureStore.setItemAsync(
        `${key}.${index}`,
        value.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
      );
    }
  },
  removeItem: async (key: string) => {
    for (let index = 0; ; index += 1) {
      const chunkKey = `${key}.${index}`;
      const chunk = await SecureStore.getItemAsync(chunkKey);
      if (chunk === null) break;
      await SecureStore.deleteItemAsync(chunkKey);
    }
  },
};

export const supabase = createClient<Database>(supabaseUrl, supabasePublishableKey, {
  auth: {
    storage: secureStorage,
    autoRefreshToken: true,
    persistSession: true,
    // No URL-based session detection on native.
    detectSessionInUrl: false,
  },
});

// Refresh the session only while the app is in the foreground, so we don't
// burn network calls (or hit the refresh endpoint) while backgrounded.
AppState.addEventListener("change", (state) => {
  if (state === "active") {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});

// Realtime enforces RLS over its own socket, which does NOT inherit the REST
// client's session. Without this, postgres_changes subscriptions silently
// deliver nothing. Re-apply on every token change so the socket stays valid.
supabase.auth.onAuthStateChange((_event, session) => {
  supabase.realtime.setAuth(session?.access_token ?? null);
});

/** Pulls the `session_id` claim out of a Supabase access token (a standard
 * JWT) without a full JWT library — this is the one field the Devices
 * screen needs to link a push_tokens/voip_push_tokens row back to a
 * specific auth.sessions row (see scripts/sql/055_device_sessions.sql).
 * `atob` is available in Hermes; base64url (`-`/`_` instead of `+`/`/`, no
 * padding) needs converting to standard base64 first or atob rejects it. */
export function decodeSessionIdFromAccessToken(accessToken: string): string | null {
  try {
    const payloadSegment = accessToken.split(".")[1];
    if (!payloadSegment) return null;
    const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.session_id === "string" ? payload.session_id : null;
  } catch {
    return null;
  }
}
