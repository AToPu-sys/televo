import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAuth } from "../src/hooks/useAuth";
import { useTheme } from "../src/hooks/useTheme";
import { supabase } from "../src/lib/supabase";
import { radius, spacing } from "../src/theme";

export default function PrivacyLastSeenScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [showLastSeen, setShowLastSeen] = useState(true);
  const [showReadReceipts, setShowReadReceipts] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    supabase
      .from("profiles")
      .select("show_last_seen, show_read_receipts")
      .eq("id", user.id)
      .single()
      .then(({ data }) => {
        if (data) {
          setShowLastSeen(data.show_last_seen);
          setShowReadReceipts(data.show_read_receipts);
        }
        setLoading(false);
      });
  }, [user?.id]);

  async function handleToggleLastSeen(next: boolean) {
    setShowLastSeen(next);
    if (!user?.id) return;
    await supabase.from("profiles").update({ show_last_seen: next }).eq("id", user.id);
  }

  async function handleToggleReadReceipts(next: boolean) {
    setShowReadReceipts(next);
    if (!user?.id) return;
    await supabase.from("profiles").update({ show_read_receipts: next }).eq("id", user.id);
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
        >
          <Ionicons name="chevron-back" size={26} color={theme.accent} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Last Seen & Online</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <ActivityIndicator color={theme.accent} style={styles.loader} />
      ) : (
        <View style={styles.content}>
          <View style={[styles.section, { backgroundColor: theme.surfaceElevated }]}>
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={[styles.rowLabel, { color: theme.text }]}>Show my Last Seen</Text>
                <Text style={[styles.rowHint, { color: theme.textSecondary }]}>
                  If off, you also won't see other people's Last Seen.
                </Text>
              </View>
              <Switch
                value={showLastSeen}
                onValueChange={handleToggleLastSeen}
                trackColor={{ true: theme.accent, false: theme.border }}
                accessibilityLabel="Show my Last Seen"
              />
            </View>
          </View>

          <View style={[styles.section, { backgroundColor: theme.surfaceElevated }]}>
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={[styles.rowLabel, { color: theme.text }]}>Send Read Receipts</Text>
                <Text style={[styles.rowHint, { color: theme.textSecondary }]}>
                  Let people see when you've read their messages.
                </Text>
              </View>
              <Switch
                value={showReadReceipts}
                onValueChange={handleToggleReadReceipts}
                trackColor={{ true: theme.accent, false: theme.border }}
                accessibilityLabel="Send Read Receipts"
              />
            </View>
          </View>
        </View>
      )}
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
  loader: { marginTop: spacing.xxl },
  content: { padding: spacing.lg, gap: spacing.lg },
  section: { borderRadius: radius.md, paddingHorizontal: spacing.lg },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing.md },
  rowText: { flex: 1, gap: 2, marginRight: spacing.md },
  rowLabel: { fontSize: 16 },
  rowHint: { fontSize: 12, lineHeight: 16 },
});
