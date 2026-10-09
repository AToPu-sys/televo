import { createAudioPlayer } from "expo-audio";
import { useEffect, useRef } from "react";

import type { CallState } from "./useCall";

/**
 * One-shot "connected" / "call ended" chimes — plays call-started.wav the
 * moment mediaConfirmed flips true (the same signal the "Connecting…" →
 * "Connected" label switch on, see CallOverlay's statusLabel) and
 * call-ended.wav the moment the phase becomes "ended". Distinct from
 * useConnectingTone (a looping tick DURING negotiation) and useRinger (the
 * incoming/outgoing ringtone) — this is feedback for the two moments that
 * actually bracket a call: it starting for real, and it being over.
 */
export function useCallStateSounds(phase: CallState["phase"], mediaConfirmed: boolean) {
  const playedStartedRef = useRef(false);
  const playedEndedRef = useRef(false);

  useEffect(() => {
    if (phase === "idle") {
      playedStartedRef.current = false;
      playedEndedRef.current = false;
      return;
    }

    if (phase === "active" && mediaConfirmed && !playedStartedRef.current) {
      playedStartedRef.current = true;
      try {
        const player = createAudioPlayer(require("../../assets/call-started.wav"), {
          // Without this, the player's cleanup deactivates the SHARED AVAudioSession
          // and kills the live call audio on both legs ~1s after connect (2026-09-24
          // root cause, reintroduced here 2026-09-29, found again 2026-10-02).
          keepAudioSessionActive: true,
        });
        player.volume = 0.5;
        player.play();
        // One-shot: no loop, no pause/resume lifecycle to manage — release
        // once playback naturally finishes rather than tracking the
        // player past this effect's own lifetime.
        setTimeout(() => {
          try {
            player.remove();
          } catch {
            // Already released.
          }
        }, 1000);
      } catch {
        // Non-fatal — a missed chime doesn't affect the call itself.
      }
    }

    if (phase === "ended" && !playedEndedRef.current) {
      playedEndedRef.current = true;
      // Only plays for a call that actually connected — an unanswered or
      // declined call already has its own distinct feedback (the ringtone
      // simply stopping), and playing a "hang up" chime for a call that
      // never connected would be confusing, not informative.
      if (playedStartedRef.current) {
        try {
          const player = createAudioPlayer(require("../../assets/call-ended.wav"), {
          // Without this, the player's cleanup deactivates the SHARED AVAudioSession
          // and kills the live call audio on both legs ~1s after connect (2026-09-24
          // root cause, reintroduced here 2026-09-29, found again 2026-10-02).
          keepAudioSessionActive: true,
        });
          player.volume = 0.5;
          player.play();
          setTimeout(() => {
            try {
              player.remove();
            } catch {
              // Already released.
            }
          }, 1000);
        } catch {
          // Non-fatal.
        }
      }
    }
  }, [phase, mediaConfirmed]);
}
