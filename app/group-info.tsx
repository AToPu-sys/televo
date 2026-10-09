import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActionSheet, type ActionSheetOption } from "../src/components/ActionSheet";
import { Avatar } from "../src/components/Avatar";
import { Button } from "../src/components/Button";
import { TextField } from "../src/components/TextField";
import { useAuth } from "../src/hooks/useAuth";
import { useContacts } from "../src/hooks/useContacts";
import { useE2ee } from "../src/hooks/useE2ee";
import { useTheme } from "../src/hooks/useTheme";
import { uploadGroupAvatar } from "../src/lib/media";
import { supabase } from "../src/lib/supabase";
import { spacing } from "../src/theme";

type Member = {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  joinedAt: string;
};

type GroupInfo = {
  title: string;
  description: string | null;
  avatarUrl: string | null;
  createdBy: string;
  isEncrypted: boolean;
};

/** Server error codes from 069_group_management.sql, in plain words. */
function describeGroupError(message: string): string {
  if (message.includes("group_admin_required")) return "Only group admins can do that.";
  if (message.includes("only_owner_can_remove_admins")) return "Only the group owner can remove an admin.";
  if (message.includes("only_owner_can_demote")) return "Only the group owner can remove admin rights.";
  if (message.includes("cannot_remove_owner") || message.includes("cannot_demote_owner"))
    return "The group owner can't be removed.";
  if (message.includes("group_title_invalid")) return "The group name must be 1–64 characters.";
  if (message.includes("not_a_member")) return "That person is no longer in this group.";
  return message;
}

export default function GroupInfoScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { theme } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { repairMissingSessionKeys } = useE2ee();

  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    if (!conversationId) return;
    const [{ data: conv }, { data: participants }] = await Promise.all([
      supabase
        .from("conversations")
        .select("title, description, avatar_url, created_by, is_encrypted")
        .eq("id", conversationId)
        .single(),
      supabase
        .from("conversation_participants")
        .select("user_id, is_admin, joined_at")
        .eq("conversation_id", conversationId),
    ]);
    if (!conv) {
      setLoading(false);
      return;
    }
    const ids = (participants ?? []).map((p) => p.user_id);
    const { data: profiles } = ids.length
      ? await supabase.from("profiles").select("id, display_name, username, avatar_url").in("id", ids)
      : { data: [] };

    setGroup({
      title: conv.title ?? "Group",
      description: conv.description,
      avatarUrl: conv.avatar_url,
      createdBy: conv.created_by,
      isEncrypted: conv.is_encrypted,
    });
    setMembers(
      (participants ?? []).map((p) => {
        const profile = profiles?.find((pr) => pr.id === p.user_id);
        return {
          id: p.user_id,
          displayName: profile?.display_name ?? "Unknown",
          username: String(profile?.username ?? ""),
          avatarUrl: profile?.avatar_url ?? null,
          isAdmin: p.is_admin,
          joinedAt: p.joined_at,
        };
      })
    );
    setLoading(false);
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const me = members.find((m) => m.id === user?.id);
  const iAmAdmin = !!me?.isAdmin;
  const iAmOwner = !!group && group.createdBy === user?.id;

  // Owner first, then admins, then everyone else alphabetically.
  const sortedMembers = useMemo(
    () =>
      [...members].sort((a, b) => {
        const rank = (m: Member) => (m.id === group?.createdBy ? 0 : m.isAdmin ? 1 : 2);
        return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName);
      }),
    [members, group?.createdBy]
  );

  async function run(action: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    try {
      const { error } = await action();
      if (error) {
        Alert.alert("Couldn't do that", describeGroupError(error.message));
        return false;
      }
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function handleChangePhoto() {
    if (!user?.id || !conversationId) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Photo access needed", "Allow photo access to choose a group photo.");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (picked.canceled || !picked.assets?.[0]) return;
    setBusy(true);
    try {
      const url = await uploadGroupAvatar(user.id, conversationId, picked.assets[0].uri);
      const { error } = await supabase.from("conversations").update({ avatar_url: url }).eq("id", conversationId);
      if (error) throw error;
      await load();
    } catch (caught) {
      Alert.alert("Upload failed", caught instanceof Error ? describeGroupError(caught.message) : "Try again.");
    } finally {
      setBusy(false);
    }
  }

  function startEditing() {
    if (!group) return;
    setEditTitle(group.title);
    setEditDescription(group.description ?? "");
    setEditing(true);
  }

  async function saveEdits() {
    if (!conversationId) return;
    const title = editTitle.trim();
    if (title.length < 1 || title.length > 64) {
      Alert.alert("Group name", "The group name must be 1–64 characters.");
      return;
    }
    const ok = await run(() =>
      supabase
        .from("conversations")
        .update({ title, description: editDescription.trim() || null })
        .eq("id", conversationId)
    );
    if (ok) setEditing(false);
  }

  function memberOptions(member: Member): ActionSheetOption[] {
    const options: ActionSheetOption[] = [];
    if (member.id !== user?.id) {
      options.push({
        key: "view",
        label: "View profile",
        icon: "person-outline",
        onPress: () =>
          router.push({ pathname: "/user-profile" as never, params: { userId: member.id } }),
      });
    }
    const isOwner = member.id === group?.createdBy;
    if (!iAmAdmin || isOwner || member.id === user?.id || !conversationId) return options;

    if (!member.isAdmin) {
      options.push({
        key: "promote",
        label: "Make admin",
        icon: "shield-outline",
        onPress: () => void run(() => supabase.rpc("set_group_admin", {
          p_conversation: conversationId, p_user: member.id, p_make_admin: true,
        })),
      });
    } else if (iAmOwner) {
      options.push({
        key: "demote",
        label: "Remove admin rights",
        icon: "shield-half-outline",
        onPress: () => void run(() => supabase.rpc("set_group_admin", {
          p_conversation: conversationId, p_user: member.id, p_make_admin: false,
        })),
      });
    }
    if (!member.isAdmin || iAmOwner) {
      options.push({
        key: "remove",
        label: "Remove from group",
        icon: "person-remove-outline",
        destructive: true,
        onPress: () =>
          Alert.alert(`Remove ${member.displayName}?`, "They'll no longer see new messages in this group.", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Remove",
              style: "destructive",
              onPress: () => void run(() => supabase.rpc("remove_group_member", {
                p_conversation: conversationId, p_user: member.id,
              })),
            },
          ]),
      });
    }
    return options;
  }

  function leaveGroup() {
    if (!conversationId) return;
    Alert.alert("Leave group?", "You'll stop receiving messages from this group.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const { error } = await supabase.rpc("leave_group", { p_conversation: conversationId });
          setBusy(false);
          if (error) {
            Alert.alert("Couldn't leave", describeGroupError(error.message));
            return;
          }
          router.dismissAll();
          router.replace("/(tabs)/chats" as never);
        },
      },
    ]);
  }

  function deleteGroup() {
    if (!conversationId) return;
    Alert.alert("Delete group?", "The group and all its messages will be deleted for everyone. This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const { error } = await supabase.from("conversations").delete().eq("id", conversationId);
          setBusy(false);
          if (error) {
            Alert.alert("Couldn't delete", describeGroupError(error.message));
            return;
          }
          router.dismissAll();
          router.replace("/(tabs)/chats" as never);
        },
      },
    ]);
  }

  async function addMembers(ids: string[]) {
    if (!conversationId || ids.length === 0) return;
    const ok = await run(() =>
      supabase.rpc("add_group_members", { p_conversation: conversationId, p_user_ids: ids })
    );
    setAddOpen(false);
    // An encrypted group's key has to be wrapped for the new members before
    // they can read anything; do it now rather than waiting for someone to
    // reopen the chat.
    if (ok && group?.isEncrypted) {
      void repairMissingSessionKeys(conversationId);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <ActivityIndicator color={theme.accent} style={styles.loader} />
      </SafeAreaView>
    );
  }

  if (!group || !me) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <Ionicons name="close" size={26} color={theme.accent} />
          </Pressable>
        </View>
        <Text style={[styles.empty, { color: theme.textSecondary }]}>You're no longer in this group.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable onPress={() => (editing ? setEditing(false) : router.back())} hitSlop={12} accessibilityRole="button" accessibilityLabel={editing ? "Cancel editing" : "Close"}>
          {editing ? (
            <Text style={[styles.headerAction, { color: theme.accent }]}>Cancel</Text>
          ) : (
            <Ionicons name="close" size={26} color={theme.accent} />
          )}
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Group info</Text>
        {iAmAdmin ? (
          <Pressable onPress={editing ? saveEdits : startEditing} hitSlop={12} accessibilityRole="button" disabled={busy}>
            <Text style={[styles.headerAction, { color: theme.accent }]}>{editing ? "Save" : "Edit"}</Text>
          </Pressable>
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.identity}>
          <Pressable onPress={iAmAdmin ? handleChangePhoto : undefined} disabled={!iAmAdmin || busy} accessibilityRole={iAmAdmin ? "button" : undefined} accessibilityLabel="Change group photo">
            <Avatar name={group.title} uri={group.avatarUrl} size={96} />
          </Pressable>
          {iAmAdmin ? (
            <View style={styles.photoActions}>
              <Pressable onPress={handleChangePhoto} disabled={busy} accessibilityRole="button">
                <Text style={[styles.link, { color: theme.accent }]}>{group.avatarUrl ? "Change photo" : "Set photo"}</Text>
              </Pressable>
              {group.avatarUrl ? (
                <Pressable
                  onPress={() => void run(() => supabase.from("conversations").update({ avatar_url: null }).eq("id", conversationId!))}
                  disabled={busy}
                  accessibilityRole="button"
                >
                  <Text style={[styles.link, { color: theme.danger }]}>Remove</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {editing ? (
            <View style={styles.editFields}>
              <TextField label="Group name" value={editTitle} onChangeText={setEditTitle} maxLength={64} />
              <TextField
                label="Description"
                value={editDescription}
                onChangeText={setEditDescription}
                placeholder="What's this group about?"
                hint="Optional. Everyone in the group can see it."
                multiline
                maxLength={255}
              />
            </View>
          ) : (
            <>
              <Text style={[styles.title, { color: theme.text }]}>{group.title}</Text>
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
                {members.length} {members.length === 1 ? "member" : "members"}
                {group.isEncrypted ? " · end-to-end encrypted" : ""}
              </Text>
              {group.description ? (
                <Text style={[styles.description, { color: theme.text }]}>{group.description}</Text>
              ) : null}
            </>
          )}
        </View>

        <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>
          {members.length} {members.length === 1 ? "MEMBER" : "MEMBERS"}
        </Text>
        <View style={[styles.card, { backgroundColor: theme.surfaceElevated }]}>
          {iAmAdmin ? (
            <Pressable onPress={() => setAddOpen(true)} style={styles.memberRow} accessibilityRole="button" disabled={busy}>
              <View style={[styles.addIcon, { backgroundColor: theme.accent }]}>
                <Ionicons name="person-add" size={18} color="#FFFFFF" />
              </View>
              <Text style={[styles.addText, { color: theme.accent }]}>Add members</Text>
            </Pressable>
          ) : null}
          {sortedMembers.map((member) => {
            const isOwner = member.id === group.createdBy;
            return (
              <Pressable
                key={member.id}
                onPress={() => (member.id === user?.id ? undefined : setSelectedMember(member))}
                style={styles.memberRow}
                accessibilityRole="button"
                accessibilityLabel={member.displayName}
              >
                <Avatar name={member.displayName} uri={member.avatarUrl} size={40} />
                <View style={styles.memberBody}>
                  <Text style={[styles.memberName, { color: theme.text }]} numberOfLines={1}>
                    {member.id === user?.id ? "You" : member.displayName}
                  </Text>
                  {member.username ? (
                    <Text style={[styles.memberSub, { color: theme.textSecondary }]} numberOfLines={1}>
                      @{member.username}
                    </Text>
                  ) : null}
                </View>
                {isOwner || member.isAdmin ? (
                  <Text style={[styles.badge, { color: theme.accent }]}>{isOwner ? "owner" : "admin"}</Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>

        <View style={[styles.card, { backgroundColor: theme.surfaceElevated }]}>
          <Pressable onPress={leaveGroup} style={styles.dangerRow} accessibilityRole="button" disabled={busy}>
            <Ionicons name="exit-outline" size={20} color={theme.danger} />
            <Text style={[styles.dangerText, { color: theme.danger }]}>Leave group</Text>
          </Pressable>
          {iAmOwner ? (
            <Pressable onPress={deleteGroup} style={styles.dangerRow} accessibilityRole="button" disabled={busy}>
              <Ionicons name="trash-outline" size={20} color={theme.danger} />
              <Text style={[styles.dangerText, { color: theme.danger }]}>Delete group</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>

      <ActionSheet
        visible={!!selectedMember}
        onClose={() => setSelectedMember(null)}
        title={selectedMember?.displayName}
        options={selectedMember ? memberOptions(selectedMember) : []}
      />

      <AddMembersModal
        visible={addOpen}
        existingIds={members.map((m) => m.id)}
        onClose={() => setAddOpen(false)}
        onAdd={addMembers}
        busy={busy}
      />
    </SafeAreaView>
  );
}

function AddMembersModal({
  visible,
  existingIds,
  onClose,
  onAdd,
  busy,
}: {
  visible: boolean;
  existingIds: string[];
  onClose: () => void;
  onAdd: (ids: string[]) => void;
  busy: boolean;
}) {
  const { theme } = useTheme();
  const { user } = useAuth();
  const { contacts, loading } = useContacts(user?.id);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) setSelected([]);
  }, [visible]);

  const candidates = contacts.filter((c) => !existingIds.includes(c.id));

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={[styles.headerAction, { color: theme.accent }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.headerTitle, { color: theme.text }]}>Add members</Text>
          <View style={styles.headerSpacer} />
        </View>
        {loading ? (
          <ActivityIndicator color={theme.accent} style={styles.loader} />
        ) : (
          <FlatList
            data={candidates}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={
              <Text style={[styles.empty, { color: theme.textSecondary }]}>
                Everyone you chat with is already in this group.
              </Text>
            }
            renderItem={({ item }) => {
              const isSelected = selected.includes(item.id);
              return (
                <Pressable
                  onPress={() =>
                    setSelected((cur) => (cur.includes(item.id) ? cur.filter((v) => v !== item.id) : [...cur, item.id]))
                  }
                  style={styles.memberRow}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                >
                  <Avatar name={item.displayName} uri={item.avatarUrl} size={40} />
                  <View style={styles.memberBody}>
                    <Text style={[styles.memberName, { color: theme.text }]} numberOfLines={1}>
                      {item.displayName}
                    </Text>
                    <Text style={[styles.memberSub, { color: theme.textSecondary }]} numberOfLines={1}>
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
        <View style={styles.modalFooter}>
          <Button
            title={selected.length ? `Add ${selected.length}` : "Add"}
            onPress={() => onAdd(selected)}
            disabled={selected.length === 0}
            loading={busy}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loader: { marginTop: spacing.xxl },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  headerAction: { fontSize: 16, fontWeight: "600" },
  headerSpacer: { width: 40 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  identity: { alignItems: "center", gap: spacing.sm, marginBottom: spacing.md },
  photoActions: { flexDirection: "row", gap: spacing.lg },
  link: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 22, fontWeight: "700", textAlign: "center" },
  subtitle: { fontSize: 14 },
  description: { fontSize: 15, textAlign: "center", marginTop: spacing.xs },
  editFields: { alignSelf: "stretch", gap: spacing.md },
  sectionLabel: { fontSize: 12, fontWeight: "600", letterSpacing: 0.4, marginLeft: spacing.sm },
  card: { borderRadius: 14, overflow: "hidden" },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  memberBody: { flex: 1 },
  memberName: { fontSize: 16, fontWeight: "600" },
  memberSub: { fontSize: 13 },
  badge: { fontSize: 13, fontWeight: "600" },
  addIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  addText: { fontSize: 16, fontWeight: "600" },
  dangerRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md },
  dangerText: { fontSize: 16, fontWeight: "600" },
  empty: { textAlign: "center", marginTop: spacing.xxl, paddingHorizontal: spacing.xl, fontSize: 15 },
  modalFooter: { padding: spacing.lg },
});
