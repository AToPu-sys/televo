import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";

import { supabase } from "../lib/supabase";

/**
 * Registers this device for push notifications and stores the Expo push
 * token server-side. IMPORTANT: remote push notifications are unavailable in
 * Expo Go on Android from SDK 53 onward (Expo's own restriction, not
 * something this code can work around) — a custom dev build is required
 * there. iOS in Expo Go is not restricted the same way. This hook is safe to
 * call on either platform: it simply fails to get a token in the
 * unsupported case and does nothing further, rather than crashing.
 */
export function usePushNotifications(userId: string | undefined) {
  const router = useRouter();

  // Tapping a notification only ever brought the app to whatever screen it
  // was already showing — nothing read the tap and navigated to the chat it
  // was about. The Edge Function already sends `data: { conversationId }`
  // (see supabase/functions/send-push-notification/index.ts) specifically
  // for this.
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const conversationId = response.notification.request.content.data?.conversationId;
      if (typeof conversationId === "string") {
        router.push(`/chat/${conversationId}`);
      }
    });
    return () => subscription.remove();
  }, [router]);

  useEffect(() => {
    if (!userId) return;
    if (!Device.isDevice) return; // Simulators/emulators don't have push capability.

    (async () => {
      const { status: existing } = await Notifications.getPermissionsAsync();
      let finalStatus = existing;
      if (existing !== "granted") {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== "granted") return;

      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("default", {
          name: "default",
          importance: Notifications.AndroidImportance.MAX,
        });
      }

      const projectId = Constants.expoConfig?.extra?.eas?.projectId;
      if (!projectId) {
        console.warn("No EAS projectId configured — cannot register for push notifications.");
        return;
      }

      let token: string;
      try {
        const result = await Notifications.getExpoPushTokenAsync({ projectId });
        token = result.data;
      } catch (error) {
        // Expected on Expo Go / Android SDK 53+, and on simulators — not an
        // error worth surfacing to the user, just skip registration.
        console.warn("Could not get a push token:", error);
        return;
      }

      const deviceName = Device.deviceName ?? Platform.OS;

      // claim_expo_push_token rather than an upsert here. A push token
      // belongs to a DEVICE, so signing in as a different user on the same
      // phone must move it, not add a second owner — otherwise the server
      // fans notifications out to both accounts and the phone rings for
      // calls meant for whoever used it last. Clearing the other account's
      // row is impossible from the client (RLS only permits deleting your
      // own), so it happens server-side in one atomic step.
      const { error } = await supabase.rpc("claim_expo_push_token", {
        p_token: token,
        p_device_name: deviceName,
      });
      if (error) {
        console.warn("Could not register push token:", error.message);
      }
    })();
  }, [userId]);
}
