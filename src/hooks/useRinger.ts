import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { useEffect, useRef } from "react";
import { Vibration } from "react-native";

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

  useEffect(() => {
    if (!active) return;

    let cancelled = false;

    (async () => {
      try {
        // Keep ringing even if the phone's silent switch is on — an incoming
        // call is exactly the case where that matters.
        await setAudioModeAsync({ playsInSilentMode: true });

        const player = createAudioPlayer(require("../../assets/ringtone.wav"));

        // The call can end DURING the await above. Cleanup has then already
        // run and read a still-null playerRef, so it can't stop this player —
        // it would loop forever, which is the "ringing continues after the
        // call" bug. Whoever finishes last is responsible for stopping it, so
        // re-check the flag now that the player actually exists.
        if (cancelled) {
          player.remove();
          return;
        }

        player.loop = true;
        // The caller hears a quieter tone than the person being called.
        player.volume = mode === "incoming" ? 1.0 : 0.4;
        player.play();
        playerRef.current = player;
      } catch {
        // Audio can fail (a call already holding the audio session, an
        // emulator with no output). Vibration below still signals the call.
      }
    })();

    if (mode === "incoming") {
      // Repeats until cancelled, which is what makes it behave like a real
      // incoming ring rather than a single buzz.
      Vibration.vibrate([0, 700, 900], true);
    } else {
      Vibration.vibrate(120);
    }

    return () => {
      cancelled = true;
      Vibration.cancel();
      const player = playerRef.current;
      playerRef.current = null;
      if (player) {
        try {
          // pause() before remove(): removing a looping player does not
          // reliably silence it on iOS, which leaves the ringtone audible
          // after the call is answered or hung up.
          player.pause();
          player.remove();
        } catch {
          // Already released.
        }
      }
    };
  }, [active, mode]);
}
