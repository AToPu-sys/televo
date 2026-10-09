import { Ionicons } from "@expo/vector-icons";
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { decodeBase64 } from "tweetnacl-util";

import { useCallManager } from "../hooks/useCallManager";
import { useE2ee } from "../hooks/useE2ee";
import { cachedMediaUri } from "../lib/mediaCache";
import { spacing } from "../theme";

// Only one voice message plays at a time; starting another stops this one.
let stopActivePlayback: (() => void) | null = null;

const FALLBACK_BARS = 32;

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function decodeBars(waveform: string | null | undefined): number[] {
  if (!waveform) return Array.from({ length: FALLBACK_BARS }, () => 0.25);
  try {
    return Array.from(decodeBase64(waveform), (v) => v / 255);
  } catch {
    return Array.from({ length: FALLBACK_BARS }, () => 0.25);
  }
}

type Props = {
  mediaRef: string;
  durationMs: number | null;
  waveform: string | null;
  conversationId: string | null;
  color: string;
  accent: string;
};

function VoiceMessageInner({ mediaRef, durationMs, waveform, conversationId, color, accent }: Props) {
  const { decryptBytesForConversation } = useE2ee();
  const { state: callState } = useCallManager();
  const callActive = callState.phase !== "idle" && callState.phase !== "ended";

  const playerRef = useRef<AudioPlayer | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [failed, setFailed] = useState(false);
  const bars = useMemo(() => decodeBars(waveform), [waveform]);
  const totalMs = durationMs ?? 0;

  const release = useCallback(() => {
    const player = playerRef.current;
    playerRef.current = null;
    if (player) {
      player.pause();
      player.remove();
    }
    setPlaying(false);
    setPositionMs(0);
  }, []);

  useEffect(() => release, [release]);

  // A call starting stops any voice note that's playing.
  useEffect(() => {
    if (callActive && playerRef.current) release();
  }, [callActive, release]);

  const toggle = useCallback(async () => {
    if (playerRef.current) {
      if (playing) {
        playerRef.current.pause();
        setPlaying(false);
      } else {
        stopActivePlayback?.();
        stopActivePlayback = release;
        playerRef.current.play();
        setPlaying(true);
      }
      return;
    }

    setLoading(true);
    setFailed(false);
    const isLocal = mediaRef.includes("://");
    const uri = isLocal
      ? mediaRef
      : await cachedMediaUri(mediaRef, (ciphertext, nonce) =>
          decryptBytesForConversation(conversationId ?? "", ciphertext, nonce)
        );
    setLoading(false);
    if (!uri) {
      setFailed(true);
      return;
    }

    // Plays even with the ringer switch on silent, like a voice note should.
    // Skipped during a call: changing the session mode mid-call is what cuts
    // call audio, and the call has already configured it for playback anyway.
    if (!callActive) {
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
    }

    stopActivePlayback?.();
    // keepAudioSessionActive: removing this player must never deactivate the
    // shared audio session (see project memory: it silently kills call audio).
    const player = createAudioPlayer(uri, { keepAudioSessionActive: true, updateInterval: 100 });
    playerRef.current = player;
    stopActivePlayback = release;
    player.addListener("playbackStatusUpdate", (status) => {
      setPositionMs(Math.round(status.currentTime * 1000));
      if (status.didJustFinish) {
        if (stopActivePlayback === release) stopActivePlayback = null;
        release();
      }
    });
    player.play();
    setPlaying(true);
  }, [playing, mediaRef, conversationId, decryptBytesForConversation, callActive, release]);

  const progress = totalMs > 0 ? Math.min(1, positionMs / totalMs) : 0;
  const shown = playing || positionMs > 0 ? positionMs : totalMs;

  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => void toggle()}
        accessibilityRole="button"
        accessibilityLabel={playing ? "Pause voice message" : "Play voice message"}
        style={[styles.button, { backgroundColor: accent }]}
        hitSlop={6}
      >
        {loading ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Ionicons name={failed ? "refresh" : playing ? "pause" : "play"} size={18} color="#FFFFFF" />
        )}
      </Pressable>
      <View style={styles.body}>
        <View style={styles.bars}>
          {bars.map((value, index) => {
            const played = index / bars.length < progress;
            return (
              <View
                key={index}
                style={[
                  styles.bar,
                  {
                    height: 4 + value * 20,
                    backgroundColor: played ? accent : color,
                    opacity: played ? 1 : 0.35,
                  },
                ]}
              />
            );
          })}
        </View>
        <Text style={[styles.time, { color }]}>{failed ? "Tap to retry" : formatDuration(shown)}</Text>
      </View>
    </View>
  );
}

export const VoiceMessage = memo(VoiceMessageInner);

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minWidth: 210 },
  button: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, gap: 4 },
  bars: { flexDirection: "row", alignItems: "center", height: 24, gap: 2 },
  bar: { flex: 1, borderRadius: 1.5, minWidth: 2 },
  time: { fontSize: 12, fontVariant: ["tabular-nums"] },
});
