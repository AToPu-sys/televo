import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { PRIVACY_URL, TERMS_URL } from "../../src/lib/legal";
import { validatePassword } from "../../src/lib/password";
import { isPlausiblePhone } from "../../src/lib/phone";
import { checkUsername, quickUsernameProblem, usernameProblemMessage } from "../../src/lib/username";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { useAuth } from "../../src/hooks/useAuth";
import { useTheme } from "../../src/hooks/useTheme";
import { spacing } from "../../src/theme";

/** Translates a raw Supabase Auth error into what actually happened and, where
 * there is one, the way out — shared by every call site that can throw one of
 * these (handleSubmit's password/code/signup submission, and
 * handleResendCode's resend), so a rate limit hit while resending a code
 * reads the same "wait a minute" message as one hit on the original attempt,
 * rather than the resend path showing Supabase's raw GoTrue text instead. */
function describeAuthError(caught: unknown, awaitingEmailCode: boolean): string {
  const raw = caught instanceof Error ? caught.message : "Something went wrong.";
  // One account per phone number and per email is enforced by a unique
  // index on profiles.phone and by Supabase Auth respectively, but both
  // surface as raw database/API text ("duplicate key value violates unique
  // constraint ...") that means nothing to a user and reads like a crash.
  // Translate them into the actual situation and the way out.
  const lowered = raw.toLowerCase();
  // OTP failures come back as raw GoTrue text ("Token has expired or is
  // invalid"), which reads like a crash rather than "check the code".
  if (awaitingEmailCode && (lowered.includes("token") || lowered.includes("otp"))) {
    return "That code is wrong or has expired. Check your email, or start over.";
  }
  if (lowered.includes("rate limit") || lowered.includes("too many")) {
    return "Too many attempts. Wait a minute before trying again.";
  }
  // GoTrue's own text for auth.users.banned_until being in the future — the
  // same mechanism delete_own_account() sets permanently (063_soft_delete_account.sql),
  // so this is the message a deleted account's owner sees if they try to
  // sign back in. Also covers a moderation suspension, which uses the same
  // column via a different path.
  if (lowered.includes("banned")) {
    return "This account is no longer available.";
  }
  if (lowered.includes("phone") && lowered.includes("duplicate")) {
    return "That phone number is already used by another account. Sign in instead, or use a different number.";
  }
  if (
    lowered.includes("already registered") ||
    lowered.includes("already been registered") ||
    (lowered.includes("email") && lowered.includes("duplicate"))
  ) {
    return "An account with this email already exists. Sign in instead, or reset your password.";
  }
  return raw;
}

// App Review accounts sign in with password only: Apple's reviewers can't
// receive the emailed code, and an app they can't sign into is an automatic
// rejection (Guideline 2.1). Exactly these two addresses, each with a long
// random password; every other account keeps the email-code second step.
const PASSWORD_ONLY_REVIEW_ACCOUNTS = new Set([
  "appreview1@gettelevo.space",
  "appreview2@gettelevo.space",
]);

export default function SignInScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const {
    signInWithEmail,
    signUpWithEmail,
    resendConfirmation,
    verifyPasswordOnly,
    sendEmailCode,
    verifyEmailCode,
  } = useAuth();

  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only offered once a confirmation mail was actually sent to this address —
  // otherwise the button promises a resend of something that never existed.
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  // Email-code step. The code is demanded BEFORE any session exists: asking
  // for it after signInWithPassword would be theatre, since a valid password
  // would already have produced a session an attacker could use.
  const [awaitingEmailCode, setAwaitingEmailCode] = useState(false);
  const [emailCode, setEmailCode] = useState("");

  const isSignUp = mode === "sign-up";

  async function handleResend() {
    setError(null);
    setBusy(true);
    try {
      await resendConfirmation(email);
      setNotice(`Confirmation link sent again to ${email.trim()}. Check your spam folder too.`);
    } catch (caught) {
      setError(describeAuthError(caught, false));
    } finally {
      setBusy(false);
    }
  }

  /** Re-sends the sign-in code, for the awaitingEmailCode step specifically.
   * Before this, the ONLY option once the code's email was lost, mistyped
   * into, or simply took too long to arrive was "Use a different account" —
   * which discards the whole sign-in and starts over from email+password,
   * not a real resend. resendConfirmation (above) can't be reused here: it
   * calls supabase.auth.resend({ type: "signup" }), which only exists for
   * an unconfirmed signup — this step is a normal sign-in's second factor,
   * so it goes back through sendEmailCode, the same call that sent the
   * first one. */
  async function handleResendCode() {
    setError(null);
    setBusy(true);
    try {
      await sendEmailCode(email);
      setEmailCode("");
      setNotice(`Sent a new code to ${email.trim()}.`);
    } catch (caught) {
      setError(describeAuthError(caught, true));
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit() {
    setError(null);
    setNotice(null);

    if (awaitingEmailCode) {
      if (emailCode.trim().length < 6) {
        setError("Enter the 6-digit code from your email.");
        return;
      }
    } else if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }
    // Sign-up previously accepted any non-empty password — see
    // src/lib/password.ts for why that was the weakest link in the whole
    // security model.
    if (isSignUp) {
      const passwordError = validatePassword(password);
      if (passwordError) {
        setError(passwordError);
        return;
      }
    }
    if (isSignUp) {
      const quick = quickUsernameProblem(username);
      if (quick) {
        setError(usernameProblemMessage(quick));
        return;
      }
    }
    // Required at signup, not optional: it's the only thing that lets a
    // friend find this account via their phone's contacts (useContactDiscovery)
    // instead of the app exposing an open directory of every user — the
    // previous "browse everyone" contacts tab this replaces.
    if (isSignUp && !isPlausiblePhone(phone)) {
      setError("A phone number is required — it's how friends find you.");
      return;
    }

    setBusy(true);
    try {
      if (isSignUp) {
        // Offensive/reserved/taken are only known server-side. Checked before
        // signUp because a rejected username inside the sign-up trigger
        // surfaces from GoTrue as an opaque "Database error saving new user".
        const problem = await checkUsername(username);
        if (problem) {
          setError(usernameProblemMessage(problem));
          return;
        }
        const { needsConfirmation } = await signUpWithEmail(email, password, {
          username: username.trim(),
          displayName: displayName.trim() || username.trim(),
          phone: phone.trim(),
        });
        if (needsConfirmation) {
          setNotice(
            `We've sent a confirmation link to ${email.trim()}. Open it on this device to verify your account, then come back here and sign in.`
          );
          setAwaitingConfirmation(true);
          setMode("sign-in");
        }
      } else if (awaitingEmailCode) {
        // Second step: the emailed code is what actually creates the session.
        await verifyEmailCode(email, emailCode);
      } else if (PASSWORD_ONLY_REVIEW_ACCOUNTS.has(email.trim().toLowerCase())) {
        await signInWithEmail(email, password);
      } else {
        // First step: prove the password is right, then immediately drop that
        // session and require the mailbox too. verifyPassword signs in and
        // signs straight back out, so a correct password on its own never
        // leaves a usable session behind.
        await verifyPasswordOnly(email, password);
        await sendEmailCode(email);
        setAwaitingEmailCode(true);
        setNotice(`We sent a 6-digit code to ${email.trim()}. Enter it to finish signing in.`);
      }
      // On success the root navigator redirects; nothing to do here.
    } catch (caught) {
      setError(describeAuthError(caught, awaitingEmailCode));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            style={styles.back}
            hitSlop={12}
          >
            <Ionicons name="chevron-back" size={26} color={theme.accent} />
          </Pressable>

          <Text style={[styles.title, { color: theme.text }]}>
            {isSignUp ? "Create account" : "Welcome back"}
          </Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            {isSignUp
              ? "Pick a username your friends can find you by."
              : "Sign in with your email and password."}
          </Text>

          <View style={styles.form}>
            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              placeholder="you@example.com"
            />
            {!awaitingEmailCode ? (
              <TextField
                label="Password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoComplete={isSignUp ? "new-password" : "current-password"}
                placeholder="••••••••"
              />
            ) : (
              <TextField
                label="Email code"
                value={emailCode}
                onChangeText={setEmailCode}
                keyboardType="number-pad"
                autoComplete="one-time-code"
                placeholder="123456"
                hint="Check your inbox — the code expires shortly."
              />
            )}

            {isSignUp ? (
              <>
                <TextField
                  label="Username"
                  value={username}
                  onChangeText={setUsername}
                  autoCapitalize="none"
                  placeholder="jane_doe"
                  hint="3–24 characters. Letters, numbers, underscore, dot."
                />
                <TextField
                  label="Display name"
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder="Jane Doe"
                  hint="Optional — defaults to your username."
                />
                <TextField
                  label="Phone number"
                  value={phone}
                  onChangeText={setPhone}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  placeholder="+1 415 555 2671"
                  hint="Required — lets friends find you from their contacts, and is never shown to anyone who doesn't already have it saved."
                />
              </>
            ) : null}

            {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
            {notice ? (
              <Text style={[styles.notice, { color: theme.accent }]}>{notice}</Text>
            ) : null}

            {/* App Review requires an explicit agreement to terms for apps
                with user-generated content (Guideline 1.2), and the privacy
                policy has to be reachable from inside the app. */}
            {isSignUp ? (
              <Text style={[styles.legal, { color: theme.textSecondary }]}>
                By creating an account you agree to the{" "}
                <Text
                  style={[styles.legalLink, { color: theme.accent }]}
                  onPress={() => Linking.openURL(TERMS_URL)}
                  accessibilityRole="link"
                >
                  Terms of Service
                </Text>{" "}
                and{" "}
                <Text
                  style={[styles.legalLink, { color: theme.accent }]}
                  onPress={() => Linking.openURL(PRIVACY_URL)}
                  accessibilityRole="link"
                >
                  Privacy Policy
                </Text>
                , including a zero-tolerance policy for abusive content.
              </Text>
            ) : null}

            <Button
              title={
                isSignUp ? "Create account" : awaitingEmailCode ? "Verify and sign in" : "Continue"
              }
              onPress={handleSubmit}
              loading={busy}
            />
            {awaitingEmailCode ? (
              <>
                <Button
                  title="Resend code"
                  variant="ghost"
                  onPress={() => void handleResendCode()}
                  loading={busy}
                />
                <Button
                  title="Use a different account"
                  variant="ghost"
                  onPress={() => {
                    setAwaitingEmailCode(false);
                    setEmailCode("");
                    setNotice(null);
                    setError(null);
                  }}
                />
              </>
            ) : null}
            {!isSignUp ? (
              <Button
                title="Forgot password?"
                variant="ghost"
                onPress={() => router.push("/(auth)/forgot-password")}
              />
            ) : null}
            {awaitingConfirmation && !isSignUp ? (
              <Button
                title="Resend confirmation email"
                variant="ghost"
                onPress={handleResend}
                loading={busy}
              />
            ) : null}
            <Button
              title={isSignUp ? "I already have an account" : "Create a new account"}
              variant="ghost"
              onPress={() => {
                setMode(isSignUp ? "sign-in" : "sign-up");
                setError(null);
                setNotice(null);
              }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  content: { padding: spacing.xl, gap: spacing.sm },
  back: { alignSelf: "flex-start", marginBottom: spacing.md },
  title: { fontSize: 28, fontWeight: "700" },
  subtitle: { fontSize: 15, marginBottom: spacing.lg },
  form: { gap: spacing.lg },
  error: { fontSize: 14 },
  notice: { fontSize: 14 },
  legal: { fontSize: 12, lineHeight: 17 },
  legalLink: { textDecorationLine: "underline" },
});
