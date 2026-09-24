import { createAudioPlayer } from "expo-audio";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { MessageBannerHost } from "../components/MessageBannerHost";
import { getCurrentConversationId } from "../lib/currentChat";

export type MessageBannerData = {
  conversationId: string;
  title: string;
  body: string;
};

type MessageNotificationsContextValue = {
  banner: MessageBannerData | null;
  dismiss: () => void;
};

const MessageNotificationsContext = createContext<MessageNotificationsContextValue | undefined>(
  undefined
);

/** Fire-and-forget: a message chime failing to play (audio session busy with
 * a call, simulator with no output) must never block or throw into the
 * notification pipeline. */
function playSound(asset: number) {
  try {
    // keepAudioSessionActive: true — 2026-09-24, same fix as
    // useConnectingTone.ts/useRinger.ts. A message chime can play WHILE a
    // call is active (the notification pipeline doesn't know or care), and
    // without this flag this player's remove() below deactivates the
    // shared AVAudioSession — tearing down a live WebRTC audio unit for an
    // unrelated 0.6-volume chime.
    const player = createAudioPlayer(asset, { keepAudioSessionActive: true });
    player.volume = 0.6;
    player.play();
    // expo-audio players aren't auto-released; without this every message
    // this session ever received leaks a native player instance for the
    // lifetime of the app.
    setTimeout(() => {
      try {
        player.remove();
      } catch {
        // Already released.
      }
    }, 2000);
  } catch {
    // Non-fatal — see comment above.
  }
}

/**
 * Replaces the OS notification banner for a message push that arrives while
 * the app is in the foreground, with Telegram's own behaviour instead of the
 * system default:
 *
 *  - Chat you're currently looking at: no banner of any kind (you can already
 *    see the message arrive in the list) — just a short chime, the same
 *    "message received" feedback Telegram gives even for the open chat.
 *  - Any other chat, or no chat open at all: a small in-app banner appears
 *    (not the OS notification tray/lock-screen style one — this app is
 *    already frontmost), tapping it navigates to that conversation. Also
 *    chimes.
 *  - App backgrounded: untouched, falls through to the normal OS push
 *    notification (see setNotificationHandler in app/_layout.tsx, and
 *    handleNotification there returning shouldShowBanner: true — this hook
 *    only ever runs for a notification the app is already alive to receive).
 */
export function MessageNotificationsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [banner, setBanner] = useState<MessageBannerData | null>(null);

  const dismiss = useCallback(() => setBanner(null), []);

  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener((event) => {
      const content = event.request.content;
      const conversationId = content.data?.conversationId;
      if (typeof conversationId !== "string") return;

      // Calls have their own ringtone/UI entirely (useRinger, CallOverlay) —
      // this hook is message-only. send-push-notification and
      // send-voip-push are separate Edge Functions, but nothing stops a
      // future payload shape collision, so this checks explicitly rather
      // than assuming every push that carries a conversationId is a message.
      if (content.data?.kind === "call") return;

      if (getCurrentConversationId() === conversationId) {
        // Already looking at this exact chat — the message is about to
        // appear in the list via Realtime regardless of this notification,
        // so a banner here would just be pointless clutter on top of a
        // screen already showing the thing it's announcing.
        playSound(require("../../assets/message-received.wav"));
        return;
      }

      playSound(require("../../assets/message-received.wav"));
      setBanner({
        conversationId,
        title: content.title ?? "Televo",
        body: content.body ?? "",
      });
    });

    return () => subscription.remove();
  }, []);

  const handlePress = useCallback(() => {
    if (!banner) return;
    router.push(`/chat/${banner.conversationId}`);
    dismiss();
  }, [banner, router, dismiss]);

  const value = useMemo<MessageNotificationsContextValue>(
    () => ({ banner, dismiss }),
    [banner, dismiss]
  );

  return (
    <MessageNotificationsContext.Provider value={value}>
      {children}
      <MessageBannerHost banner={banner} onPress={handlePress} onDismiss={dismiss} />
    </MessageNotificationsContext.Provider>
  );
}

export function useMessageNotifications() {
  const context = useContext(MessageNotificationsContext);
  if (!context) {
    throw new Error("useMessageNotifications must be used within a MessageNotificationsProvider");
  }
  return context;
}

/** Plays the short "sent" chime. Called from useMessages right after a
 * message send succeeds — see its sendMessage/sendImage/sendDocument. */
export function playMessageSentSound() {
  playSound(require("../../assets/message-sent.wav"));
}
