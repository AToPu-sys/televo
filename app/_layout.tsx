import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import MfaChallengeScreen from "./mfa-challenge";
import { CallOverlay } from "../src/components/CallOverlay";
import { PasscodeScreen } from "../src/components/PasscodeScreen";
import { AppLockProvider, useAppLock } from "../src/hooks/useAppLock";
import { AuthProvider, useAuth } from "../src/hooks/useAuth";
import { CallManagerProvider, useCallManager } from "../src/hooks/useCallManager";
import { E2eeProvider } from "../src/hooks/useE2ee";
import { usePresenceHeartbeat } from "../src/hooks/usePresence";
import { ThemeProvider, useTheme } from "../src/hooks/useTheme";

function RootNavigator() {
  const { session, initializing, needsMfaChallenge } = useAuth();
  const { isLocked } = useAppLock();
  const { theme } = useTheme();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (initializing) return;

    const inAuthGroup = segments[0] === "(auth)";

    if (!session && !inAuthGroup) {
      router.replace("/(auth)/welcome");
    } else if (session && inAuthGroup) {
      router.replace("/(tabs)/chats");
    }
  }, [session, initializing, segments, router]);

  if (initializing) {
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
      </Stack>
      {session ? <GlobalCallOverlay /> : null}
      {/* MFA gate takes priority: at AAL1 every RLS-checked query fails
          anyway, so nothing behind it can do anything useful yet. */}
      {session && needsMfaChallenge ? (
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
    peer,
    muted,
    cameraOff,
    accept,
    decline,
    hangup,
    toggleMute,
    toggleCamera,
    reset,
    setBridgeRef,
    handleBridgeEvent,
  } = useCallManager();

  if (state.phase === "idle" || !peer) return null;

  const isVideo =
    (state.phase !== "ended" && "call" in state && state.call.kind === "video") || false;

  return (
    <CallOverlay
      state={state}
      peerName={peer.name}
      peerAvatarUrl={peer.avatarUrl}
      muted={muted}
      cameraOff={cameraOff}
      isVideo={isVideo}
      onBridgeReady={setBridgeRef}
      onBridgeEvent={handleBridgeEvent}
      onAccept={accept}
      onDecline={decline}
      onHangup={hangup}
      onToggleMute={toggleMute}
      onToggleCamera={toggleCamera}
      onDismissEnded={reset}
    />
  );
}

function AuthedProviders({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  usePresenceHeartbeat(user?.id);
  return (
    <E2eeProvider userId={user?.id}>
      <CallManagerProvider>{children}</CallManagerProvider>
    </E2eeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AppLockProvider>
            <AuthProvider>
              <AuthedProviders>
                <RootNavigator />
              </AuthedProviders>
            </AuthProvider>
          </AppLockProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
