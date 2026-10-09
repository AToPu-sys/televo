import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";

import { decodeSessionIdFromAccessToken, supabase } from "../lib/supabase";

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
  //
  // A call push (send-call-push, `data.kind === "call"`) is explicitly
  // skipped here: useCallManager's own response listener owns that case and
  // opens the call screen, not the chat. Routing to the chat for a call tap
  // as well — this listener fires alongside that one, not instead of it —
  // would be the exact bug this split fixed: nothing wrong with LANDING in
  // the chat for a call push too, except that a tap used to be the ONLY
  // signal Android had for an incoming call, and opening the chat instead
  // of the call screen left no way to actually answer.
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      if (data?.kind === "call") return;
      const conversationId = data?.conversationId;
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
        // Neither channel registration is allowed to throw past this block.
        // This whole effect runs on every cold start (it's what gets the app
        // registered for push at all) — an unhandled rejection here, before
        // getExpoPushTokenAsync even runs, previously meant a device whose
        // OS/expo-notifications version rejects one of the "calls" channel's
        // newer fields (bypassDnd, lockscreenVisibility, or the
        // vibrationPattern array shape) never registered for push OR saw an
        // incoming call at all — "crashes immediately, doesn't even show the
        // call" on Android traces straight back to this.
        try {
          await Notifications.setNotificationChannelAsync("default", {
            name: "default",
            importance: Notifications.AndroidImportance.MAX,
          });
        } catch (error) {
          console.warn("Could not set up the default notification channel:", error);
        }
        // A separate, louder channel for calls (send-call-push sets
        // `channelId: "calls"` on every call push). Giving calls their own
        // channel — rather than reusing "default" — is what lets Android
        // show this over the lock screen with the actual ringtone instead
        // of a normal notification chime, and lets a user who muted this
        // channel in system settings do so without also muting messages.
        // bypassDnd is the Do Not Disturb override: a phone call-equivalent
        // ringing through a muted/DND phone is expected behavior, the same
        // way the regular phone app's calls do.
        try {
          await Notifications.setNotificationChannelAsync("calls", {
            name: "Calls",
            importance: Notifications.AndroidImportance.MAX,
            sound: "ringtone.wav",
            bypassDnd: true,
            lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
            vibrationPattern: [0, 500, 500, 500, 500, 500],
          });
        } catch (error) {
          // Falls back to the "default" channel's own (quieter, DND-respecting)
          // behavior for a call push rather than taking the whole registration
          // effect down — still rings, just not as loudly/reliably as intended.
          console.warn("Could not set up the calls notification channel:", error);
        }
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
      // Device.modelName is the hardware model ("iPhone 15 Pro") — distinct
      // from deviceName above, which is whatever the OWNER named their
      // phone ("Bekhzod's iPhone"). The Devices screen shows both: the
      // model so a listed session is identifiable even if nobody bothered
      // to rename their phone, the owner's name because it's the one they
      // actually recognize at a glance.
      const deviceModel = Device.modelName ?? null;

      const { data: sessionData } = await supabase.auth.getSession();
      const sessionId = sessionData.session
        ? decodeSessionIdFromAccessToken(sessionData.session.access_token)
        : null;

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
        p_session_id: sessionId,
        p_device_model: deviceModel,
      });
      if (error) {
        console.warn("Could not register push token:", error.message);
      }

      // Best-effort — the Devices screen's city/country is a nice-to-have,
      // not something registration should ever fail over. Only worth
      // calling once per session (sessionId, not userId, as the effect's
      // own dependency would re-run this on every render otherwise), so a
      // plain fire-and-forget here rather than adding sessionId to deps.
      if (sessionId) {
        void supabase.functions
          .invoke("register-device-location", { body: { session_id: sessionId } })
          .catch(() => {});
      }
    })();
  }, [userId]);
}
