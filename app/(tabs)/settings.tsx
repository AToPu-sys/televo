import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "../../src/components/Avatar";
import { Button } from "../../src/components/Button";
import { useAuth } from "../../src/hooks/useAuth";
import { useTheme } from "../../src/hooks/useTheme";
import { supabase } from "../../src/lib/supabase";
import { radius, spacing } from "../../src/theme";

type Profile = {
  display_name: string;
  username: string;
  bio: string | null;
  avatar_url: string | null;
};

export default function SettingsScreen() {
  const { theme, preference, setPreference } = useTheme();
  const { user, signOut } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;

    supabase
      .from("profiles")
      .select("display_name, username, bio, avatar_url")
      .eq("id", user.id)
      .single()
      .then(({ data }) => {
        if (active && data) {
          setProfile({
            display_name: data.display_name,
            username: String(data.username),
            bio: data.bio,
            avatar_url: data.avatar_url,
          });
        }
      });

    return () => {
      active = false;
    };
  }, [user?.id]);

  function handleSignOut() {
    Alert.alert("Sign out", "You'll need to sign in again to read your messages.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          void signOut();
        },
      },
    ]);
  }

  const isDark = theme.name === "dark";

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={["top"]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.profileCard, { backgroundColor: theme.surfaceElevated }]}>
          <Avatar
            name={profile?.display_name ?? "You"}
            uri={profile?.avatar_url}
            size={72}
            online
          />
          <View style={styles.profileText}>
            <Text style={[styles.profileName, { color: theme.text }]} numberOfLines={1}>
              {profile?.display_name ?? "Loading…"}
            </Text>
            {profile?.username ? (
              <Text style={[styles.profileHandle, { color: theme.textSecondary }]}>
                @{profile.username}
              </Text>
            ) : null}
            <Text style={[styles.profileEmail, { color: theme.textSecondary }]} numberOfLines={1}>
              {user?.email ?? user?.phone ?? ""}
            </Text>
          </View>
        </View>

        {profile?.bio ? (
          <View style={[styles.section, { backgroundColor: theme.surfaceElevated }]}>
            <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>Bio</Text>
            <Text style={[styles.sectionValue, { color: theme.text }]}>{profile.bio}</Text>
          </View>
        ) : null}

        <View style={[styles.section, { backgroundColor: theme.surfaceElevated }]}>
          <View style={styles.settingRow}>
            <View style={styles.settingLabel}>
              <Ionicons name="moon" size={20} color={theme.accent} />
              <Text style={[styles.settingText, { color: theme.text }]}>Dark mode</Text>
            </View>
            <Switch
              value={isDark}
              onValueChange={(next) => setPreference(next ? "dark" : "light")}
              trackColor={{ true: theme.accent, false: theme.border }}
              accessibilityLabel="Dark mode"
            />
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <Pressable
            onPress={() => setPreference("system")}
            accessibilityRole="button"
            accessibilityLabel="Match system theme"
            style={styles.settingRow}
          >
            <View style={styles.settingLabel}>
              <Ionicons name="phone-portrait-outline" size={20} color={theme.accent} />
              <Text style={[styles.settingText, { color: theme.text }]}>Match system</Text>
            </View>
            {preference === "system" ? (
              <Ionicons name="checkmark" size={20} color={theme.accent} />
            ) : null}
          </Pressable>
        </View>

        <Button title="Sign out" variant="secondary" onPress={handleSignOut} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 24, fontWeight: "700" },
  content: { padding: spacing.lg, gap: spacing.lg },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.md,
  },
  profileText: { flex: 1, gap: 2 },
  profileName: { fontSize: 20, fontWeight: "700" },
  profileHandle: { fontSize: 14 },
  profileEmail: { fontSize: 13 },
  section: { borderRadius: radius.md, paddingHorizontal: spacing.lg },
  sectionLabel: { fontSize: 12, fontWeight: "600", paddingTop: spacing.md },
  sectionValue: { fontSize: 15, paddingBottom: spacing.md, paddingTop: spacing.xs },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
    minHeight: 52,
  },
  settingLabel: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  settingText: { fontSize: 16 },
  divider: { height: StyleSheet.hairlineWidth },
});
