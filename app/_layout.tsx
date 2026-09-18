import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

// The OS banner/sound are suppressed here while the app is FOREGROUNDED —
// not because notifications should be silent (the opposite: message pushes
// must always be felt), but because useMessageNotifications
// (src/hooks/useMessageNotifications.tsx) now owns that experience while the
// app is open: a short chime always, plus Telegram's own in-app banner (only
// for a chat other than the one already on screen — no banner AND no
// duplicate sound for the chat you're already looking at, since the message
// is about to appear in the list via Realtime anyway). Letting the OS ALSO
// show its own banner and play its own sound here would double both for
// every foreground message. This handler only runs while the app is alive to
// receive the notification at all — backgrounded/killed still gets the
// normal OS notification tray entry, entirely outside this code path.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: true,
    shouldShowBanner: false,
    shouldShowList: false,
  }),
});

import MfaChallengeScreen from "./mfa-challenge";
import { CallOverlay } from "../src/components/CallOverlay";
import { PasscodeScreen } from "../src/components/PasscodeScreen";
import { ToastHost } from "../src/components/ToastHost";
import { ToastProvider } from "../src/hooks/useToast";
import { AppLockProvider, useAppLock } from "../src/hooks/useAppLock";
import { AuthProvider, useAuth } from "../src/hooks/useAuth";
import { CallManagerProvider, useCallManager } from "../src/hooks/useCallManager";
import { E2eeProvider } from "../src/hooks/useE2ee";
import { supabase } from "../src/lib/supabase";
import { usePresenceHeartbeat } from "../src/hooks/usePresence";
import { MessageNotificationsProvider } from "../src/hooks/useMessageNotifications";
import { usePushNotifications } from "../src/hooks/usePushNotifications";
import { ThemeProvider, useTheme } from "../src/hooks/useTheme";
import { useToast } from "../src/hooks/useToast";

/**
 * Handles the magic-link email Supabase sends for sign-in's second factor
 * (sendEmailCode in useAuth) and for password recovery. Both land here as a
 * `televo://` deep link — the same scheme this app registers in app.json —
 * carrying the session tokens (or an error) in the URL fragment after `#`.
 *
 * Without this, tapping the link in the email did nothing useful: Expo
 * Router has no screen registered for a bare `televo://` with no path, so it
 * rendered its "Unmatched Route" screen, and the token inside the link was
 * never consumed — a dead end indistinguishable from the link being broken,
 * which is exactly what a `otp_expired` link in the same shape looks like.
 * Supabase's own magic-link template links to `{{ .ConfirmationURL }}`
 * only — it has no code fallback on the free tier's default mailer, which
 * cannot have its templates edited — so correctly consuming this link is
 * the ONLY way this flow can ever complete from the emailed message.
 */
/** Fully un-escapes a URL that may have been percent-encoded more than once.
 *
 * A mail client, an in-app browser, or a link-wrapping service (Gmail's own
 * link shield is one) can each re-escape a URL it merely passes through,
 * stacking encodings — "#" seen in the wild as "%2523" (encoded TWICE: "%25"
 * is "%" itself encoded, so "%2523" is "#" encoded, then that whole result
 * encoded again). A single decodeURIComponent() only peels one layer, so a
 * link that picked up two or three layers of re-escaping on its way through
 * whatever forwarded it was left completely unparseable — silently falling
 * through to Expo Router's raw "Unmatched Route" screen with no toast,
 * indistinguishable from the app being broken. Decoding is repeated until a
 * pass changes nothing (fully unescaped) or throws (malformed — use the last
 * good result), with a hard cap so a pathological input can't loop forever. */
function fullyDecodeUri(value: string): string {
  let current = value;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

function parseAuthCallbackParams(url: string): URLSearchParams | null {
  const decoded = fullyDecodeUri(url);
  // Supabase puts the params after `#` for an implicit-grant link (what
  // magic-link/recovery use); some links use `?` instead. Searching in the
  // FULLY decoded string means any depth of prior re-escaping (see
  // fullyDecodeUri above) no longer matters — by this point "#" reads as a
  // literal "#" regardless of how many layers of %25.. it arrived wrapped
  // in.
  const hashIndex = decoded.indexOf("#");
  const queryIndex = decoded.indexOf("?");
  const paramsStart = hashIndex !== -1 ? hashIndex + 1 : queryIndex !== -1 ? queryIndex + 1 : -1;
  if (paramsStart === -1) return null;
  return new URLSearchParams(decoded.slice(paramsStart));
}

function useAuthDeepLinks() {
  const { show } = useToast();
  const router = useRouter();

  useEffect(() => {
    const handleUrl = async (url: string) => {
      // Accepts both the legacy televo:// custom-scheme link (still sent by
      // any auth email a user's mail client had already cached/prefetched
      // before this build shipped) and the https://gettelevo.space/auth/*
      // Universal Link that replaces it going forward — see
      // sendPasswordReset's comment in useAuth.tsx for why the switch. Both
      // carry the same access_token/refresh_token/error_description shape
      // after the URL's fragment or query string, so everything past this
      // check is identical for either form.
      const isLegacyScheme = url.startsWith("televo://");
      const isUniversalLink = url.startsWith("https://gettelevo.space/auth/");
      if (!isLegacyScheme && !isUniversalLink) return;
      const params = parseAuthCallbackParams(url);
      if (!params) return;

      const errorDescription = params.get("error_description");
      if (errorDescription) {
        // otp_expired is the common case: the code from the SAME email
        // already completed sign-in (or simply took too long), and the
        // user tapped the link afterwards out of habit. Surfacing this
        // instead of silently landing on Unmatched Route is the whole
        // point of handling this link at all.
        show({
          kind: "error",
          message: "This sign-in link has expired",
          detail: "Enter the 6-digit code from the same email instead, or request a new one.",
        });
        // Opening this link is what NAVIGATES to it in the first place —
        // televo:// has no path segment Expo Router recognizes, so simply
        // showing the toast above left the user stranded on Router's raw
        // "Unmatched Route" screen underneath it, with no way back except
        // force-quitting the app. Sending them back to sign-in is what the
        // toast's advice ("enter the code instead") actually needs a live
        // screen to act on.
        router.replace("/(auth)/sign-in");
        return;
      }

      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (error) {
          show({ kind: "error", message: "Couldn't sign in from this link", detail: error.message });
        }
        // On success, onAuthStateChange's SIGNED_IN fires from setSession
        // itself and RootNavigator's redirect takes it from there.
      }
    };

    Linking.getInitialURL().then((url) => {
      if (url) void handleUrl(url);
    });
    const subscription = Linking.addEventListener("url", ({ url }) => void handleUrl(url));
    return () => subscription.remove();
  }, [show]);
}

function RootNavigator() {
  const { session, initializing, needsMfaChallenge, recoveringPassword } = useAuth();
  const { isLocked, ready: appLockReady } = useAppLock();
  const { theme } = useTheme();
  const segments = useSegments();
  const router = useRouter();
  useAuthDeepLinks();

  useEffect(() => {
    if (initializing) return;

    const inAuthGroup = segments[0] === "(auth)";

    // A reset link opens a real session, so the generic "session ⇒ go to the
    // app" rule below would skip straight past the screen that exists to
    // replace the forgotten password. Hold on it until updatePassword clears
    // the flag.
    if (recoveringPassword) {
      if (segments[1] !== "reset-password") router.replace("/(auth)/reset-password");
      return;
    }

    if (!session && !inAuthGroup) {
      router.replace("/(auth)/welcome");
    } else if (session && inAuthGroup) {
      router.replace("/(tabs)/chats");
    }
  }, [session, initializing, recoveringPassword, segments, router]);

  // Also gate on appLockReady: isLocked starts false and only flips true
  // once the SecureStore check for a configured passcode resolves. Without
  // this, a device WITH a passcode set could show its real screens,
  // unprotected, for the brief window between auth finishing and that check
  // landing — the exact case the `ready` flag exists to prevent.
  if (initializing || !appLockReady) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.background,
        }}
      >
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  return (
    <>
      <StatusBar style={theme.name === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="chat/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="new-group" options={{ presentation: "modal" }} />
        <Stack.Screen name="find-friends" options={{ presentation: "modal" }} />
        <Stack.Screen name="privacy-security" options={{ presentation: "modal" }} />
        <Stack.Screen name="set-passcode" options={{ presentation: "modal" }} />
        <Stack.Screen name="two-factor" options={{ presentation: "modal" }} />
        <Stack.Screen name="privacy-last-seen" options={{ presentation: "modal" }} />
        <Stack.Screen name="blocked-users" options={{ presentation: "modal" }} />
        <Stack.Screen name="forward-message" options={{ presentation: "modal" }} />
        <Stack.Screen name="verify-safety-number" options={{ presentation: "modal" }} />
        <Stack.Screen name="edit-profile" options={{ presentation: "modal" }} />
        <Stack.Screen name="user-profile" options={{ presentation: "modal" }} />
      </Stack>
      {session ? <GlobalCallOverlay /> : null}
      {/* Above the call overlay so a failure during a call is still visible,
          but rendered before the lock/MFA gates below — a toast can carry a
          sender's name or message text, which must never appear over a
          locked phone. */}
      {!isLocked && !needsMfaChallenge ? <ToastHost /> : null}
      {/* MFA gate takes priority: at AAL1 every RLS-checked query fails
          anyway, so nothing behind it can do anything useful yet. Excludes
          recoveringPassword: opening a reset link on an account with TOTP
          Two-Step Verification enabled also opens a real (AAL1) session,
          which checkMfaLevel (useAuth.tsx) sees exactly like a normal
          sign-in and flags needsMfaChallenge. Without this exclusion,
          MfaChallengeScreen rendered ON TOP of the reset-password screen the
          navigation effect above had already routed to — demanding an
          authenticator code before a user could even reach the form that
          exists to let them back in without one. Forgetting a password and
          not having the authenticator device handy are correlated, not
          independent, so gating recovery on MFA defeats the point of
          recovery. Worse, the only escape from that stuck screen was "Sign
          out instead", which clears the session but NOT recoveringPassword
          (only updatePassword does) — leaving the user stranded on
          reset-password with no session, and a submit that fails with no
          way back to sign-in. Two-Step Verification stays meaningful here
          because updatePassword still requires the reset link's token to
          have been valid in the first place; this only removes a second,
          redundant gate the recovery flow was never designed to need. */}
      {session && needsMfaChallenge && !recoveringPassword ? (
        <MfaChallengeScreen />
      ) : session && isLocked ? (
        // Renders above everything, including the call overlay — a locked
        // phone should never leak a call's peer name or content.
        <PasscodeScreen />
      ) : null}
    </>
  );
}

/** Renders the ringing/active call UI above whatever screen is on top,
 * regardless of which chat (if any) triggered or received the call. */
function GlobalCallOverlay() {
  const {
    state,
    mediaConfirmed,
    peer,
    muted,
    cameraOff,
    speakerOn,
    accept,
    decline,
    hangup,
    toggleMute,
    toggleCamera,
    switchCamera,
    toggleSpeaker,
    reset,
    setBridgeRef,
    handleBridgeEvent,
    getDiagnosticsReport,
  } = useCallManager();

  if (state.phase === "idle" || !peer) return null;

  const isVideo =
    (state.phase !== "ended" && "call" in state && state.call.kind === "video") || false;

  return (
    <CallOverlay
      state={state}
      mediaConfirmed={mediaConfirmed}
      peerName={peer.name}
      peerAvatarUrl={peer.avatarUrl}
      muted={muted}
      cameraOff={cameraOff}
      speakerOn={speakerOn}
      isVideo={isVideo}
      onBridgeReady={setBridgeRef}
      onBridgeEvent={handleBridgeEvent}
      onAccept={accept}
      onDecline={decline}
      onHangup={hangup}
      onToggleMute={toggleMute}
      onToggleCamera={toggleCamera}
      onSwitchCamera={switchCamera}
      onToggleSpeaker={toggleSpeaker}
      onDismissEnded={reset}
      getDiagnosticsReport={getDiagnosticsReport}
    />
  );
}

function AuthedProviders({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  usePresenceHeartbeat(user?.id);
  usePushNotifications(user?.id);
  return (
    <E2eeProvider userId={user?.id}>
      <CallManagerProvider>
        <MessageNotificationsProvider>{children}</MessageNotificationsProvider>
      </CallManagerProvider>
    </E2eeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          {/* Above AuthProvider so the sign-in and password-reset screens,
              which are the ones most likely to need to report a failure, can
              raise toasts too. */}
          <ToastProvider>
            <AppLockProvider>
              <AuthProvider>
                <AuthedProviders>
                  <RootNavigator />
                </AuthedProviders>
              </AuthProvider>
            </AppLockProvider>
          </ToastProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
