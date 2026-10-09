/** Body of a kind='system' message, written server-side by post_group_event
 * (scripts/sql/069_group_management.sql). Names are snapshotted at the time
 * of the event so a removed member still reads correctly afterwards. */
type GroupEvent = {
  event?: string;
  actor_name?: string;
  target_name?: string;
  target_names?: string[];
  title?: string;
};

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "someone";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function describeGroupEvent(body: string | null | undefined): string {
  let parsed: GroupEvent;
  try {
    parsed = JSON.parse(body ?? "") as GroupEvent;
  } catch {
    return "Group updated";
  }
  const actor = parsed.actor_name ?? "Someone";
  switch (parsed.event) {
    case "members_added":
      return `${actor} added ${joinNames(parsed.target_names ?? [])}`;
    case "member_removed":
      return `${actor} removed ${parsed.target_name ?? "a member"}`;
    case "member_left":
      return `${actor} left the group`;
    case "title_changed":
      return `${actor} renamed the group to “${parsed.title ?? ""}”`;
    case "photo_changed":
      return `${actor} changed the group photo`;
    case "photo_removed":
      return `${actor} removed the group photo`;
    default:
      return "Group updated";
  }
}
