import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { useEffect, useRef } from "react";
import { Vibration } from "react-native";

/**
 * Silences a ringtone player for good.
 *
 * Order matters: clearing `loop` first means that even if `pause()` or
 * `remove()` throws or no-ops (the player may already be released, or the
 * audio session torn down), the tone cannot start over — it can at worst
 * finish the current pass. `remove()` alone does not reliably silence a
 * looping player on iOS.
 */
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
 * Rings the phone while a call is incoming or outgoing.
 *
 * There was previously no ringtone and no vibration anywhere in the app — an
 * incoming call was completely silent, so unless you happened to be looking
 * at the screen you'd never know someone was calling.
 *
 * Plays an actual looping ringtone (assets/ringtone.wav — a 440/480 Hz
 * two-tone ring with a 2s-on/2s-off cadence, like a telephone) and vibrates
 * alongside it, since vibration is the part that still works when the phone
 * is on silent.
 */
export function useRinger(active: boolean, mode: "incoming" | "outgoing") {
  const playerRef = useRef<AudioPlayer | null>(null);

  // `mode` is read through a ref so it is NOT an effect dependency. It flips
  // on the very render the call ends ("incoming" → the ternary's "outgoing"
  // fallback), which would tear down and restart the ringer at the exact
  // moment it should be going quiet.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    if (!active) return;

    let cancelled = false;

    (async () => {
      try {
        // Keep ringing even if the phone's silent switch is on — an incoming
        // call is exactly the case where that matters.
        //
        // allowsRecording matters on the OUTGOING path specifically. This
        // hook is active for phase "outgoing" too (CallOverlay.tsx), which
        // is the same moment acquireMedia opens the microphone and
        // configureForVoiceCall sets the call audio session. Without
        // allowsRecording this call put the session into a playback-only
        // category, so the ringback and the call session fought over it
        // while the mic was opening — and because this runs inside an async
        // IIFE, it could land AFTER the mic was already live and quietly
        // drop the session out of playAndRecord. That is one of the ways a
        // call reached "Connected" carrying no audio at all.
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });

        // keepAudioSessionActive: true — 2026-09-24, same fix and same real
        // trace as useConnectingTone.ts. This player's stop() runs exactly
        // when the call moves out of ringing/outgoing — the same moment
        // WebRTC's own audio unit is taking over the shared AVAudioSession.
        // Without this flag, expo-audio deactivates that shared session on
        // cleanup, tearing down the session out from under audio that may
        // have only just started.
        const player = createAudioPlayer(require("../../assets/ringtone.wav"), {
          keepAudioSessionActive: true,
        });

        // If a previous run's player is somehow still around (the effect
        // re-runs when `mode` flips, which happens on the same render as a
        // phase change), silence it rather than overwriting the ref and
        // orphaning it — an orphan is a loop nobody can ever stop.
        const previous = playerRef.current;
        if (previous && previous !== player) stop(previous);

        // Publish the player to the ref IMMEDIATELY, before touching it. The
        // call can end during any await or native call below, and cleanup can
        // only silence a player it can see. Every earlier version of this
        // assigned the ref last, so a player created or started around the
        // moment of hangup was orphaned and looped forever — that is the
        // "ringing continues after the call ended" bug.
        playerRef.current = player;

        // The call may already have ended while the audio mode was being set.
        if (cancelled) {
          stop(player);
          playerRef.current = null;
          return;
        }

        player.loop = true;
        // The caller hears a quieter tone than the person being called.
        player.volume = modeRef.current === "incoming" ? 1.0 : 0.4;
        player.play();

        // play() is native and can complete after a hangup that already ran
        // cleanup. Re-check and stop, or the loop outlives the call.
        if (cancelled) {
          stop(player);
          playerRef.current = null;
        }
      } catch {
        // Audio can fail (a call already holding the audio session, an
        // emulator with no output). Vibration below still signals the call.
      }
    })();

    if (modeRef.current === "incoming") {
      // Repeats until cancelled, which is what makes it behave like a real
      // incoming ring rather than a single buzz.
      Vibration.vibrate([0, 700, 900], true);
    } else {
      Vibration.vibrate(120);
    }

    return () => {
      cancelled = true;
      // The whole teardown is wrapped: if ANY of it throws, the ringtone is
      // left looping with nobody holding a reference to it. Under Fast
      // Refresh this actually happened — a cleanup closure from the previous
      // module version ran after the module was swapped, its `stop` binding
      // no longer resolved, and the ReferenceError aborted the teardown.
      try {
        Vibration.cancel();
      } catch {
        // Vibration is best-effort; never let it block silencing the player.
      }
      const player = playerRef.current;
      playerRef.current = null;
      if (!player) return;
      try {
        stop(player);
      } catch {
        // stop() already swallows per-call failures; this guards the call
        // itself (e.g. an unresolvable binding after a hot swap).
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
