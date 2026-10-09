import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAuth } from "../src/hooks/useAuth";
import { useTheme } from "../src/hooks/useTheme";
import { decodeSessionIdFromAccessToken, supabase } from "../src/lib/supabase";
import { spacing } from "../src/theme";

type DeviceRow = {
  session_id: string;
  device_name: string | null;
  device_model: string | null;
  is_active: boolean;
  last_active_at: string | null;
  created_at: string | null;
  city: string | null;
  country: string | null;
};

/** Formats "2h ago" / "3d ago" style relative time — matches how last-seen
 * timestamps read elsewhere in the app, so this doesn't introduce a second
 * date-formatting convention. */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Lists every device signed in on this account, backed by list_my_devices()
 * (scripts/sql/055_device_sessions.sql), which joins push_tokens/
 * voip_push_tokens to auth.sessions by session_id. "Active" means the
 * auth.sessions row is still present — a session that has been signed out
 * (here or via token expiry) has no row, so is_active reads false and its
 * last_active_at falls back to whenever its push token last registered.
 *
 * Ending a session actually signs that device out: revoke_device_session
 * (SECURITY DEFINER, runs as table owner) deletes the auth.sessions row
 * directly, which invalidates that session's refresh token — the other
 * device's next refresh attempt fails and its own onAuthStateChange fires
 * SIGNED_OUT, landing it back on the sign-in screen. This is different from
 * the OLD behavior here, which only deleted the push_tokens row (stopped
 * notifications, left the device signed in).
 */
export default function DevicesScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { user, session } = useAuth();

  const currentSessionId = useMemo(
    () => (session ? decodeSessionIdFromAccessToken(session.access_token) : null),
    [session]
  );

  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user?.id) return;
    const { data } = await supabase.rpc("list_my_devices");
    setDevices(data ?? []);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleEndSession(sessionId: string, name: string, isActive: boolean) {
    Alert.alert(
      isActive ? `End session on ${name}?` : `Remove ${name}?`,
      isActive
        ? "That device will be signed out immediately and returned to the sign-in screen."
        : "This device is already signed out — this just removes it from the list.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: isActive ? "End Session" : "Remove",
          style: "destructive",
          onPress: async () => {
            const previous = devices;
            setDevices((current) => current.filter((d) => d.session_id !== sessionId));
            // Already-inactive sessions have no auth.sessions row left for
            // revoke_device_session's ownership check to find — forget_device
            // just drops the stale push_tokens/voip_push_tokens rows instead.
            const { error } = isActive
              ? await supabase.rpc("revoke_device_session", { p_session_id: sessionId })
              : await supabase.rpc("forget_device", { p_session_id: sessionId });
            if (error) {
              setDevices(previous);
              Alert.alert(isActive ? "Couldn't end session" : "Couldn't remove device", error.message);
            }
          },
        },
      ]
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={theme.accent} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Devices</Text>
        <View style={styles.headerSpacer} />
      </View>

      <Pressable
        onPress={() => router.push("/scan-qr-login")}
        accessibilityRole="button"
        accessibilityLabel="Connect a new device"
        style={[styles.connectButton, { backgroundColor: theme.accent }]}
      >
        <Ionicons name="qr-code-outline" size={20} color="#FFFFFF" />
        <Text style={styles.connectButtonText}>Connect Device</Text>
      </Pressable>

      <Text style={[styles.hint, { color: theme.textSecondary }]}>
        Every device signed in on this account. Ending a session signs that device out
        immediately.
      </Text>

      {loading ? (
        <ActivityIndicator color={theme.accent} style={styles.loader} />
      ) : (
        <FlatList
          data={devices}
          keyExtractor={(item) => item.session_id}
          ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: theme.border }]} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="phone-portrait-outline" size={48} color={theme.textSecondary} />
              <Text style={[styles.emptyText, { color: theme.textSecondary }]}>No devices registered.</Text>
            </View>
          }
          contentContainerStyle={devices.length === 0 ? styles.flex : undefined}
          renderItem={({ item }) => {
            const isThisDevice = item.session_id === currentSessionId;
            const title = item.device_model ?? item.device_name ?? "Unknown device";
            const subtitle = item.device_model && item.device_name ? item.device_name : null;
            return (
              <View style={styles.row}>
                <Ionicons name="phone-portrait-outline" size={28} color={theme.accent} />
                <View style={styles.rowBody}>
                  <View style={styles.rowTitleLine}>
                    <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                      {title}
                    </Text>
                    {isThisDevice ? (
                      <View style={[styles.thisDeviceBadge, { backgroundColor: theme.accent }]}>
                        <Text style={styles.thisDeviceBadgeText}>This device</Text>
                      </View>
                    ) : item.is_active ? (
                      <View style={[styles.activeBadge, { backgroundColor: theme.online }]}>
                        <Text style={styles.activeBadgeText}>Active</Text>
                      </View>
                    ) : null}
                  </View>
                  {subtitle ? (
                    <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]} numberOfLines={1}>
                      {subtitle}
                    </Text>
                  ) : null}
                  <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]}>
                    {item.is_active
                      ? item.last_active_at
                        ? `Active ${relativeTime(item.last_active_at)}`
                        : "Active now"
                      : item.last_active_at
                        ? `Signed out — last active ${relativeTime(item.last_active_at)}`
                        : "Signed out"}
                  </Text>
                  {item.city || item.country ? (
                    <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]} numberOfLines={1}>
                      {[item.city, item.country].filter(Boolean).join(", ")}
                    </Text>
                  ) : null}
                </View>
                {!isThisDevice ? (
                  <Pressable
                    onPress={() => handleEndSession(item.session_id, title, item.is_active)}
                    accessibilityRole="button"
                    accessibilityLabel={`End session on ${title}`}
                  >
                    <Text style={[styles.removeText, { color: theme.danger }]}>
                      {item.is_active ? "End Session" : "Remove"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  connectButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: 12,
  },
  connectButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  headerSpacer: { width: 26 },
  hint: { fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  loader: { marginTop: spacing.xxl },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm },
  emptyText: { fontSize: 14 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowSubtitle: { fontSize: 13 },
  removeText: { fontSize: 14, fontWeight: "600" },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 60 },
  thisDeviceBadge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  thisDeviceBadgeText: { fontSize: 11, fontWeight: "700", color: "#FFFFFF" },
  activeBadge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  activeBadgeText: { fontSize: 11, fontWeight: "700", color: "#FFFFFF" },
});
