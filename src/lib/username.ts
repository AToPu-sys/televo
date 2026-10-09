import { supabase } from "./supabase";

/** Codes returned by check_username() (scripts/sql/067_username_rules.sql)
 * and raised by its trigger as "username_<code>". The server is the source of
 * truth; quickUsernameProblem only catches the obvious format cases instantly
 * so the user isn't waiting on a round trip for "too short". */
export type UsernameProblem =
  | "too_short"
  | "too_long"
  | "invalid_chars"
  | "must_start_with_letter"
  | "bad_separators"
  | "reserved"
  | "offensive"
  | "taken";

const MESSAGES: Record<UsernameProblem, string> = {
  too_short: "Username must be at least 4 characters.",
  too_long: "Username can be at most 24 characters.",
  invalid_chars: "Use only Latin letters, numbers, _ and .",
  must_start_with_letter: "Username must start with a letter.",
  bad_separators: "No double _ or . and it can't end with one.",
  reserved: "This username is reserved.",
  offensive: "This username isn't allowed.",
  taken: "This username is already taken.",
};

export function usernameProblemMessage(problem: UsernameProblem): string {
  return MESSAGES[problem];
}

export function quickUsernameProblem(username: string): UsernameProblem | null {
  const value = username.trim().toLowerCase();
  if (value.length < 4) return "too_short";
  if (value.length > 24) return "too_long";
  if (!/^[a-z0-9_.]+$/.test(value)) return "invalid_chars";
  if (!/^[a-z]/.test(value)) return "must_start_with_letter";
  if (/[._]{2,}/.test(value) || /[._]$/.test(value)) return "bad_separators";
  return null;
}

/** Full server-side verdict, including offensive/reserved/taken. Returns null
 * when the username can be used. A network failure returns null rather than
 * blocking — the server trigger still enforces the rules on save. */
export async function checkUsername(username: string): Promise<UsernameProblem | null> {
  const quick = quickUsernameProblem(username);
  if (quick) return quick;
  const { data, error } = await supabase.rpc("check_username", { p_username: username.trim() });
  if (error) return null;
  return (data as UsernameProblem | null) ?? null;
}

/** Maps a save error raised by the enforce_username_rules trigger
 * ("username_offensive" etc.) or the unique index to a readable message. */
export function usernameErrorFromSave(message: string): string | null {
  const match = message.match(/username_([a-z_]+)/);
  if (match && match[1] in MESSAGES) {
    return MESSAGES[match[1] as UsernameProblem];
  }
  if (message.includes("profiles_username_key") || message.toLowerCase().includes("duplicate")) {
    return MESSAGES.taken;
  }
  return null;
}
