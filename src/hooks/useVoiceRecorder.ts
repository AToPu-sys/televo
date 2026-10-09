import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from "expo-audio";
import { useCallback, useEffect, useRef } from "react";
import { encodeBase64 } from "tweetnacl-util";

// Voice: mono AAC at 64 kbit/s is ~0.5 MB per minute and still clear speech.
const VOICE_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64000,
  isMeteringEnabled: true,
};

export const VOICE_MIN_MS = 700;
export const VOICE_MAX_MS = 15 * 60 * 1000;
const WAVEFORM_BARS = 48;

export type VoiceRecording = { uri: string; durationMs: number; waveform: string };

/** Maps iOS metering (dBFS, -160…0) to 0…1; speech sits roughly in -50…0. */
function normalizeLevel(db: number): number {
  return Math.max(0, Math.min(1, (db + 50) / 50));
}

/** Averages the captured levels into a fixed number of bars, 0…255 each,
 * base64-encoded for the `waveform` column. */
function encodeWaveform(levels: number[]): string {
  const bars = new Uint8Array(WAVEFORM_BARS);
  if (levels.length > 0) {
    for (let i = 0; i < WAVEFORM_BARS; i++) {
      const from = Math.floor((i * levels.length) / WAVEFORM_BARS);
      const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / WAVEFORM_BARS));
      let sum = 0;
      for (let j = from; j < to; j++) sum += levels[j] ?? 0;
      bars[i] = Math.round((sum / (to - from)) * 255);
    }
  }
  return encodeBase64(bars);
}

/** Records a voice message. The caller must not start a recording during a
 * call: switching the audio session into recording mode is exactly the kind of
 * change that cuts a live call's audio. */
export function useVoiceRecorder(callActive: boolean) {
  const recorder = useAudioRecorder(VOICE_OPTIONS);
  const callActiveRef = useRef(callActive);
  callActiveRef.current = callActive;
  const state = useAudioRecorderState(recorder, 100);
  const levels = useRef<number[]>([]);

  useEffect(() => {
    if (state.isRecording && typeof state.metering === "number") {
      levels.current.push(normalizeLevel(state.metering));
    }
  }, [state.isRecording, state.metering, state.durationMillis]);

  const restoreAudioMode = useCallback(async () => {
    // Never touch the session mode while a call owns it — that is exactly
    // what cuts a live call's audio.
    if (callActiveRef.current) return;
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  }, []);

  /** Returns false if microphone permission was refused or recording failed. */
  const start = useCallback(async (): Promise<boolean> => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) return false;
    try {
      levels.current = [];
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      return true;
    } catch {
      await restoreAudioMode();
      return false;
    }
  }, [recorder, restoreAudioMode]);

  /** Stops and returns the recording, or null if it was too short to keep. */
  const finish = useCallback(async (): Promise<VoiceRecording | null> => {
    const durationMs = recorder.getStatus().durationMillis;
    await recorder.stop();
    await restoreAudioMode();
    const uri = recorder.uri;
    if (!uri || durationMs < VOICE_MIN_MS) return null;
    return { uri, durationMs, waveform: encodeWaveform(levels.current) };
  }, [recorder, restoreAudioMode]);

  const cancel = useCallback(async () => {
    if (recorder.isRecording) await recorder.stop();
    await restoreAudioMode();
    levels.current = [];
  }, [recorder, restoreAudioMode]);

  const lastLevel = levels.current[levels.current.length - 1] ?? 0;

  return {
    isRecording: state.isRecording,
    durationMs: state.durationMillis,
    level: lastLevel,
    start,
    finish,
    cancel,
  };
}
