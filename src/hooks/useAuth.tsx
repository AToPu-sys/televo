import type { Session, User } from "@supabase/supabase-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { supabase } from "../lib/supabase";

type AuthContextValue = {
  session: Session | null;
  user: User | null;
  /** True until the stored session has been read, so we don't flash the login screen. */
  initializing: boolean;
  /** True once password sign-in succeeded but a TOTP code is still required
   * (the account has Two-Step Verification enabled). The session exists at
   * AAL1 but every RLS-gated query still fails until AAL2 is reached. */
  needsMfaChallenge: boolean;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  verifyMfaCode: (code: string) => Promise<void>;
  signUpWithEmail: (
    email: string,
    password: string,
    profile: { username: string; displayName: string; phone?: string }
  ) => Promise<{ needsConfirmation: boolean }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [needsMfaChallenge, setNeedsMfaChallenge] = useState(false);

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
        if (data.session) await checkMfaLevel();
      })
      .finally(() => {
        setInitializing(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) void checkMfaLevel();
      else setNeedsMfaChallenge(false);
    });

    return () => subscription.unsubscribe();
  }, [checkMfaLevel]);

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
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
          // A database trigger (handle_new_user) reads these to create the
          // profiles row, so we must not insert one ourselves. The trigger
          // doesn't know about `phone` (it's newer than the trigger), so it's
          // set with a follow-up update once the row and a session exist.
          data: {
            username: profile.username.trim(),
            display_name: profile.displayName.trim(),
          },
        },
      });
      if (error) throw error;

      if (profile.phone && data.session && data.user) {
        await supabase
          .from("profiles")
          .update({ phone: profile.phone.trim() })
          .eq("id", data.user.id);
      }

      // With email confirmation on, Supabase returns a user but no session.
      return { needsConfirmation: !data.session };
    },
    []
  );

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
      signInWithEmail,
      verifyMfaCode,
      signUpWithEmail,
      signOut,
    }),
    [
      session,
      initializing,
      needsMfaChallenge,
      signInWithEmail,
      verifyMfaCode,
      signUpWithEmail,
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
