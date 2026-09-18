import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "../../src/components/Avatar";
import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { useAuth } from "../../src/hooks/useAuth";
import { useTheme } from "../../src/hooks/useTheme";
import { PRIVACY_URL, SUPPORT_URL, TERMS_URL } from "../../src/lib/legal";
import { normalizePhone } from "../../src/lib/phone";
import { supabase } from "../../src/lib/supabase";
import { radius, spacing } from "../../src/theme";

type Profile = {
  display_name: string;
  username: string;
  bio: string | null;
  avatar_url: string | null;
  phone: string | null;
};

export default function SettingsScreen() {
  const { theme, preference, setPreference } = useTheme();
  const { user, signOut } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [savingPhone, setSavingPhone] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;

    // `phone` is not directly selectable — the column-level grant was
    // removed so nobody can enumerate other users' numbers (see
    // scripts/sql/013). Your own number comes from a scoped RPC instead.
    (async () => {
      const [{ data }, { data: ownPhone }] = await Promise.all([
        supabase
          .from("profiles")
          .select("display_name, username, bio, avatar_url")
          .eq("id", user.id)
          .single(),
        supabase.rpc("get_my_phone"),
      ]);

      if (!active || !data) return;

      setProfile({
        display_name: data.display_name,
        username: String(data.username),
        bio: data.bio,
        avatar_url: data.avatar_url,
        phone: ownPhone ?? null,
      });
      // Only seed the draft if the user hasn't started typing — otherwise a
      // slow profile fetch overwrites what they've already entered.
      setPhoneDraft((current) => (current === "" ? (ownPhone ?? "") : current));
    })();

    return () => {
      active = false;
    };
  }, [user?.id]);

  async function handleSavePhone() {
    if (!user?.id) return;
    setPhoneError(null);

    // Normalised, not just trimmed, and with the same helper signup uses.
    // Storing "+998 90 123-45-67" here and "+998901234567" at signup makes
    // them two different strings: the unique index on profiles.phone would
    // let the same number exist twice, and contact discovery — which hashes
    // the normalised form — would only ever match one of them.
    const trimmed = phoneDraft.trim() ? normalizePhone(phoneDraft) : "";
    if (trimmed && !/^\+[1-9]\d{6,14}$/.test(trimmed)) {
      setPhoneError("Use international format, e.g. +14155552671.");
      return;
    }

    setSavingPhone(true);
    try {
      // Omitting new_phone (undefined) hits the function's `default null`,
      // which is how the number gets cleared.
      const { error } = await supabase.rpc("set_my_phone", {
        new_phone: trimmed || undefined,
      });
      if (error) throw error;
      setProfile((current) => (current ? { ...current, phone: trimmed || null } : current));
    } catch (caught) {
      setPhoneError(
        caught instanceof Error && caught.message.includes("duplicate")
          ? "That number is already linked to another account."
          : "Couldn't save your number. Try again."
      );
    } finally {
      setSavingPhone(false);
    }
  }

  // App Store Guideline 5.1.1(v): an app that supports account creation must
  // let the user delete their account from within the app — not just
  // deactivate, and not by emailing support.
  function handleDeleteAccount() {
    Alert.alert(
      "Delete account?",
      "This permanently deletes your account, profile, messages and media. It cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            Alert.alert("Are you sure?", "This is permanent. Everything will be erased.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete forever",
                style: "destructive",
                onPress: async () => {
                  const { error } = await supabase.rpc("delete_own_account");
                  if (error) {
                    Alert.alert("Couldn't delete account", error.message);
                    return;
                  }
                  // The account is gone; drop the now-orphaned local session.
                  await signOut().catch(() => {});
                },
              },
            ]);
          },
        },
      ]
    );
  }

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
        <Pressable
          onPress={() => router.push("/edit-profile" as never)}
          accessibilityRole="button"
          accessibilityLabel="Edit profile"
          style={[styles.profileCard, { backgroundColor: theme.surfaceElevated }]}
        >
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
          <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
        </Pressable>

        <Text style={[styles.groupLabel, { color: theme.textSecondary }]}>PROFILE</Text>
        <Pressable
          onPress={() => router.push("/edit-profile" as never)}
          accessibilityRole="button"
          accessibilityLabel={profile?.bio ? "Edit bio" : "Add a bio"}
          style={[styles.section, { backgroundColor: theme.surfaceElevated }]}
        >
          <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>Bio</Text>
          <Text
            style={[
              styles.sectionValue,
              { color: profile?.bio ? theme.text : theme.textSecondary },
            ]}
          >
            {profile?.bio || "Add a few words about yourself"}
          </Text>
        </Pressable>

        <View style={[styles.section, { backgroundColor: theme.surfaceElevated, paddingVertical: spacing.md }]}>
          <TextField
            label="Phone number"
            value={phoneDraft}
            onChangeText={setPhoneDraft}
            keyboardType="phone-pad"
            autoComplete="tel"
            placeholder="+1 415 555 2671"
            hint="Optional — lets friends find you from their contacts."
            error={phoneError}
          />
          {phoneDraft.trim() !== (profile?.phone ?? "") ? (
            <Button
              title="Save number"
              onPress={handleSavePhone}
              loading={savingPhone}
              style={styles.savePhoneButton}
            />
          ) : null}
        </View>

        <Text style={[styles.groupLabel, { color: theme.textSecondary }]}>PREFERENCES</Text>
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

        <Text style={[styles.groupLabel, { color: theme.textSecondary }]}>PRIVACY & SOCIAL</Text>
        <Pressable
          onPress={() => router.push("/find-friends")}
          accessibilityRole="button"
          accessibilityLabel="Find friends from your contacts"
          style={[styles.section, styles.settingRow, { backgroundColor: theme.surfaceElevated }]}
        >
          <View style={styles.settingLabel}>
            <Ionicons name="person-add-outline" size={20} color={theme.accent} />
            <Text style={[styles.settingText, { color: theme.text }]}>Find friends</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
        </Pressable>

        <Pressable
          onPress={() => router.push("/privacy-security")}
          accessibilityRole="button"
          accessibilityLabel="Privacy and Security"
          style={[styles.section, styles.settingRow, { backgroundColor: theme.surfaceElevated }]}
        >
          <View style={styles.settingLabel}>
            <Ionicons name="lock-closed-outline" size={20} color={theme.accent} />
            <Text style={[styles.settingText, { color: theme.text }]}>Privacy & Security</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
        </Pressable>

        <Text style={[styles.groupLabel, { color: theme.textSecondary }]}>ABOUT & SUPPORT</Text>
        {/* App Review checks that the privacy policy and terms are reachable
            from inside the app, not only from the store listing. */}
        <Pressable
          onPress={() => Linking.openURL(TERMS_URL)}
          accessibilityRole="link"
          accessibilityLabel="Terms of Service"
          style={[styles.section, styles.settingRow, { backgroundColor: theme.surfaceElevated }]}
        >
          <View style={styles.settingLabel}>
            <Ionicons name="document-text-outline" size={20} color={theme.accent} />
            <Text style={[styles.settingText, { color: theme.text }]}>Terms of Service</Text>
          </View>
          <Ionicons name="open-outline" size={18} color={theme.textSecondary} />
        </Pressable>

        <Pressable
          onPress={() => Linking.openURL(PRIVACY_URL)}
          accessibilityRole="link"
          accessibilityLabel="Privacy Policy"
          style={[styles.section, styles.settingRow, { backgroundColor: theme.surfaceElevated }]}
        >
          <View style={styles.settingLabel}>
            <Ionicons name="shield-checkmark-outline" size={20} color={theme.accent} />
            <Text style={[styles.settingText, { color: theme.text }]}>Privacy Policy</Text>
          </View>
          <Ionicons name="open-outline" size={18} color={theme.textSecondary} />
        </Pressable>

        {/* Guideline 1.2 requires an app with user-generated content to give
            users a way to reach the developer — this row is that route.
            Opens the FAQ (gettelevo.space/support) rather than a mailto:
            composer directly: most support questions (a lost sign-in code,
            a reinstalled device losing Secret Chat history, a call with no
            audio) already have a written answer there, and the page itself
            links to SUPPORT_EMAIL at the bottom for anything the FAQ
            doesn't cover — so this saves the common case a round trip
            through Mail while still reaching a human for the rest. */}
        <Pressable
          onPress={() => Linking.openURL(SUPPORT_URL)}
          accessibilityRole="link"
          accessibilityLabel="Contact support"
          style={[styles.section, styles.settingRow, { backgroundColor: theme.surfaceElevated }]}
        >
          <View style={styles.settingLabel}>
            <Ionicons name="mail-outline" size={20} color={theme.accent} />
            <Text style={[styles.settingText, { color: theme.text }]}>Contact support</Text>
          </View>
          <Ionicons name="open-outline" size={18} color={theme.textSecondary} />
        </Pressable>

        <Text style={[styles.groupLabel, { color: theme.textSecondary }]}>ACCOUNT</Text>
        <Button title="Sign out" variant="secondary" onPress={handleSignOut} />

        <Pressable
          onPress={handleDeleteAccount}
          accessibilityRole="button"
          accessibilityLabel="Delete account"
          style={styles.deleteAccountRow}
        >
          <Text style={[styles.deleteAccountText, { color: theme.danger }]}>Delete account</Text>
        </Pressable>
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
  groupLabel: { fontSize: 12, fontWeight: "600", marginTop: spacing.md, marginLeft: spacing.xs },
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
  savePhoneButton: { marginTop: spacing.sm },
  deleteAccountRow: { alignItems: "center", paddingVertical: spacing.md },
  deleteAccountText: { fontSize: 15, fontWeight: "600" },
});
