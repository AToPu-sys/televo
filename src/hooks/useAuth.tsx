import { createClient, type Session, type User } from "@supabase/supabase-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { normalizePhone } from "../lib/phone";
import { wipeLocalMessages } from "../lib/localMessages";
import { clearMediaCache } from "../lib/mediaCache";
import { clearOutbox } from "../lib/outbox";
import { resetIceServers } from "../lib/iceServers";
import { wipeSharedSessionKeys } from "../lib/notificationKeys";
import { supabase } from "../lib/supabase";

/** Verifies a password against the CURRENT account without disturbing the
 * live session — unlike verifyPasswordOnly (below), which signs out
 * whatever session signInWithPassword creates, and would kill the caller's
 * own in-progress session if used mid-session (e.g. re-authenticating to
 * disable 2FA). A throwaway client with no persisted storage means the
 * sign-in it performs never touches SecureStore or the shared `supabase`
 * client's in-memory session at all. */
export async function verifyCurrentPassword(email: string, password: string): Promise<boolean> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return false;

  const scratchClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  // See signInWithEmail's own comment: a pasted password can carry a
  // trailing space/newline the source text never meant to include, and
  // Supabase treats that as simply the wrong password — trimming here is
  // what makes a copy-pasted password behave the same as a typed one.
  const { error } = await scratchClient.auth.signInWithPassword({
    email: email.trim(),
    password: password.trim(),
  });
  return !error;
}

type AuthContextValue = {
  session: Session | null;
  user: User | null;
  /** True until the stored session has been read, so we don't flash the login screen. */
  initializing: boolean;
  /** True once password sign-in succeeded but a TOTP code is still required
   * (the account has Two-Step Verification enabled). The session exists at
   * AAL1 but every RLS-gated query still fails until AAL2 is reached. */
  needsMfaChallenge: boolean;
  /** True while a reset link's session is open and the password hasn't been
   * replaced yet — the app must stay on the new-password screen until then. */
  recoveringPassword: boolean;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  verifyMfaCode: (code: string) => Promise<void>;
  signUpWithEmail: (
    email: string,
    password: string,
    profile: { username: string; displayName: string; phone?: string }
  ) => Promise<{ needsConfirmation: boolean }>;
  /** Emails a password-reset link. Resolves even for an address that has no
   * account: revealing which emails are registered would let anyone probe the
   * user base, so the UI shows the same confirmation either way. */
  sendPasswordReset: (email: string) => Promise<void>;
  /** Re-sends the signup confirmation email (first one lost or in spam). */
  resendConfirmation: (email: string) => Promise<void>;
  /** Checks the password is correct WITHOUT leaving a usable session behind.
   * Used as the first half of two-step sign-in: the session that actually
   * logs the user in comes from the emailed code, so a stolen password alone
   * never grants access. */
  verifyPasswordOnly: (email: string, password: string) => Promise<void>;
  /** Emails a 6-digit sign-in code. Used as an email-verification step on top
   * of the password: knowing the password alone is not enough to get in
   * without also holding the mailbox. */
  sendEmailCode: (email: string) => Promise<void>;
  /** Completes a sendEmailCode sign-in. Throws on a wrong or expired code. */
  verifyEmailCode: (email: string, code: string) => Promise<void>;
  /** Sets a new password for the session opened by a reset link. */
  updatePassword: (newPassword: string) => Promise<void>;
  changeEmail: (newEmail: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [needsMfaChallenge, setNeedsMfaChallenge] = useState(false);
  const [recoveringPassword, setRecoveringPassword] = useState(false);

  const checkMfaLevel = useCallback(async () => {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    // currentLevel stays "aal1" until a TOTP challenge is verified;
    // nextLevel is "aal2" only when the account actually has a factor
    // enrolled, so accounts without 2FA never hit this branch.
    setNeedsMfaChallenge(!!data && data.nextLevel === "aal2" && data.currentLevel !== data.nextLevel);
  }, []);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        setSession(data.session);
        // AWAITED here, specifically for the cold-start path with an
        // already-saved session — this used to be fire-and-forget to avoid
        // holding the splash screen for checkMfaLevel()'s round trip. But an
        // account with BOTH Two-Step Verification and Face ID/passcode
        // enabled hit a real race: `initializing` went false (and
        // needsMfaChallenge was still its default `false`) the instant
        // getSession() resolved, so RootNavigator rendered PasscodeScreen
        // FIRST — and PasscodeScreen fires Face ID's system prompt
        // immediately on mount. That system prompt backgrounds the app,
        // which flips AppState to inactive/active and re-triggers
        // startAutoRefresh() in src/lib/supabase.ts — landing squarely in
        // the middle of checkMfaLevel()'s still-in-flight request. The
        // visible symptom was exactly "MFA flashes for a frame, then Face
        // ID, then the session is gone and it's back on the welcome
        // screen": two unrelated async operations racing to mutate auth
        // state while a THIRD (the OS's own biometric prompt) yanked the
        // app in and out of the foreground mid-flight. Waiting for
        // checkMfaLevel() to settle before `initializing` goes false means
        // needsMfaChallenge is already correct on PasscodeScreen's very
        // first render, so it and the MFA screen can never both mount and
        // race each other — there is nothing left to interrupt.
        // needsMfaChallenge has its own render gate for every OTHER auth
        // transition (a fresh sign-in fires checkMfaLevel from
        // onAuthStateChange below, not from here), so this only adds
        // latency to the one cold-start case that actually needs it.
        if (data.session) await checkMfaLevel();
      })
      .finally(() => {
        setInitializing(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      // Opening a reset link signs the user in for the sole purpose of
      // changing their password. Without this flag the root navigator would
      // see a valid session and drop them straight into the app still using
      // the old password they came here to replace.
      if (event === "PASSWORD_RECOVERY") setRecoveringPassword(true);
      // Any sign-out (button, remote sign-out from another device, expired
      // session): erase this device's copy of the account's chats and media,
      // so the next person to sign in on this phone can't see them.
      if (event === "SIGNED_OUT") {
        clearOutbox();
        resetIceServers();
        void wipeSharedSessionKeys();
        void wipeLocalMessages().catch(() => {});
        try {
          clearMediaCache();
        } catch {
          // best-effort
        }
      }
      setSession(nextSession);
      if (nextSession) void checkMfaLevel();
      else setNeedsMfaChallenge(false);
    });

    return () => subscription.unsubscribe();
  }, [checkMfaLevel]);

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      // Trimmed the same way email already was: a password pasted in from
      // the Desktop review-notes file (Clipboard on iOS sometimes carries a
      // trailing newline/space from how the source text was selected) fails
      // auth with the generic "Invalid login credentials" — indistinguishable
      // from an actually wrong password — unless this trims it first.
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: password.trim(),
      });
      if (error) throw error;
      await checkMfaLevel();
    },
    [checkMfaLevel]
  );

  const verifyMfaCode = useCallback(
    async (code: string) => {
      const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
      if (factorsError) throw factorsError;

      const factor = factors?.totp?.[0];
      if (!factor) throw new Error("No two-step verification method found on this account.");

      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: factor.id,
      });
      if (challengeError) throw challengeError;

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: factor.id,
        challengeId: challenge.id,
        code: code.trim(),
      });
      if (verifyError) throw verifyError;

      setNeedsMfaChallenge(false);
    },
    []
  );

  const signUpWithEmail = useCallback(
    async (
      email: string,
      password: string,
      profile: { username: string; displayName: string; phone?: string }
    ) => {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          // A database trigger (handle_new_user) reads ALL of these —
          // including phone — to create the profiles row in the same
          // transaction as the auth.users insert, so we must not insert one
          // ourselves. phone used to be saved with a follow-up
          // profiles.update() after signUp() returned, gated on `data
          // .session` existing — but this project has email confirmation on
          // (auth.email.enable_confirmations in supabase/config.toml), so
          // signUp() returns a user with NO session until the confirmation
          // link is opened. That gate was therefore never true for a real
          // signup, and the phone was silently dropped every time: a DB
          // audit during this fix found phone = null on every recent
          // account. Putting it in user_metadata instead means
          // handle_new_user() sets it server-side regardless of whether a
          // session exists yet — see scripts/sql/046_signup_phone_in_metadata.sql.
          data: {
            username: profile.username.trim(),
            display_name: profile.displayName.trim(),
            phone: profile.phone ? normalizePhone(profile.phone) : null,
          },
          // Explicit, not left to fall back to the project's site_url:
          // useAuthDeepLinks (app/_layout.tsx) only recognizes a Universal
          // Link under /auth/*, so a confirmation email that defaulted to
          // the bare domain root would land on a path nothing handles.
          emailRedirectTo: "https://gettelevo.space/auth/confirm",
        },
      });
      if (error) throw error;

      // With email confirmation on, Supabase returns a user but no session.
      return { needsConfirmation: !data.session };
    },
    []
  );

  const verifyPasswordOnly = useCallback(async (email: string, password: string) => {
    // Routed through the throwaway client (verifyCurrentPassword above), not
    // the shared `supabase` instance. The previous version called
    // supabase.auth.signInWithPassword directly and then immediately signed
    // back out — but signInWithPassword publishes a REAL session through
    // onAuthStateChange the instant it succeeds, so for one render the app
    // genuinely had a session and RootNavigator (app/_layout.tsx) redirected
    // to /(tabs)/chats; the signOut() a line later fired a second
    // onAuthStateChange and bounced it straight back to /welcome. That's the
    // exact "sign in, chats flash, thrown back out" report — email-code 2FA
    // was never broken, it was racing its own first step. The throwaway
    // client has persistSession/autoRefreshToken off, so it never touches
    // SecureStore or fires onAuthStateChange on the shared client at all —
    // there is no session for the navigator to ever see.
    const ok = await verifyCurrentPassword(email, password);
    if (!ok) throw new Error("Invalid login credentials");
  }, []);

  const sendEmailCode = useCallback(async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        // Never create an account from this path. Without it, a typo'd
        // address would silently register a brand-new empty account instead
        // of reporting that the sign-in failed.
        shouldCreateUser: false,
      },
    });
    if (error) throw error;
  }, []);

  const verifyEmailCode = useCallback(async (email: string, code: string) => {
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });
    if (error) throw error;
  }, []);

  const sendPasswordReset = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      // A Universal Link (Apple's App Site Association at
      // gettelevo.space/.well-known/apple-app-site-association, paths
      // scoped to /auth/*), not the televo:// custom scheme this used to be.
      // iOS opens https:// links matching a verified association DIRECTLY in
      // the app with no intermediate "Open in Televo?" prompt, and — more
      // importantly — a link that goes through a real domain survives every
      // mail client's own re-escaping unchanged, which is what the
      // fullyDecodeUri workaround in app/_layout.tsx exists to paper over
      // for the custom-scheme path. useAuthDeepLinks there handles both
      // televo:// and this https:// form identically once the URL reaches
      // it — this only changes what iOS uses to route the tap in the first
      // place.
      redirectTo: "https://gettelevo.space/auth/reset-password",
    });
    // An unregistered address is not an error worth surfacing — see the
    // enumeration note on the type above.
    if (error && error.status !== 422) throw error;
  }, []);

  const resendConfirmation = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: email.trim(),
      // See sendPasswordReset's comment on the Universal Link switch.
      options: { emailRedirectTo: "https://gettelevo.space/auth/confirm" },
    });
    // Same reasoning as sendPasswordReset above: throwing for an address that
    // has no account turns this into an oracle for "is this person a Televo
    // user", which is exactly the enumeration the reset path already
    // deliberately avoids. Rate-limit errors still surface, since those are
    // actionable and reveal nothing about whether the account exists.
    if (error && error.status !== 422 && !/not found/i.test(error.message)) throw error;
  }, []);

  const updatePassword = useCallback(async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
    setRecoveringPassword(false);
  }, []);

  /** Starts an email address change. Supabase sends a confirmation to the
   * NEW address (and, with "Secure email change" on — the project default —
   * also one to the OLD address) rather than switching immediately; the
   * address on the account only updates once the user follows that link,
   * which arrives as the same `televo://` callback useAuthDeepLinks already
   * handles. Nothing else to do here — there's no separate "confirm change"
   * step in this app beyond opening that link. */
  const changeEmail = useCallback(async (newEmail: string) => {
    const { error } = await supabase.auth.updateUser(
      { email: newEmail.trim() },
      // See sendPasswordReset's comment on the Universal Link switch.
      { emailRedirectTo: "https://gettelevo.space/auth/confirm" }
    );
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      initializing,
      needsMfaChallenge,
      recoveringPassword,
      signInWithEmail,
      verifyMfaCode,
      signUpWithEmail,
      sendPasswordReset,
      resendConfirmation,
      verifyPasswordOnly,
      sendEmailCode,
      verifyEmailCode,
      updatePassword,
      changeEmail,
      signOut,
    }),
    [
      session,
      initializing,
      needsMfaChallenge,
      recoveringPassword,
      signInWithEmail,
      verifyMfaCode,
      signUpWithEmail,
      sendPasswordReset,
      resendConfirmation,
      verifyPasswordOnly,
      sendEmailCode,
      verifyEmailCode,
      updatePassword,
      changeEmail,
      signOut,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
