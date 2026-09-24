import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { useEffect, useRef } from "react";

function stop(player: AudioPlayer) {
  try {
    player.loop = false;
  } catch {
    // Already released.
  }
  try {
    player.pause();
  } catch {
    // Already released.
  }
  try {
    player.remove();
  } catch {
    // Already released.
  }
}

/**
 * Plays a short, looping "connecting" tick — the same idea as Telegram's
 * handshake sound — for as long as a call has answered/negotiated (SDP
 * exchanged) but hasn't yet been confirmed to actually be carrying media
 * (see WebRtcBridge's watchForInboundMedia / useCall's mediaConfirmed).
 *
 * Without any audio feedback during this window, a call that's stuck
 * negotiating and a call that's genuinely connected looked and sounded
 * identical — silence either way. This gives the user something audible to
 * tell "still working on it" apart from "this call is actually just dead".
 */
export function useConnectingTone(active: boolean) {
  const playerRef = useRef<AudioPlayer | null>(null);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;

    (async () => {
      try {
        // keepAudioSessionActive: true — 2026-09-24. This tone's whole job is
        // to play WHILE WebRTC's own audio unit is live on the same shared
        // AVAudioSession (the exact "connecting, not yet confirmed" window).
        // Without this flag, expo-audio deactivates the shared session the
        // moment this player is removed/paused — and cleanup here fires
        // right as `active` flips false, which is the SAME instant
        // mediaConfirmed becomes true and WebRTC's track starts actually
        // carrying audio. A real call traced this exactly: AVAudioSession
        // activated, ~1.7s later deactivated (this player's own cleanup),
        // followed immediately by AVAudioSessionAudioHardwareFormatChange
        // and RTP packet counters frozen for the rest of the call — the
        // shared session was torn down out from under a WebRTC track that
        // had only just started receiving. This flag stops expo-audio from
        // touching the shared session's activation state at all.
        const player = createAudioPlayer(require("../../assets/connecting.wav"), {
          keepAudioSessionActive: true,
        });

        const previous = playerRef.current;
        if (previous && previous !== player) stop(previous);

        // Published before use, same reasoning as useRinger: the call can
        // end mid-await, and cleanup can only silence a player it can see.
        playerRef.current = player;

        if (cancelled) {
          stop(player);
          playerRef.current = null;
          return;
        }

        player.loop = true;
        // Quiet — this plays over an already-open call audio route, not a
        // ringtone competing with a locked screen's speaker.
        player.volume = 0.25;
        player.play();

        if (cancelled) {
          stop(player);
          playerRef.current = null;
        }
      } catch {
        // Non-fatal: the call proceeds silently through this stage if audio
        // can't start (session busy, no output device).
      }
    })();

    return () => {
      cancelled = true;
      const player = playerRef.current;
      playerRef.current = null;
      if (!player) return;
      try {
        stop(player);
      } catch {
        try {
          player.loop = false;
          player.pause();
        } catch {
          // Nothing further can be done.
        }
      }
    };
  }, [active]);
}
