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
      .select("display_name, bio, avatar_url")
      .eq("id", user.id)
      .single()
      .then(({ data }) => {
        if (!active || !data) return;
        setDisplayName(data.display_name ?? "");
        setBio(data.bio ?? "");
        setAvatarUrl(data.avatar_url);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [user?.id]);

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
      const { error: updateError } = await supabase
        .from("profiles")
        .update({ display_name: trimmedName, bio: bio.trim() || null })
        .eq("id", user.id);
      if (updateError) throw updateError;
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

          <TextField
            label="Name"
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Your name"
            maxLength={50}
            error={error}
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

          <Button title="Save" onPress={handleSave} loading={saving} />
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
});
