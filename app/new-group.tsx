import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "../src/components/Avatar";
import { Button } from "../src/components/Button";
import { TextField } from "../src/components/TextField";
import { useAuth } from "../src/hooks/useAuth";
import { createGroupChat, useContacts } from "../src/hooks/useContacts";
import { useTheme } from "../src/hooks/useTheme";
import { spacing } from "../src/theme";

export default function NewGroupScreen() {
  const { theme } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const { contacts, loading } = useContacts(user?.id);

  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );
  }

  async function handleCreate() {
    if (!user?.id) return;
    if (title.trim().length < 1) {
      Alert.alert("Name required", "Give your group a name.");
      return;
    }
    if (selected.length === 0) {
      Alert.alert("Add members", "Pick at least one person to add.");
      return;
    }

    setCreating(true);
    try {
      const conversationId = await createGroupChat(user.id, title, selected);
      router.replace(`/chat/${conversationId}`);
    } catch (caught) {
      Alert.alert(
        "Couldn't create group",
        caught instanceof Error ? caught.message : "Please try again."
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            hitSlop={12}
          >
            <Ionicons name="close" size={26} color={theme.accent} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: theme.text }]}>New group</Text>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.form}>
          <TextField
            label="Group name"
            value={title}
            onChangeText={setTitle}
            placeholder="Weekend plans"
            maxLength={64}
          />
          <Text style={[styles.count, { color: theme.textSecondary }]}>
            {selected.length} {selected.length === 1 ? "member" : "members"} selected
          </Text>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
          </View>
        ) : (
          <FlatList
            data={contacts}
            keyExtractor={(item) => item.id}
            ItemSeparatorComponent={() => (
              <View style={[styles.separator, { backgroundColor: theme.border }]} />
            )}
            ListEmptyComponent={
              <View style={styles.center}>
                <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
                  No other users to add yet.
                </Text>
              </View>
            }
            renderItem={({ item }) => {
              const isSelected = selected.includes(item.id);
              return (
                <Pressable
                  onPress={() => toggle(item.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={item.displayName}
                  style={({ pressed }) => [
                    styles.row,
                    { backgroundColor: pressed ? theme.surfaceElevated : "transparent" },
                  ]}
                >
                  <Avatar name={item.displayName} uri={item.avatarUrl} size={44} />
                  <View style={styles.rowBody}>
                    <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                      {item.displayName}
                    </Text>
                    <Text
                      style={[styles.rowSubtitle, { color: theme.textSecondary }]}
                      numberOfLines={1}
                    >
                      @{item.username}
                    </Text>
                  </View>
                  <Ionicons
                    name={isSelected ? "checkmark-circle" : "ellipse-outline"}
                    size={24}
                    color={isSelected ? theme.accent : theme.textSecondary}
                  />
                </Pressable>
              );
            }}
          />
        )}

        <View style={styles.footer}>
          <Button title="Create group" onPress={handleCreate} loading={creating} />
        </View>
      </KeyboardAvoidingView>
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
  headerSpacer: { width: 26 },
  form: { padding: spacing.lg, gap: spacing.sm },
  count: { fontSize: 13, marginLeft: spacing.xs },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowSubtitle: { fontSize: 13 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 72 },
  center: { alignItems: "center", justifyContent: "center", padding: spacing.xxl },
  emptyText: { fontSize: 14 },
  footer: { padding: spacing.lg },
});
