import * as SecureStore from "expo-secure-store";

/**
 * Auth links (email confirmation, password reset, email change) arrive with
 * a ready session in the URL. Any link of that shape would otherwise sign the
 * app into whatever account the link names, so a link from someone else could
 * silently swap the user into the sender's account. A link is honoured only
 * for the account already signed in, or when this device asked for such an
 * email recently.
 */
const KEY = "televo.authLinkExpectedAt";
const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function expectAuthLink(): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, String(Date.now()));
  } catch {
    // Without the marker the link is refused and the emailed code still works.
  }
}

async function consumeExpectation(): Promise<boolean> {
  try {
    const value = await SecureStore.getItemAsync(KEY);
    await SecureStore.deleteItemAsync(KEY);
    return value !== null && Date.now() - Number(value) < WINDOW_MS;
  } catch {
    return false;
  }
}

/** The account (JWT `sub`) a link's access token belongs to, or null. */
export function tokenSubject(accessToken: string): string | null {
  try {
    const part = accessToken.split(".")[1];
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const sub = JSON.parse(json).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

/** Whether a session from an auth link may replace the current one. */
export async function mayApplyAuthLink(accessToken: string, currentUserId: string | null): Promise<boolean> {
  const linkUser = tokenSubject(accessToken);
  if (!linkUser) return false;
  if (currentUserId) return currentUserId === linkUser;
  return consumeExpectation();
}
