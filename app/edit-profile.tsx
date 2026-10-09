import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "../src/components/Avatar";
import { Button } from "../src/components/Button";
import { TextField } from "../src/components/TextField";
import { useAuth } from "../src/hooks/useAuth";
import { useTheme } from "../src/hooks/useTheme";
import { uploadAvatar } from "../src/lib/media";
import { supabase } from "../src/lib/supabase";
import {
  checkUsername,
  quickUsernameProblem,
  usernameErrorFromSave,
  usernameProblemMessage,
} from "../src/lib/username";
import { spacing } from "../src/theme";

/**
 * Editing your own profile. Until this existed there was no way to set an
 * avatar (uploadAvatar was written but never called from anywhere) or change
 * your display name or bio after signing up.
 */
export default function EditProfileScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { user } = useAuth();

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [username, setUsername] = useState("");
  const [originalUsername, setOriginalUsername] = useState("");
  const [usernameStatus, setUsernameStatus] = useState<
    { kind: "idle" } | { kind: "checking" } | { kind: "ok" } | { kind: "problem"; message: string }
  >({ kind: "idle" });
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;

    supabase
      .from("profiles")
      .select("display_name, bio, avatar_url, username")
      .eq("id", user.id)
      .single()
      .then(({ data }) => {
        if (!active || !data) return;
        setDisplayName(data.display_name ?? "");
        setBio(data.bio ?? "");
        setAvatarUrl(data.avatar_url);
        setUsername(String(data.username ?? ""));
        setOriginalUsername(String(data.username ?? ""));
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [user?.id]);

  const usernameChanged = username.trim().toLowerCase() !== originalUsername.toLowerCase();

  // Live verdict while typing, debounced so each keystroke isn't a round trip.
  // An unchanged username is never re-checked: an existing account may predate
  // the current rules (e.g. a 3-character name) and is allowed to keep it.
  useEffect(() => {
    if (!usernameChanged) {
      setUsernameStatus({ kind: "idle" });
      return;
    }
    const quick = quickUsernameProblem(username);
    if (quick) {
      setUsernameStatus({ kind: "problem", message: usernameProblemMessage(quick) });
      return;
    }
    setUsernameStatus({ kind: "checking" });
    let active = true;
    const timer = setTimeout(async () => {
      const problem = await checkUsername(username);
      if (!active) return;
      setUsernameStatus(
        problem ? { kind: "problem", message: usernameProblemMessage(problem) } : { kind: "ok" }
      );
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [username, usernameChanged]);

  async function handlePickAvatar() {
    if (!user?.id || uploadingAvatar) return;

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Photo access needed", "Allow photo access to choose a profile picture.");
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (picked.canceled || !picked.assets?.[0]) return;

    setUploadingAvatar(true);
    try {
      const publicUrl = await uploadAvatar(user.id, picked.assets[0].uri);
      const { error: updateError } = await supabase
        .from("profiles")
        .update({ avatar_url: publicUrl })
        .eq("id", user.id);
      if (updateError) throw updateError;
      setAvatarUrl(publicUrl);
    } catch (caught) {
      Alert.alert("Upload failed", caught instanceof Error ? caught.message : "Please try again.");
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function handleRemoveAvatar() {
    if (!user?.id || uploadingAvatar || !avatarUrl) return;
    Alert.alert("Remove photo?", "Your profile will show your initials instead.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setUploadingAvatar(true);
          try {
            const { error: updateError } = await supabase
              .from("profiles")
              .update({ avatar_url: null })
              .eq("id", user.id);
            if (updateError) throw updateError;
            setAvatarUrl(null);
          } catch (caught) {
            Alert.alert("Couldn't remove photo", caught instanceof Error ? caught.message : "Please try again.");
          } finally {
            setUploadingAvatar(false);
          }
        },
      },
    ]);
  }

  async function handleSave() {
    if (!user?.id) return;
    setError(null);

    const trimmedName = displayName.trim();
    if (trimmedName.length < 1 || trimmedName.length > 50) {
      setError("Your name must be between 1 and 50 characters.");
      return;
    }

    setSaving(true);
    try {
      const update: { display_name: string; bio: string | null; username?: string } = {
        display_name: trimmedName,
        bio: bio.trim() || null,
      };
      if (usernameChanged) {
        const problem = await checkUsername(username);
        if (problem) {
          setUsernameStatus({ kind: "problem", message: usernameProblemMessage(problem) });
          return;
        }
        update.username = username.trim();
      }
      const { error: updateError } = await supabase.from("profiles").update(update).eq("id", user.id);
      if (updateError) {
        // The trigger is the final word (a name can be taken between the live
        // check and this save) — show its verdict on the username field.
        const usernameMessage = usernameErrorFromSave(updateError.message);
        if (usernameMessage) {
          setUsernameStatus({ kind: "problem", message: usernameMessage });
          return;
        }
        throw updateError;
      }
      router.back();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't save your profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={12}>
          <Ionicons name="close" size={26} color={theme.accent} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Edit profile</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <ActivityIndicator color={theme.accent} style={styles.loader} />
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Pressable
            onPress={handlePickAvatar}
            accessibilityRole="button"
            accessibilityLabel="Change profile picture"
            style={styles.avatarBlock}
          >
            <Avatar name={displayName || "You"} uri={avatarUrl} size={96} />
            <Text style={[styles.avatarAction, { color: theme.accent }]}>
              {uploadingAvatar ? "Uploading…" : "Change photo"}
            </Text>
          </Pressable>

          {avatarUrl && !uploadingAvatar ? (
            <Pressable
              onPress={handleRemoveAvatar}
              accessibilityRole="button"
              accessibilityLabel="Remove profile picture"
              style={styles.removeAvatarButton}
            >
              <Text style={[styles.removeAvatarText, { color: theme.danger }]}>Remove photo</Text>
            </Pressable>
          ) : null}

          <TextField
            label="Name"
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Your name"
            maxLength={50}
            error={error}
          />

          <TextField
            label="Username"
            value={username}
            onChangeText={(text) => setUsername(text.replace(/\s/g, ""))}
            placeholder="username"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={24}
            error={usernameStatus.kind === "problem" ? usernameStatus.message : null}
            hint={
              usernameStatus.kind === "checking"
                ? "Checking…"
                : usernameStatus.kind === "ok"
                  ? `@${username.trim()} is available.`
                  : "People can find you by this. 4–24 characters: a–z, 0–9, _ and ."
            }
          />

          <TextField
            label="Bio"
            value={bio}
            onChangeText={setBio}
            placeholder="A few words about you"
            hint="Optional."
            multiline
            maxLength={200}
          />

          <Button
            title="Save"
            onPress={handleSave}
            loading={saving}
            disabled={usernameStatus.kind === "problem" || usernameStatus.kind === "checking"}
          />
        </ScrollView>
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
  content: { padding: spacing.xl, gap: spacing.lg },
  avatarBlock: { alignItems: "center", gap: spacing.sm },
  avatarAction: { fontSize: 15, fontWeight: "600" },
  removeAvatarButton: { alignItems: "center", marginTop: -spacing.sm },
  removeAvatarText: { fontSize: 14, fontWeight: "500" },
});
