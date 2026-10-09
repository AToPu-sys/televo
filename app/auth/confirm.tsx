import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../../src/hooks/useTheme";
import { useToast } from "../../src/hooks/useToast";
import { supabase } from "../../src/lib/supabase";

/**
 * Real route for the Universal Link every confirmation/magic-link/reset
 * email points at (https://gettelevo.space/auth/confirm, set via
 * emailRedirectTo in useAuth.tsx). Without an actual file at this path,
 * opening the link handed the URL to BOTH this app's own Linking listener
 * (app/_layout.tsx's useAuthDeepLinks, which reads the token out of the
 * fragment) AND expo-router's own automatic navigation for the same URL —
 * and router's Unmatched Route screen rendered over whatever the listener
 * was doing, because nothing told it this was a real screen. The token
 * parsing/sign-in logic itself already existed and worked in
 * useAuthDeepLinks; this screen just gives the router something real to
 * land on while that happens, instead of racing it.
 */
export default function AuthConfirmScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { show } = useToast();
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const handled = useRef(false);

  useEffect(() => {
    // useAuthDeepLinks (app/_layout.tsx) already parsed this exact URL and
    // called setSession — by the time THIS screen mounts, the session (or
    // the error toast) is usually already in flight. This effect exists only
    // to move off this screen once that resolves, and as a fallback in case
    // this screen was reached some other way (e.g. a stale bookmark) with no
    // listener having run at all.
    if (handled.current) return;
    handled.current = true;

    const timeout = setTimeout(() => {
      supabase.auth.getSession().then(({ data }) => {
        if (data.session) {
          setState("done");
          router.replace("/");
        } else {
          setState("error");
          show({
            kind: "error",
            message: "This link didn't sign you in",
            detail: "It may have expired. Enter the 6-digit code from the same email instead, or request a new one.",
          });
          router.replace("/(auth)/sign-in");
        }
      });
      // Gives useAuthDeepLinks' own async setSession call a head start —
      // it's listening on the exact same URL and usually wins well before
      // this fires.
    }, 1200);

    return () => clearTimeout(timeout);
  }, [router, show]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      {state === "working" ? (
        <>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={[styles.text, { color: theme.textSecondary }]}>Signing you in…</Text>
        </>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  text: { fontSize: 15 },
});
