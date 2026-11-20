/** Report categories, shared by message and profile reports. */
export const REPORT_REASONS: { key: string; label: string }[] = [
  { key: "spam", label: "Spam" },
  { key: "harassment", label: "Harassment or bullying" },
  { key: "inappropriate", label: "Inappropriate content" },
  { key: "violence", label: "Violence or threats" },
  { key: "other", label: "Something else" },
];

/** Turns a database refusal (095 verify_report_target, 038 rate limit) into
 * a sentence a person can read. */
export function reportErrorMessage(raw: string | undefined): string {
  const text = (raw ?? "").toLowerCase();
  if (text.includes("cannot be reported")) return "This account can't be reported.";
  if (text.includes("duplicate report")) return "You already reported this. We're looking into it.";
  if (text.includes("have a chat with")) return "You can report people you have a chat with.";
  if (text.includes("rate") || text.includes("too many")) return "You've sent a lot of reports. Please try again later.";
  return "Please try again in a moment.";
}
