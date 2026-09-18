/** Canonical phone format used everywhere a number is stored or compared.
 *
 * Signup used to save the raw `.trim()` of whatever the user typed, while
 * contact discovery hashed a normalised `+digits` form. Those disagree, so
 * "+998 90 123-45-67" and "998901234567" were two different strings: the
 * unique index on profiles.phone let the same person register twice, and
 * only one of those accounts was ever findable from a friend's address book.
 *
 * Digits only, with a leading +. Deliberately not full E.164 parsing (no
 * country inference) — the goal is that one number always yields one string,
 * not that the string is provably dialable.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

/** True when a number has enough digits to plausibly be real. Rejects the
 * "12345" placeholders people type to get past a required field. */
export function isPlausiblePhone(raw: string): boolean {
  return raw.replace(/[^\d]/g, "").length >= 7;
}
