import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "../src/components/Button";
import { useAuth } from "../src/hooks/useAuth";
import { useE2ee } from "../src/hooks/useE2ee";
import { useTheme } from "../src/hooks/useTheme";
import { computeSafetyNumber, setPeerKeyVerified } from "../src/lib/e2e";
import { supabase } from "../src/lib/supabase";
import { radius, spacing } from "../src/theme";

/**
 * Safety-number verification, the defence against a man-in-the-middle.
 *
 * The client has to trust whatever public key the server returns for the
 * other person. If that key were swapped, messages would be encrypted to an
 * attacker instead — and nothing in the app would look wrong. Comparing
 * these digits out of band (read them aloud, or send them over another
 * channel) is what actually rules that out.
 */
export default function VerifySafetyNumberScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { publicKey, confirmPeerKeyChange } = useE2ee();
  const { peerId, peerName, conversationId } = useLocalSearchParams<{
    peerId: string;
    peerName: string;
    conversationId?: string;
  }>();

  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peerPublicKey, setPeerPublicKey] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!publicKey || !peerId) return;
    let active = true;

    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("e2e_public_key")
        .eq("id", peerId)
        .single();

      if (!active) return;

      if (!data?.e2e_public_key) {
        setError("This person hasn't set up encryption on their device yet.");
        return;
      }

      setPeerPublicKey(data.e2e_public_key);
      setSafetyNumber(await computeSafetyNumber(publicKey, data.e2e_public_key));
    })();

    return () => {
      active = false;
    };
  }, [publicKey, peerId]);

  async function handleConfirmMatch() {
    if (!conversationId || !peerPublicKey) return;
    await setPeerKeyVerified(conversationId, peerPublicKey);
    // This is the ONE place a changed key may be re-trusted — the user just
    // compared the safety number out of band and confirmed it matches, the
    // actual check that rules out a man-in-the-middle. See
    // confirmPeerKeyChange's comment for why the banner's bare "X" dismiss
    // must never do this instead.
    await confirmPeerKeyChange(conversationId);
    setConfirmed(true);
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={theme.accent} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Verify encryption</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Ionicons name="shield-checkmark-outline" size={48} color={theme.accent} />

        {error ? (
          <Text style={[styles.body, { color: theme.danger }]}>{error}</Text>
        ) : !safetyNumber ? (
          <ActivityIndicator color={theme.accent} style={styles.loader} />
        ) : (
          <>
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              Compare these numbers with {peerName ?? "the other person"} — in person, or over a
              call. If they match on both phones, nobody is intercepting your messages.
            </Text>

            <View style={[styles.numberBox, { backgroundColor: theme.surfaceElevated }]}>
              <Text style={[styles.number, { color: theme.text }]} selectable>
                {safetyNumber}
              </Text>
            </View>

            <Text style={[styles.footnote, { color: theme.textSecondary }]}>
              If the numbers are different, your conversation may be being intercepted — stop
              sending anything sensitive. Numbers also change if either of you reinstalls the app
              or switches device, which is normal.
            </Text>

            {conversationId ? (
              confirmed ? (
                <View style={styles.confirmedRow}>
                  <Ionicons name="checkmark-circle" size={20} color={theme.online} />
                  <Text style={[styles.confirmedText, { color: theme.online }]}>
                    Marked as maximally secure
                  </Text>
                </View>
              ) : (
                <Button title="Numbers match" onPress={handleConfirmMatch} />
              )
            ) : null}
          </>
        )}
      </ScrollView>
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
  content: { padding: spacing.xl, alignItems: "center", gap: spacing.lg },
  loader: { marginTop: spacing.xl },
  body: { fontSize: 15, textAlign: "center", lineHeight: 21 },
  numberBox: { padding: spacing.lg, borderRadius: radius.md, width: "100%" },
  number: { fontSize: 20, letterSpacing: 2, textAlign: "center", lineHeight: 32, fontVariant: ["tabular-nums"] },
  footnote: { fontSize: 13, textAlign: "center", lineHeight: 18 },
  confirmedRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  confirmedText: { fontSize: 14, fontWeight: "600" },
});
