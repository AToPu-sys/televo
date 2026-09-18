/**
 * Password policy, in one place.
 *
 * This lived only inside app/(auth)/reset-password.tsx, so the SIGN-UP screen
 * enforced nothing beyond "not empty" — an account could be created with a
 * 3-character password. Supabase's own server-side floor defaults to 6, which
 * is not a meaningful barrier against credential stuffing, and a weak password
 * is the most realistic route to a compromised account in this app: everything
 * else (RLS, SECURITY DEFINER guards, E2EE) assumes the account itself is not
 * attacker-controlled.
 */
export const MIN_PASSWORD_LENGTH = 10;

/** Returns an error message, or null when the password is acceptable. */
export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  // Length is the property that actually matters against offline guessing, so
  // this stays deliberately simple rather than demanding symbol classes — a
  // rule set that pushes people toward "Passw0rd!" buys nothing.
  return null;
}
