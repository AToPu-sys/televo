import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, useColorScheme, View } from "react-native";
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
import { BanScreen } from "../src/components/BanScreen";
import { CallOverlay, MINIMIZED_BAR_BOTTOM } from "../src/components/CallOverlay";
import { PasscodeScreen } from "../src/components/PasscodeScreen";
import { ToastHost } from "../src/components/ToastHost";
import { ToastProvider } from "../src/hooks/useToast";
import { AppLockProvider, useAppLock } from "../src/hooks/useAppLock";
import { AuthProvider, useAuth } from "../src/hooks/useAuth";
import { useBanStatus } from "../src/hooks/useBanStatus";
import { CallManagerProvider, useCallManager } from "../src/hooks/useCallManager";
import { E2eeProvider } from "../src/hooks/useE2ee";
import { supabase } from "../src/lib/supabase";
import { usePresenceHeartbeat } from "../src/hooks/usePresence";
import { MessageNotificationsProvider } from "../src/hooks/useMessageNotifications";
import { usePushNotifications } from "../src/hooks/usePushNotifications";
import { ThemeProvider, useTheme } from "../src/hooks/useTheme";
import { useToast } from "../src/hooks/useToast";
import {
  installCrashReporter,
  recordError,
  setCrashContextScreen,
  uploadPendingCrashReports,
} from "../src/lib/crashReporter";

// Before anything else can throw.
installCrashReporter();

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
  const { session, initializing, needsMfaChallenge, recoveringPassword, user } = useAuth();
  const { isLocked, ready: appLockReady } = useAppLock();
  const { theme } = useTheme();
  const segments = useSegments();
  const router = useRouter();
  const { minimized } = useCallManager();
  const banStatus = useBanStatus(user?.id);
  useAuthDeepLinks();

  // Which screen a crash happened on, attached to every crash report.
  const screenPath = segments.join("/");
  useEffect(() => {
    setCrashContextScreen(screenPath || "/");
  }, [screenPath]);

  // Send reports left by a previous run, once the session (if any) has been
  // restored so they can be attributed — delayed so it never competes with
  // the first render.
  useEffect(() => {
    if (initializing) return;
    const timer = setTimeout(() => void uploadPendingCrashReports(), 4000);
    return () => clearTimeout(timer);
  }, [initializing]);

  useEffect(() => {
    if (initializing) return;

    const inAuthGroup = segments[0] === "(auth)";

    // A reset link opens a real session, so the generic "session ⇒ go to the
    // app" rule below would skip straight past the screen that exists to
    // replace the forgotten password. Hold on it until updatePassword clears
    // the flag.
    if (recoveringPassword) {
      // Indexed through a widened alias: expo-router types useSegments()'s
      // result as a 1-tuple for this route tree, so segments[1] is a type
      // error even though the router genuinely populates it at runtime for
      // a nested route like /(auth)/reset-password. Reading it as a plain
      // string[] keeps the (correct) runtime behaviour without asserting
      // anything false about the value itself.
      const path = segments as readonly string[];
      if (path[1] !== "reset-password") router.replace("/(auth)/reset-password");
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

  // A suspended account (user_moderation.banned_until — see
  // apply_support_ban) used to only surface as a generic "failed" red
  // bubble on the next message send, with no explanation and no way to
  // appeal. This replaces the whole app with the appeal screen instead,
  // the same way the lock screen below replaces it for a passcode —
  // nothing underneath can leak through a suspended session.
  if (session && user?.id && banStatus?.bannedUntil) {
    return (
      <BanScreen
        userId={user.id}
        reason={banStatus.bannedReason}
        permanent={new Date(banStatus.bannedUntil).getTime() > Date.now() + 1000 * 60 * 60 * 24 * 365 * 50}
        until={banStatus.bannedUntil}
      />
    );
  }

  return (
    <>
      <StatusBar style={theme.name === "dark" ? "light" : "dark"} />
      {/* 2026-09-29: while a call is minimized (CallOverlay's swipe-down
          widget), its green status bar renders inside a transparent Modal
          ABOVE this entire subtree — that Modal's own window has no idea
          what's underneath it, so without this the bar simply painted over
          whatever the current screen's header/content already had there
          (reported as "the green bar covers the chat header"). Real iOS
          apps never have this problem because the system itself is the one
          drawing that banner and pushing every app's own content down by
          its height. This is the same idea done manually: push the WHOLE
          navigator down by the bar's height so nothing underneath is ever
          covered, exactly like a real call-in-progress status bar. */}
      <View style={{ flex: 1, paddingTop: minimized ? MINIMIZED_BAR_BOTTOM : 0 }}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="auth/confirm" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="chat/[id]" options={{ headerShown: false }} />
          <Stack.Screen name="new-group" options={{ presentation: "modal" }} />
          <Stack.Screen name="find-friends" options={{ presentation: "modal" }} />
          <Stack.Screen name="privacy-security" options={{ presentation: "modal" }} />
          <Stack.Screen name="storage" options={{ presentation: "modal" }} />
          <Stack.Screen name="set-passcode" options={{ presentation: "modal" }} />
          <Stack.Screen name="two-factor" options={{ presentation: "modal" }} />
          <Stack.Screen name="privacy-last-seen" options={{ presentation: "modal" }} />
          <Stack.Screen name="blocked-users" options={{ presentation: "modal" }} />
          <Stack.Screen name="devices" options={{ presentation: "modal" }} />
          <Stack.Screen name="scan-qr-login" options={{ presentation: "fullScreenModal" }} />
          <Stack.Screen name="forward-message" options={{ presentation: "modal" }} />
          <Stack.Screen name="verify-safety-number" options={{ presentation: "modal" }} />
          <Stack.Screen name="edit-profile" options={{ presentation: "modal" }} />
          <Stack.Screen name="user-profile" options={{ presentation: "modal" }} />
          <Stack.Screen name="group-info" options={{ presentation: "modal" }} />
        </Stack>
      </View>
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
      {/* 2026-09-28: MfaChallengeScreen/PasscodeScreen used to render here as
          plain flex:1 siblings of <Stack> above, inside this Fragment. A
          Fragment has no layout of its own — React Native stacked <Stack>
          and whichever gate screen was active as two flex:1 children in the
          SAME implicit column (the outer GestureHandlerRootView's default
          flexDirection), splitting the screen HALF to the navigator and
          HALF to the gate instead of the gate covering the whole screen.
          That's the "Two-Step Verification only fills half the screen"
          report — and a plain absolutely-positioned View here did NOT fix
          it (still reported half-screen after that first attempt), because
          <Stack> renders its screens through react-native-screens as real
          native UIViewControllers, not plain React Native views — an
          ordinary sibling's position:absolute has no purchase against a
          navigator with its own native surface. A real Modal, like
          CallOverlay already uses for exactly this reason, renders in its
          own separate native window and is guaranteed to cover the whole
          screen regardless of what the navigator is doing underneath. */}
      {/* 2026-09-28, second fix: MFA verifying successfully with a passcode
          also configured used to hand off from the Modal above straight into
          a SEPARATE `<Modal visible>` for PasscodeScreen. Two distinct
          <Modal> elements each mount/unmount their own native UIKit window;
          swapping one for the other in the same React commit closes window A
          and opens window B as two independent, asynchronous native
          transitions, not one atomic swap. With animationType="none" there's
          no crossfade to hide the gap, so whenever B's presentation lagged
          even slightly behind A's dismissal, the app's bare root window (no
          backgroundColor of its own) painted through — a black screen with
          nothing left to trigger a repaint, since no further state change
          follows. A single persistent <Modal> whose CONTENT switches never
          closes the native window at all, so there's no gap for black to
          show through.

          2026-09-28, third fix: collapsing to one Modal killed the
          MFA→Passcode gap, but the SAME symptom reappeared on ordinary
          Face-ID unlock (unlockWithBiometrics/unlockWithPasscode flips
          isLocked false with no MFA involved), because `visible` itself
          still goes true→false in one commit, i.e. this Modal's own native
          window is still being torn down. animationType="none" tells UIKit
          to skip its normal dismissal transition entirely — that's a
          same-frame instant cut, not a guarantee the presenting view
          controller (the Stack underneath) has a composited frame ready
          the INSTANT the cut happens, and on this device that gap painted
          as black with nothing left to trigger a repaint. animationType
          "fade" makes UIKit run its own real crossfade transition instead
          of an instant cut, so there's no longer a frame where neither
          layer is drawn — the fade itself bridges the gap. */}
      <Modal
        visible={!!((session && needsMfaChallenge && !recoveringPassword) || (session && isLocked))}
        transparent={false}
        animationType="fade"
        statusBarTranslucent
      >
        {session && needsMfaChallenge && !recoveringPassword ? (
          <MfaChallengeScreen />
        ) : session && isLocked ? (
          // Renders above everything, including the call overlay — a locked
          // phone should never leak a call's peer name or content.
          <PasscodeScreen />
        ) : null}
      </Modal>
    </>
  );
}

/** Renders the ringing/active call UI above whatever screen is on top,
 * regardless of which chat (if any) triggered or received the call. */
function GlobalCallOverlay() {
  const {
    state,
    mediaConfirmed,
    reconnecting,
    quality,
    peer,
    muted,
    cameraOff,
    peerCameraOff,
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
    minimized,
    setMinimized,
  } = useCallManager();
  const { user } = useAuth();

  // The user's OWN name/avatar — needed only for the camera-off cover shown
  // over their own self-preview (see CallOverlay's myCameraOff handling).
  // Fetched here rather than added to useCall/useCallManager's own state
  // because it never changes mid-call and has nothing to do with call
  // signaling — it's the same one-shot profile lookup every other screen in
  // this app does directly against the profiles table.
  const [myProfile, setMyProfile] = useState<{ name: string; avatarUrl: string | null } | null>(null);
  useEffect(() => {
    if (state.phase === "idle" || !user) return;
    let cancelled = false;
    void supabase
      .from("profiles")
      .select("display_name, avatar_url")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data) return;
        setMyProfile({ name: data.display_name, avatarUrl: data.avatar_url });
      });
    return () => {
      cancelled = true;
    };
  }, [state.phase, user]);

  // Unmounting this subtree destroys WebRtcBridge, and the bridge's unmount
  // cleanup calls releaseMedia() — which closes the peer connection, stops
  // the mic/camera, runs enableWebRtcAudio(false) and kills the audio
  // watchdog. Doing that for a call that is still live is a mid-call kill
  // switch: the user hears roughly a second of audio and then silence, with
  // the connection apparently still up.
  //
  // `peer` is React state written asynchronously (setPeer in
  // useCallManager's handleIncoming, cleared when the phase returns to
  // idle), so it can legitimately be null for a render or two while a call
  // is already in a non-idle phase — e.g. between the call row arriving and
  // the peer profile resolving. Keying the unmount on `!peer` therefore tore
  // the media engine down at exactly the wrong moment.
  //
  // Phase alone decides whether a call exists. A missing peer only means the
  // header has no name/avatar to show yet, which CallOverlay already handles.
  if (state.phase === "idle") return null;

  const isVideo =
    (state.phase !== "ended" && "call" in state && state.call.kind === "video") || false;

  return (
    <CallOverlay
      state={state}
      mediaConfirmed={mediaConfirmed}
      reconnecting={reconnecting}
      quality={quality}
      peerName={peer?.name ?? ""}
      peerAvatarUrl={peer?.avatarUrl ?? null}
      myName={myProfile?.name ?? ""}
      myAvatarUrl={myProfile?.avatarUrl ?? null}
      muted={muted}
      cameraOff={cameraOff}
      peerCameraOff={peerCameraOff}
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
      minimized={minimized}
      onMinimizedChange={setMinimized}
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

/**
 * Shown instead of the app when rendering throws. Without it, a render error
 * anywhere is an unhandled JS exception, which aborts a release build
 * outright. Deliberately uses no providers (ThemeProvider etc. may be what
 * failed) — plain colors from the system scheme only.
 */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  const dark = useColorScheme() === "dark";
  useEffect(() => {
    recordError(error, false);
  }, [error]);
  return (
    <View style={[errorStyles.container, { backgroundColor: dark ? "#0E1621" : "#FFFFFF" }]}>
      <Text style={[errorStyles.title, { color: dark ? "#FFFFFF" : "#000000" }]}>Something went wrong</Text>
      <Text style={[errorStyles.body, { color: dark ? "#A0A9B4" : "#707579" }]}>
        This screen ran into a problem. Your messages are safe — try again.
      </Text>
      <Pressable
        onPress={() => void retry()}
        style={errorStyles.button}
        accessibilityRole="button"
      >
        <Text style={errorStyles.buttonText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const errorStyles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  title: { fontSize: 20, fontWeight: "700" },
  body: { fontSize: 15, textAlign: "center", lineHeight: 21 },
  button: { marginTop: 12, backgroundColor: "#3390EC", paddingHorizontal: 28, paddingVertical: 12, borderRadius: 12 },
  buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
});

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
