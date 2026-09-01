import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { CallOverlay } from "../src/components/CallOverlay";
import { AuthProvider, useAuth } from "../src/hooks/useAuth";
import { CallManagerProvider, useCallManager } from "../src/hooks/useCallManager";
import { ThemeProvider, useTheme } from "../src/hooks/useTheme";

function RootNavigator() {
  const { session, initializing } = useAuth();
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
      </Stack>
      {session ? <GlobalCallOverlay /> : null}
    </>
  );
}

/** Renders the ringing/active call UI above whatever screen is on top,
 * regardless of which chat (if any) triggered or received the call. */
function GlobalCallOverlay() {
  const {
    state,
    peer,
    localStream,
    remoteStream,
    muted,
    cameraOff,
    accept,
    decline,
    hangup,
    toggleMute,
    toggleCamera,
    reset,
  } = useCallManager();

  if (state.phase === "idle" || !peer) return null;

  const isVideo =
    (state.phase !== "ended" && "call" in state && state.call.kind === "video") || false;

  return (
    <CallOverlay
      state={state}
      peerName={peer.name}
      peerAvatarUrl={peer.avatarUrl}
      localStream={localStream}
      remoteStream={remoteStream}
      muted={muted}
      cameraOff={cameraOff}
      isVideo={isVideo}
      onAccept={accept}
      onDecline={decline}
      onHangup={hangup}
      onToggleMute={toggleMute}
      onToggleCamera={toggleCamera}
      onDismissEnded={reset}
    />
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AuthProvider>
            <CallManagerProvider>
              <RootNavigator />
            </CallManagerProvider>
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
