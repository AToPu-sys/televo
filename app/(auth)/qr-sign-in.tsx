import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../../src/hooks/useTheme";
import { supabase } from "../../src/lib/supabase";
import { spacing } from "../../src/theme";

type Phase = "loading" | "waiting" | "scanned" | "signing-in" | "denied" | "expired" | "error";

/**
 * QR sign-in for a device with NO session yet — shown from Welcome. This
 * device generates a short-lived request row (create_qr_login_request,
 * anon-callable), shows it as a QR code, and waits on two channels for the
 * OTHER (already signed-in) device to act:
 *   - postgres_changes on qr_login_requests, for status transitions
 *     (scanned/denied/expired) — lets this screen react instantly to a scan
 *     even before the confirm step, e.g. to show "Scanned — confirm on your
 *     other device".
 *   - a Realtime BROADCAST on `qr-login:<id>`, for the actual session
 *     tokens once qr-login-exchange (Edge Function) issues them. Tokens are
 *     never written to a table (see scripts/sql/057_qr_login.sql) — this is
 *     the only place they ever arrive.
 *
 * Two-Step Verification is NOT bypassed by this flow: setSession() below
 * fires the same onAuthStateChange → checkMfaLevel() path a password
 * sign-in does (see useAuth.tsx), so an account with TOTP enabled hits the
 * same MFA challenge screen next, same as always.
 */
export default function QrSignInScreen() {
  const { theme } = useTheme();
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("loading");
  const [requestId, setRequestId] = useState<string | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const start = useCallback(async () => {
    setPhase("loading");
    const { data, error } = await supabase.rpc("create_qr_login_request");
    if (error || !data) {
      setPhase("error");
      return;
    }
    setRequestId(data);
    setPhase("waiting");
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    if (!requestId) return;

    const channel = supabase
      .channel(`qr-login:${requestId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "qr_login_requests", filter: `id=eq.${requestId}` },
        (payload) => {
          const status = (payload.new as { status: string }).status;
          if (status === "scanned") setPhase("scanned");
          else if (status === "denied") setPhase("denied");
        }
      )
      .on("broadcast", { event: "session" }, async ({ payload }) => {
        setPhase("signing-in");
        const { error } = await supabase.auth.setSession({
          access_token: payload.access_token,
          refresh_token: payload.refresh_token,
        });
        if (error) {
          setPhase("error");
          return;
        }
        // No explicit navigation here — RootNavigator's own effect
        // (app/_layout.tsx) sees the new session via onAuthStateChange and
        // routes to /(tabs)/chats or the MFA gate on its own, same as it
        // already does for every other sign-in path.
      })
      .subscribe();

    channelRef.current = channel;

    // TTL matches create_qr_login_request's 2-minute expiry — if nothing
    // happened by then, the request is dead server-side anyway (see
    // scripts/sql/057_qr_login.sql), so stop waiting and let the user
    // generate a fresh QR rather than watch a channel for an already-expired row.
    const timer = setTimeout(() => setPhase("expired"), 2 * 60 * 1000);

    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [requestId]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={theme.accent} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Log in with QR Code</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.content}>
        {phase === "loading" ? (
          <ActivityIndicator color={theme.accent} size="large" />
        ) : phase === "waiting" && requestId ? (
          <>
            <View style={[styles.qrWrapper, { backgroundColor: "#FFFFFF" }]}>
              <QRCode value={`televo://qr-login/${requestId}`} size={220} />
            </View>
            <Text style={[styles.instructions, { color: theme.text }]}>
              Open Televo on your other phone, go to Settings → Devices → Connect Device, and scan
              this code.
            </Text>
          </>
        ) : phase === "scanned" ? (
          <>
            <ActivityIndicator color={theme.accent} size="large" />
            <Text style={[styles.instructions, { color: theme.text }]}>
              Scanned — confirm on your other device.
            </Text>
          </>
        ) : phase === "signing-in" ? (
          <>
            <ActivityIndicator color={theme.accent} size="large" />
            <Text style={[styles.instructions, { color: theme.text }]}>Signing in…</Text>
          </>
        ) : phase === "denied" ? (
          <>
            <Ionicons name="close-circle-outline" size={48} color={theme.danger} />
            <Text style={[styles.instructions, { color: theme.text }]}>
              Sign-in was denied on the other device.
            </Text>
            <Pressable onPress={() => void start()} accessibilityRole="button">
              <Text style={[styles.retryText, { color: theme.accent }]}>Try again</Text>
            </Pressable>
          </>
        ) : phase === "expired" ? (
          <>
            <Ionicons name="time-outline" size={48} color={theme.textSecondary} />
            <Text style={[styles.instructions, { color: theme.text }]}>This code expired.</Text>
            <Pressable onPress={() => void start()} accessibilityRole="button">
              <Text style={[styles.retryText, { color: theme.accent }]}>Generate a new code</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Ionicons name="warning-outline" size={48} color={theme.danger} />
            <Text style={[styles.instructions, { color: theme.text }]}>
              Something went wrong. Please try again.
            </Text>
            <Pressable onPress={() => void start()} accessibilityRole="button">
              <Text style={[styles.retryText, { color: theme.accent }]}>Try again</Text>
            </Pressable>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  headerSpacer: { width: 26 },
  content: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg, padding: spacing.xl },
  qrWrapper: { padding: spacing.lg, borderRadius: 16 },
  instructions: { fontSize: 15, textAlign: "center", lineHeight: 21 },
  retryText: { fontSize: 15, fontWeight: "600" },
});
