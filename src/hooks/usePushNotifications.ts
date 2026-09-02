import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
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

      await supabase.from("push_tokens").upsert(
        {
          user_id: userId,
          expo_push_token: token,
          device_name: Device.deviceName ?? Platform.OS,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,expo_push_token" }
      );
    })();
  }, [userId]);
}
