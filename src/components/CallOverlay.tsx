import { endCallPip, onCallPipFailedToStart, startCallPip } from "expo-call-pip";
import { addAudioRouteListener, getAudioRoutes, setAudioRoute, type AudioRoute } from "expo-speaker-toggle";
import { TelevoCallView, isNativeCallScreenAvailable, type CallScreenAction } from "expo-televo-audio";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { TouchPassthrough } from "expo-touch-passthrough";
import type { BridgeEvent, WebRtcBridgeHandle } from "./WebRtcBridge";
import { WebRtcBridge } from "./WebRtcBridge";
import type { CallState } from "../hooks/useCall";
import { useCallStateSounds } from "../hooks/useCallStateSounds";
import { useConnectingTone } from "../hooks/useConnectingTone";
import { useRinger } from "../hooks/useRinger";
import { useTheme } from "../hooks/useTheme";
import { HAS_NO_TURN } from "../lib/webrtc";
import { spacing } from "../theme";
import { ActionSheet } from "./ActionSheet";
import { Avatar } from "./Avatar";
import { CallButton } from "./CallButton";
import { CameraOffBackdrop, EncryptedPill, QualityBars, Scrim } from "./CallChrome";

type CallOverlayProps = {
  state: CallState;
  /** The call is recovering a dropped / changed network path (useCall). */
  reconnecting?: boolean;
  /** Signal quality 0 … 3 from useCall, null before the first sample. */
  quality?: 0 | 1 | 2 | 3 | null;
  /** True once WebRtcBridge's getStats() poll has confirmed bytes are
   * actually arriving from the peer — see watchForInboundMedia. `state.phase
   * === "active"` alone only means SDP/ICE/DTLS finished, which a dead TURN
   * relay that accepts the handshake but never forwards RTP satisfies just
   * as well as a real connection. Drives the "Connected" label so it isn't
   * shown while the call is actually silent. */
  mediaConfirmed: boolean;
  peerName: string;
  peerAvatarUrl?: string | null;
  /** This device's OWN name/avatar — shown over the self-preview when
   * cameraOff is true, so turning your own camera off shows your avatar
   * instead of leaving your last frame frozen on screen. */
  myName: string;
  myAvatarUrl?: string | null;
  muted: boolean;
  cameraOff: boolean;
  /** Signaled by the peer (see useCall's "camera-state" signal), not derived
   * from the remote video track directly — see that signal's own comment. */
  peerCameraOff: boolean;
  speakerOn: boolean;
  isVideo: boolean;
  onBridgeReady: (handle: WebRtcBridgeHandle | null) => void;
  onBridgeEvent: (event: BridgeEvent) => void;
  onAccept: () => void;
  onDecline: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onSwitchCamera: () => void;
  onToggleSpeaker: () => void;
  onDismissEnded: () => void;
  /** Returns a readable, timestamped trace of this call's handshake so far.
   * There's no way to attach a debugger to a call on a real, unplugged
   * phone, so this is the way to see exactly which step it stalled on. */
  getDiagnosticsReport?: () => string;
  /** Lifted into useCallManager's context (see its own comment on
   * `minimized`) so app/_layout.tsx can also read it — the minimized
   * widget's green bar needs the rest of the app to make room for it,
   * which only the root layout controls. This component still owns WHEN
   * it changes (the swipe gesture, the tap-to-restore), just not where the
   * boolean itself lives. */
  minimized: boolean;
  onMinimizedChange: (value: boolean) => void;
};

// Geometry for shrinking the full-screen WebRtcBridge view down into the
// minimized widget's video thumbnail. `transform: scale` shrinks a view
// around its OWN center, not its top-left corner, so getting the thumbnail
// to land at a specific screen position takes both a scale and a translate:
// the translate has to account for the scaled view's center moving too, not
// just the on-screen target position.
const SCREEN = Dimensions.get("window");
const MINIMIZED_WIDGET_SIZE = 64;
const MINIMIZED_WIDGET_TOP = 64; // below the green status bar
const MINIMIZED_WIDGET_LEFT = 12;
const MINIMIZED_BAR_HEIGHT = 40;
/** How far the minimized bar's bottom edge sits from the top of the
 * screen — app/_layout.tsx reads this to push the REST of the app's
 * content down by the same amount while minimized, the way iOS's own
 * "call in progress" status bar banner does for every app running
 * underneath it. Exported (not just used internally here) specifically so
 * the two places can never drift out of sync with each other. */
export const MINIMIZED_BAR_BOTTOM = MINIMIZED_WIDGET_TOP - 4 + MINIMIZED_BAR_HEIGHT;
const MINIMIZED_SCALE = MINIMIZED_WIDGET_SIZE / SCREEN.width;
const MINIMIZED_WIDGET_BOTTOM_MARGIN = 100;
// The thumbnail is draggable to any of the 4 corners (same idea as the
// full-screen corner box's own cornerAnchor), independent of the green bar
// (which always stays put at the top — see MINIMIZED_BAR_BOTTOM). Returns
// where the FULL-SCREEN view's center needs to end up for a given anchor,
// converted to a translate from its current (screen-center) position —
// same derivation the single hardcoded top-left version used, just
// parameterized per anchor instead of one fixed spot.
function minimizedTargetTranslate(anchor: "top-right" | "top-left" | "bottom-right" | "bottom-left") {
  const targetCenterX =
    anchor === "top-left" || anchor === "bottom-left"
      ? MINIMIZED_WIDGET_LEFT + MINIMIZED_WIDGET_SIZE / 2
      : SCREEN.width - MINIMIZED_WIDGET_LEFT - MINIMIZED_WIDGET_SIZE / 2;
  const targetCenterY =
    anchor === "top-left" || anchor === "top-right"
      ? MINIMIZED_WIDGET_TOP + MINIMIZED_WIDGET_SIZE / 2
      : SCREEN.height - MINIMIZED_WIDGET_BOTTOM_MARGIN - MINIMIZED_WIDGET_SIZE / 2;
  return {
    x: targetCenterX - SCREEN.width / 2,
    y: targetCenterY - SCREEN.height / 2,
  };
}

export function CallOverlay({
  state,
  mediaConfirmed,
  peerName,
  peerAvatarUrl,
  myName,
  myAvatarUrl,
  muted,
  cameraOff,
  peerCameraOff,
  speakerOn,
  isVideo,
  onBridgeReady,
  onBridgeEvent,
  onAccept,
  onDecline,
  onHangup,
  onToggleMute,
  onToggleCamera,
  onSwitchCamera,
  onToggleSpeaker,
  onDismissEnded,
  getDiagnosticsReport,
  minimized,
  onMinimizedChange,
  reconnecting = false,
  quality = null,
}: CallOverlayProps) {
  // Where the sound goes: iPhone, speaker, or a connected headset/AirPods/car.
  const [audioRoutes, setAudioRoutes] = useState(() => getAudioRoutes());
  const [routeSheetOpen, setRouteSheetOpen] = useState(false);
  const routeContext = useRef({ speakerOn, isVideo, onToggleSpeaker });
  routeContext.current = { speakerOn, isVideo, onToggleSpeaker };

  useEffect(() => {
    setAudioRoutes(getAudioRoutes());
    return addAudioRouteListener((change) => {
      setAudioRoutes({ routes: change.routes, current: change.current });
      const current = change.routes.find((route) => route.id === change.current);
      if (!current) return;
      const { speakerOn: onSpeaker, isVideo: video, onToggleSpeaker: toggle } = routeContext.current;
      if (change.reason === "newDevice" && isExternalRoute(current) && onSpeaker) {
        // iOS moved the call onto headphones that just connected; keep the
        // speaker state in step instead of showing a stale "Speaker on".
        toggle();
      } else if (change.reason === "deviceRemoved" && current.kind === "receiver" && video) {
        // AirPods taken out mid video call: iOS falls back to the earpiece,
        // which nobody holding a video call can hear.
        setAudioRoute("speaker");
        if (!onSpeaker) toggle();
      }
    });
  }, []);

  const currentRoute = audioRoutes.routes.find((route) => route.id === audioRoutes.current);

  const handleNativeAction = (action: CallScreenAction) => {
    switch (action) {
      case "mute":
        onToggleMute();
        break;
      case "route":
        if (audioRoutes.routes.some(isExternalRoute)) setRouteSheetOpen(true);
        else onToggleSpeaker();
        break;
      case "hangup":
        onHangup();
        break;
      case "decline":
        onDecline();
        break;
      case "accept":
        setAnswering(true);
        onAccept();
        break;
      case "minimize":
        onMinimizedChange(true);
        Animated.timing(minimizeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: false,
          easing: Easing.out(Easing.cubic),
        }).start();
        break;
    }
  };
  const hasExternalRoute = audioRoutes.routes.some(isExternalRoute);

  const chooseRoute = (route: AudioRoute) => {
    setRouteSheetOpen(false);
    setAudioRoute(route.id);
    // Keep useCall's speaker state (and the native speaker flag) in step.
    if ((route.kind === "speaker") !== speakerOn) onToggleSpeaker();
    setAudioRoutes(getAudioRoutes());
  };
  const { theme } = useTheme();

  // Silence the ringtone the moment Accept is tapped, rather than waiting for
  // the phase to change. Answering needs a round trip (the offer has to be
  // there, then an answer SDP is generated), and during that gap the phone
  // was still ringing at the user — while the bridge simultaneously switched
  // the iOS audio session to playAndRecord for the mic, which made the
  // still-looping ringtone jump in volume at exactly the wrong moment.
  const [answering, setAnswering] = useState(false);

  useEffect(() => {
    if (state.phase !== "incoming") setAnswering(false);
  }, [state.phase]);

  // Duration shown next to "Connected" — starts counting the instant the
  // call actually connects, not when it was answered/dialed, so it reads
  // the same as every other call UI (Phone.app, WhatsApp, Telegram). Reset
  // to null on every phase change so a second call in the same overlay
  // mount doesn't inherit the previous one's elapsed time.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    // Gated on mediaConfirmed too, not just phase — "active" alone can mean
    // a dead TURN relay accepted the handshake with no media flowing, and
    // counting up against that would show a running timer on a call nobody
    // can actually hear.
    if (state.phase !== "active" || !mediaConfirmed) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [state.phase, mediaConfirmed]);

  // How long this call has been trying to connect. Used only to soften the
  // status text after a few seconds — see statusLabel.
  //
  // Why it exists: once a relay is in play, ICE legitimately needs several
  // seconds to settle on a working candidate pair. call_diagnostics caught
  // three real calls hung up at 8, 13 and 14 seconds while still
  // negotiating — nothing wrong with any of them, the users simply saw a
  // motionless "Connecting…" and assumed it had failed. The one call that
  // was left alone connected over relay and worked. Telling the user it is
  // still working, rather than showing a frozen label, is the difference.
  const [connectingSeconds, setConnectingSeconds] = useState(0);
  useEffect(() => {
    const negotiating =
      state.phase === "connecting" || (state.phase === "active" && !mediaConfirmed);
    if (!negotiating) {
      setConnectingSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const interval = setInterval(() => {
      setConnectingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [state.phase, mediaConfirmed]);

  // Without this, iOS's normal auto-lock timer fires mid-call and dims then
  // locks the screen — reported specifically for video calls, where the
  // screen is the whole point (a voice call still works fine locked, since
  // CallKit/the audio route are unaffected either way, but a video call
  // goes dark on both the local preview and the remote feed). Scoped to
  // exactly "a call is in progress" (not idle/ended) rather than the whole
  // component's lifetime, so it never holds the screen awake outside an
  // actual call.
  useEffect(() => {
    if (state.phase === "idle" || state.phase === "ended") return;
    const tag = "televo-active-call";
    void activateKeepAwakeAsync(tag);
    return () => {
      void deactivateKeepAwake(tag);
    };
  }, [state.phase]);

  // A slow pulse on the avatar while the call is still ringing — the screen
  // was completely static, which reads as frozen rather than "waiting".
  const pulse = useRef(new Animated.Value(0)).current;
  const ringing = state.phase === "incoming" || state.phase === "outgoing";

  useEffect(() => {
    if (!ringing) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1100,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1100,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [ringing, pulse]);

  // Controls fade in rather than snapping into place when the call connects.
  const controlsFade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(controlsFade, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [state.phase, controlsFade]);

  // Auto-hides the header (name/timer) and controls after 3s of no touch
  // during a connected video call — mirrors FaceTime/YouTube, so the video
  // itself isn't permanently covered by chrome once the caller already knows
  // where the buttons are. A tap anywhere brings them back and restarts the
  // timer. Scoped to "active video call with media confirmed" only: there is
  // nothing to hide FROM during ringing/connecting (no video yet, and the
  // Accept/Decline buttons must never auto-hide), and an audio call has no
  // video for the chrome to cover in the first place.
  const [uiHidden, setUiHidden] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chromeFade = useRef(new Animated.Value(1)).current;
  const autoHideEligible = isVideo && state.phase === "active" && mediaConfirmed;
  // 2026-09-29: swipe-to-minimize used to share autoHideEligible's gate
  // (isVideo && phase === "active" && mediaConfirmed) purely because both
  // lived on the same full-screen gesture surface below — but auto-hiding
  // chrome only makes sense for video (an audio call has no chrome to
  // cover), while minimizing to keep chatting during a call is just as
  // useful for a voice call as a video one. Reported bug: "swipe-to-
  // minimize only works for video calls". Separated so audio calls get the
  // swipe gesture without inheriting video's auto-hide behavior.
  // 2026-10-20: from the moment the call is placed or picked up, not only
  // once media is confirmed. Requiring mediaConfirmed meant no way to leave
  // the call screen while it rang or connected — or at all on a call whose
  // media check never fired — so "write to someone during a call" didn't
  // work. The bar's status text already covers Calling…/Connecting….
  const minimizeEligible = state.phase === "outgoing" || state.phase === "connecting" || state.phase === "active";

  useEffect(() => {
    if (!autoHideEligible) {
      setUiHidden(false);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      return;
    }
    hideTimerRef.current = setTimeout(() => setUiHidden(true), 3000);
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
    // Re-armed by bumping revealToken (see revealChrome below), not by
    // anything here — this effect only handles entering/leaving eligibility.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoHideEligible]);

  useEffect(() => {
    Animated.timing(chromeFade, {
      toValue: uiHidden ? 0 : 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [uiHidden, chromeFade]);

  const revealChrome = () => {
    if (!autoHideEligible) return;
    setUiHidden(false);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setUiHidden(true), 3000);
  };

  // Tapping the corner thumbnail swaps which video is full-screen — see
  // WebRtcBridge's own comment on remoteIsCorner/localIsCorner for why this
  // is a deliberately-accepted audio risk rather than the default-safe
  // design, and verify a real call's audio survives a swap before trusting
  // this in production use.
  const [swapped, setSwapped] = useState(false);
  // Reset per call, not just on unmount — a swap left on from a PREVIOUS
  // call would otherwise start the next one already swapped, with no visual
  // cue why the "big" video is the wrong person.
  useEffect(() => {
    if (state.phase === "idle") setSwapped(false);
  }, [state.phase]);

  // 2026-09-28: swipe-down-to-minimize, so the call keeps running while the
  // user reads/sends messages in the app underneath. Deliberately NOT a
  // second Modal or a route change — WebRtcBridge lives inside THIS Modal's
  // tree, and unmounting it (which closing this Modal would do) tears down
  // the call exactly like the "green light stays on" bug this file already
  // guards against elsewhere. Minimizing instead makes this same Modal
  // transparent and shrinks its own chrome down to a small floating corner
  // widget + a top status bar, with pointerEvents="none" everywhere else so
  // touches fall through to the real app screens rendered underneath in the
  // OS's z-order (this Modal's window is simply on top, not exclusive).
  // `minimized` itself is now a prop (see CallOverlayProps) — lifted into
  // useCallManager's context so app/_layout.tsx can read it too. This
  // component still resets it on hangup, same as before.
  useEffect(() => {
    if (state.phase === "idle") onMinimizedChange(false);
  }, [state.phase, onMinimizedChange]);
  // 0 = full-screen call UI, 1 = fully minimized (small corner widget + top
  // bar). Drives BOTH the live drag preview and the settled state through
  // one value, rather than a separate "drag offset" and "committed" value,
  // so the render tree only ever has one number to interpolate from.
  const minimizeAnim = useRef(new Animated.Value(0)).current;
  const minimizeAnimRef = useRef(0);
  useEffect(() => {
    const id = minimizeAnim.addListener(({ value }) => {
      minimizeAnimRef.current = value;
    });
    return () => minimizeAnim.removeListener(id);
  }, [minimizeAnim]);
  // minimized is also cleared from outside (useCallManager on ended/idle) —
  // e.g. a call minimized while ringing and then declined. This component
  // stays mounted between calls, so without this the shrunken scale carried
  // over: the "Declined" screen and the NEXT call drew tiny in a corner under
  // an opaque Modal.
  useEffect(() => {
    if (!minimized && (state.phase === "ended" || state.phase === "idle")) minimizeAnim.setValue(0);
  }, [minimized, state.phase, minimizeAnim]);
  const DRAG_TO_MINIMIZE_DISTANCE = 220;
  const minimizePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Only claims the gesture once it's clearly a downward drag — a small
      // vertical wobble during an ordinary tap must not trigger this, and a
      // MOSTLY-horizontal gesture belongs to something else (e.g. the
      // corner box's own drag) not this one. Only armed while full-screen:
      // once minimized, the widget has its own much smaller tap-to-restore
      // target instead of a drag.
      onMoveShouldSetPanResponder: (_event, gesture) =>
        !minimized && gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.5,
      onPanResponderMove: (_event, gesture) => {
        minimizeAnim.setValue(Math.min(1, Math.max(0, gesture.dy) / DRAG_TO_MINIMIZE_DISTANCE));
      },
      onPanResponderRelease: (_event, gesture) => {
        // A real swipe past a third of the way minimizes; short of that
        // snaps back to full-screen. Uses the animated value itself (not a
        // fixed pixel threshold on gesture.dy) so it agrees with whatever
        // the user has already visually seen mid-drag.
        const shouldMinimize = minimizeAnimRef.current > 0.3;
        if (shouldMinimize) onMinimizedChange(true);
        Animated.timing(minimizeAnim, {
          toValue: shouldMinimize ? 1 : 0,
          duration: 200,
          useNativeDriver: false,
          easing: Easing.out(Easing.cubic),
        }).start();
      },
    })
  ).current;
  // Tapping the minimized widget restores full-screen — animate back out
  // before flipping `minimized`, so the full UI doesn't just snap in.
  const restoreFromMinimized = () => {
    Animated.timing(minimizeAnim, {
      toValue: 0,
      duration: 200,
      useNativeDriver: false,
      easing: Easing.out(Easing.cubic),
    }).start(() => onMinimizedChange(false));
  };

  // Which corner the minimized video thumbnail rests in — separate from
  // the green bar, which always stays at the top (see minimizedTargetTranslate's
  // own comment). Defaults to top-right so it starts right next to the bar,
  // matching where it visually sits during the minimize animation itself.
  const [minimizedCornerAnchor, setMinimizedCornerAnchor] = useState<
    "top-right" | "top-left" | "bottom-right" | "bottom-left"
  >("top-right");
  const minimizedCornerAnchorRef = useRef(minimizedCornerAnchor);
  minimizedCornerAnchorRef.current = minimizedCornerAnchor;
  // Live drag offset ON TOP OF the settled anchor position — mirrors
  // cornerDrag's own role for the full-screen corner box below, kept
  // separate since the two boxes (minimized thumbnail vs. full-screen
  // corner box) are never both draggable at the same time (minimized
  // replaces the full-screen UI entirely) but share no other state.
  const minimizedCornerDrag = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const minimizedDragPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > 4 || Math.abs(gesture.dy) > 4,
      onPanResponderMove: (_event, gesture) => {
        minimizedCornerDrag.setValue({ x: gesture.dx, y: gesture.dy });
      },
      onPanResponderRelease: (_event, gesture) => {
        // A release with negligible movement is a tap, not a drag —
        // restore full-screen rather than "dropping" the thumbnail back
        // where it already was.
        if (Math.abs(gesture.dx) < 4 && Math.abs(gesture.dy) < 4) {
          minimizedCornerDrag.setValue({ x: 0, y: 0 });
          restoreFromMinimized();
          return;
        }

        // Snaps to whichever of the 4 corners is nearest where the thumbnail
        // was released — same quadrant logic the full-screen corner box
        // uses below, just against the thumbnail's own current anchor
        // instead of a fixed reference point.
        const current = minimizedTargetTranslate(minimizedCornerAnchorRef.current);
        const releasedX = current.x + gesture.dx + SCREEN.width / 2;
        const releasedY = current.y + gesture.dy + SCREEN.height / 2;
        const nextAnchor: "top-right" | "top-left" | "bottom-right" | "bottom-left" =
          releasedX < SCREEN.width / 2
            ? releasedY < SCREEN.height / 2
              ? "top-left"
              : "bottom-left"
            : releasedY < SCREEN.height / 2
              ? "top-right"
              : "bottom-right";
        setMinimizedCornerAnchor(nextAnchor);
        minimizedCornerDrag.setValue({ x: 0, y: 0 });
      },
    })
  ).current;

  // Which screen corner the small thumbnail rests in, and whether it's
  // hidden — both persist across a drag (see cornerDrag below) rather than
  // being derived from it, since the box should stay put after a drag ends
  // rather than snapping back.
  const [cornerAnchor, setCornerAnchor] = useState<"top-right" | "top-left" | "bottom-right" | "bottom-left">(
    "top-right"
  );
  const [cornerHidden, setCornerHidden] = useState(false);
  const cornerDrag = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;

  // 2026-09-27: react-native-gesture-handler's PanGestureHandler never
  // fired at all inside this component's <Modal> on a real device (tap and
  // drag both silently did nothing), even after adding a
  // GestureHandlerRootView inside the Modal on 2026-09-26 — that fix
  // addressed a real but different failure mode and didn't solve this one.
  // gesture-handler's separate native view hierarchy is a known source of
  // flakiness inside a plain RN Modal on Fabric (New Architecture, enabled
  // in this project — see RCT_NEW_ARCH_ENABLED in the build). Replaced
  // entirely with the built-in PanResponder, which dispatches through RN's
  // own responder system rather than a separate gesture-handler native
  // surface, so it has no dependency on how a Modal's native window
  // interacts with that surface.
  //
  // This also fixes the native-driver conflict from the previous fix
  // attempt the same day: PanResponder drives cornerDrag with plain
  // .setValue() calls only, on the JS thread, so there is no native-driven
  // node to conflict with a later imperative reset.
  const cornerAnchorRef = useRef(cornerAnchor);
  cornerAnchorRef.current = cornerAnchor;
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  const cornerPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > 4 || Math.abs(gesture.dy) > 4,
      onPanResponderGrant: () => {
        longPressFiredRef.current = false;
        longPressTimerRef.current = setTimeout(() => {
          longPressFiredRef.current = true;
          setCornerHidden(true);
        }, 500);
      },
      onPanResponderMove: (_event, gesture) => {
        // Real movement means this is a drag, not a long-press-in-place —
        // cancel the hide timer so dragging the box doesn't also hide it.
        if ((Math.abs(gesture.dx) > 4 || Math.abs(gesture.dy) > 4) && longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        cornerDrag.setValue({ x: gesture.dx, y: gesture.dy });
      },
      onPanResponderRelease: (_event, gesture) => {
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        // The long-press already did its job (hid the box); a tap/drag
        // decision on TOP of that would un-hide-and-swap in the same
        // gesture, which reads as the hide button not working.
        if (longPressFiredRef.current) {
          cornerDrag.setValue({ x: 0, y: 0 });
          return;
        }
        // A release with negligible movement is a tap, not a drag — swap
        // self/peer rather than "dropping" the box back where it already
        // was.
        if (Math.abs(gesture.dx) < 4 && Math.abs(gesture.dy) < 4) {
          cornerDrag.setValue({ x: 0, y: 0 });
          setSwapped((current) => !current);
          return;
        }

        const { width, height } = Dimensions.get("window");
        const boxWidth = 100;
        const boxHeight = 150;
        const anchor = cornerAnchorRef.current;
        const restX =
          anchor === "top-left" || anchor === "bottom-left" ? 16 + boxWidth / 2 : width - 16 - boxWidth / 2;
        const restY =
          anchor === "top-left" || anchor === "top-right" ? 60 + boxHeight / 2 : height - 100 - boxHeight / 2;
        const droppedX = restX + gesture.dx;
        const droppedY = restY + gesture.dy;

        const nextAnchor: "top-right" | "top-left" | "bottom-right" | "bottom-left" =
          droppedX < width / 2
            ? droppedY < height / 2
              ? "top-left"
              : "bottom-left"
            : droppedY < height / 2
              ? "top-right"
              : "bottom-right";

        setCornerAnchor(nextAnchor);
        cornerDrag.setValue({ x: 0, y: 0 });
      },
    })
  ).current;

  // Ring (vibrate) while the call is pending — the app was previously
  // completely silent on an incoming call.
  useRinger(
    !answering && (state.phase === "incoming" || state.phase === "outgoing"),
    state.phase === "incoming" ? "incoming" : "outgoing"
  );

  // Soft ticking during the handshake — mirrors statusLabel's own
  // "Connecting…" gate: signaling can finish (phase "active") while a dead
  // TURN relay never actually carries media, and this stays running through
  // that whole window instead of going silent the instant SDP exchange ends.
  useConnectingTone(state.phase === "connecting" || (state.phase === "active" && !mediaConfirmed));

  // Chimes for the two moments that bracket a call: it actually connecting
  // (media confirmed flowing, not just SDP exchanged) and it ending.
  useCallStateSounds(state.phase, mediaConfirmed);

  // System Picture-in-Picture (expo-call-pip) — armed once the peer's video
  // is actually flowing (mediaConfirmed, not just phase === "active" — a
  // dead TURN relay satisfies phase alone), disarmed on hangup/end. Arming
  // it here rather than waiting for AppState to report "background" is
  // deliberate: canStartPictureInPictureAutomaticallyFromInline (set
  // natively) is what makes iOS start PiP the instant the app backgrounds —
  // the controller has to already exist and be armed BEFORE that happens,
  // or there's nothing for iOS's automatic trigger to catch. video-only:
  // PiP has nothing meaningful to show for an audio call.
  const bridgeHandleRef = useRef<WebRtcBridgeHandle | null>(null);
  const pipArmedRef = useRef(false);
  useEffect(() => {
    if (!isVideo || !mediaConfirmed || state.phase !== "active") {
      if (pipArmedRef.current) {
        pipArmedRef.current = false;
        endCallPip();
      }
      return;
    }
    if (pipArmedRef.current) return;
    const remoteStreamUrl = bridgeHandleRef.current?.getRemoteStreamUrl();
    if (!remoteStreamUrl) return;
    // Local stream is allowed to be missing (e.g. this device's own camera
    // failed to open) — PiP still shows the peer full-size, just without
    // the FaceTime-style self thumbnail on top.
    const localStreamUrl = bridgeHandleRef.current?.getLocalStreamUrl() ?? null;
    pipArmedRef.current = true;
    startCallPip(remoteStreamUrl, localStreamUrl);
  }, [isVideo, mediaConfirmed, state.phase]);
  useEffect(() => {
    if (state.phase === "idle" && pipArmedRef.current) {
      pipArmedRef.current = false;
      endCallPip();
    }
  }, [state.phase]);
  // Never wired up before — startSession failing (no video track at the
  // native layer, PiP unsupported on this device/iOS version) was entirely
  // silent: pipArmedRef still flips true on the JS side since startCallPip
  // is fire-and-forget, so a failed arm looked identical to a working one
  // until someone actually backgrounded the app mid-call and nothing
  // appeared. __DEV__-only, same pattern as expo-speaker-toggle's own
  // missing-native-module warning — this is a development/QA signal, not
  // user-facing, and a call must never fail over PiP not working.
  useEffect(() => {
    if (!__DEV__) return;
    const sub = onCallPipFailedToStart(({ reason }) => {
      // eslint-disable-next-line no-console
      console.warn(`[expo-call-pip] failed to start: ${reason}`);
    });
    return () => sub.remove();
  }, []);

  // Auto-dismiss "ended" after a beat so the reason is visible, then let the
  // caller reset back to idle. Must be an effect, not a call in the render
  // body — otherwise every re-render while phase is "ended" schedules a new
  // competing timer, and a stale one can fire during a subsequent call.
  useEffect(() => {
    if (state.phase !== "ended") return;
    const timer = setTimeout(onDismissEnded, 1500);
    return () => clearTimeout(timer);
  }, [state.phase, onDismissEnded]);

  if (state.phase === "idle") return null;

  const showVideo = isVideo && state.phase === "active";
  const recovering = reconnecting && state.phase === "active" && mediaConfirmed;
  const statusText = recovering ? "Reconnecting…" : statusLabel(state, elapsedSeconds, mediaConfirmed, connectingSeconds);
  // Over video (or the full-screen self preview) the controls are frosted
  // glass like the native voice screen; on the plain themed background they
  // keep the theme's surfaces.
  const glass = showVideo || (isVideo && (state.phase === "outgoing" || state.phase === "connecting"));
  const labelColor = glass ? "rgba(255,255,255,0.9)" : theme.textSecondary;
  // Own camera preview runs from the moment a video call starts, not only
  // once it connects — you should see yourself while it rings, the way every
  // other video caller does. Before the peer's stream arrives the preview
  // fills the screen; when they appear it animates down into the corner.
  const showSelfPreview =
    isVideo && (state.phase === "outgoing" || state.phase === "connecting" || state.phase === "active");

  // The WebView IS the media engine — getUserMedia and RTCPeerConnection run
  // inside it. It therefore has to be mounted and loaded during "incoming"
  // too: previously it only mounted from "connecting" onward, so on the
  // receiving side the mic and camera were never opened at all, and tapping
  // Accept tried to answer with an engine that hadn't loaded yet.
  //
  // It was excluded from "incoming" to dodge an Android issue where a
  // WebView swallows touches meant for views above it despite
  // pointerEvents="none". That's handled instead by keeping it off-screen
  // (1x1, far outside the viewport) until the call is actually connected,
  // so it can load and request permissions without covering the
  // Accept/Decline buttons.

  // A plain View, however high its zIndex, can never render above the iOS
  // software keyboard — the keyboard is a native UIKit layer outside React
  // Native's own view hierarchy. That left an incoming call unanswerable
  // whenever the keyboard was open: it visually sat on top of (or ate the
  // touches meant for) the Accept/Decline buttons. A native Modal renders in
  // its own window above the keyboard, so it always gets touches.
  return (
    <Modal visible transparent animationType="none" statusBarTranslucent>
      {/* TouchPassthrough is the Modal's one and only direct child (RN's
          <Modal> asserts exactly one). Its job is narrow and load-bearing:
          see expo-touch-passthrough's TouchPassthroughView.swift for the
          full explanation, but in short — RN's pointerEvents="box-none"/
          "none" (used correctly, throughout, everywhere below) only ever
          controls native hit-testing INSIDE this Modal's own view tree. The
          root content view UIKit creates to host that tree is a bare
          UIView the Modal component itself doesn't control, and a bare
          UIView's default hitTest claims any touch inside its bounds that
          no subview claimed — silently re-absorbing the exact "nobody
          wants this touch" signal box-none already correctly produced one
          level down, which is why the chat screens underneath a minimized
          call were completely frozen despite every pointerEvents prop here
          being set correctly. TouchPassthrough patches that one gap by
          giving this one root view the same box-none semantics every
          ordinary RCTView already has, active only while minimized — the
          full-screen call UI must keep owning every touch exactly as
          before. */}
      <TouchPassthrough passthroughEnabled={minimized} style={StyleSheet.absoluteFill}>
      <View
        style={[
          StyleSheet.absoluteFill,
          styles.container,
          { backgroundColor: minimized ? "transparent" : theme.background },
        ]}
        // box-none while minimized: touches fall through to the real app
        // screens rendered UNDER this Modal's native window everywhere
        // except the small widget below, which sets its own pointerEvents
        // back to "auto".
        pointerEvents={minimized ? "box-none" : "auto"}
      >
        {/* Mounted for every non-idle phase, INCLUDING "ended". Unmounting
            the instant a call ends looks like it should free the camera, but
            it raced the explicit "hangup" command useCall sends a moment
            later: that arrived at an already-null ref and was queued for a
            bridge that no longer existed, so the camera kept capturing until
            the OS reclaimed it on backgrounding — exactly the "green light
            stays on after the call, goes out when I leave the app" symptom.
            The bridge now outlives the call, releases the devices on hangup,
            and is unmounted only when useCall's auto-reset returns the phase
            to "idle" (the early return above). */}
        {/* Wrapping WebRtcBridge in a scale/translate transform (rather than
            touching ITS internal layout) shrinks it into the widget's
            corner spot while minimizing without unmounting or resizing the
            RTCView surfaces themselves — a `transform` is purely visual and
            doesn't change intrinsic view size, so the "audio must never
            depend on video layout" invariant WebRtcBridge documents
            internally still holds. */}
        <Animated.View
          // box-none while minimized: a `transform: scale` shrinks this
          // view's PAINT only, not its hit-test bounds — left at the default
          // "auto" it kept intercepting every touch across the full original
          // full-screen area even once visually shrunk to a small corner
          // widget, which is what made the chat screen underneath
          // unresponsive (no typing, no scrolling, nothing) whenever a call
          // was minimized. The pan handlers that used to live on this same
          // view moved to a separate, untransformed, correctly-sized hitbox
          // below (same pattern as the full-screen corner box's own
          // cornerHitbox) — this view no longer needs to be a touch target
          // itself, only box-none so its descendants (which are all
          // pointerEvents="none" already) never block what's underneath.
          pointerEvents={minimized ? "box-none" : "auto"}
          style={[
            StyleSheet.absoluteFill,
            {
              transform: [
                {
                  scale: minimizeAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, MINIMIZED_SCALE],
                  }),
                },
                {
                  // 2026-09-29: this entry sits AFTER scale in the
                  // transform array, and — verified — React Native applies
                  // a transform list in order, each entry operating on the
                  // FULL-SIZE (unscaled) coordinate space the view already
                  // has, not a space shrunk by an earlier scale entry. So
                  // BOTH the animated target translate and the live drag
                  // offset are already in the same full-size units — no
                  // scale compensation is needed on the drag amount. This
                  // used to multiply minimizedCornerDrag by 1/MINIMIZED_SCALE
                  // (~6.1x), which was simply wrong and made any manual
                  // drag move roughly 6x further than the finger did.
                  translateX: Animated.add(
                    minimizeAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, minimizedTargetTranslate(minimizedCornerAnchor).x],
                    }),
                    minimizedCornerDrag.x
                  ),
                },
                {
                  translateY: Animated.add(
                    minimizeAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, minimizedTargetTranslate(minimizedCornerAnchor).y],
                    }),
                    minimizedCornerDrag.y
                  ),
                },
              ],
              borderRadius: minimizeAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 14] }),
              overflow: "hidden",
            },
          ]}
        >
          <WebRtcBridge
            ref={(handle) => {
              bridgeHandleRef.current = handle;
              onBridgeReady(handle);
            }}
            onEvent={onBridgeEvent}
            visible={showSelfPreview}
            peerVideoVisible={!!showVideo}
            callActive={state.phase !== "ended"}
            swapped={swapped}
            cornerDrag={cornerDrag}
            cornerAnchor={cornerAnchor}
            cornerHidden={cornerHidden}
          />
          {/* 2026-09-29: the full-screen camera-off avatar cover above
              (cameraOffOverlay) is explicitly excluded while minimized
              (`&& !minimized`) — it's a SIBLING of this wrapper, not a
              child, so it never inherited the scale/translate transform
              and would have covered the WHOLE original full-screen area
              instead of shrinking into the thumbnail with everything else.
              Reported bug: "minimized thumbnail shows live camera even
              though I turned my camera off" — it wasn't showing a stale
              live frame, the avatar cover simply never applied inside the
              minimized thumbnail at all, so raw video (or its last frame)
              showed through unmasked. This is that same avatar cover,
              duplicated as a CHILD of the transform wrapper so it shrinks
              and moves in lockstep with the video underneath it. */}
          {minimized && showVideo && (swapped ? cameraOff : peerCameraOff) ? (
            <View style={[StyleSheet.absoluteFill, styles.cameraOffOverlay]} pointerEvents="none">
              <CameraOffBackdrop />
              <Avatar
                name={swapped ? myName : peerName}
                uri={swapped ? myAvatarUrl : peerAvatarUrl}
                size={120}
              />
            </View>
          ) : null}
        </Animated.View>

        {/* The minimized widget's actual touch target — separate from, and
            NOT a wrapper around, the scaled/translated video above (same
            reasoning as the full-screen corner box's own cornerHitbox
            below: a transform moves where a view PAINTS, never where it
            catches touches, so a hitbox needs its own untransformed
            position matching the widget's real on-screen spot instead of
            inheriting one from a transformed ancestor). Sized and
            positioned with the exact same constants minimizedTargetTranslate
            derives the video's translate from, plus the live drag offset, so
            this box tracks the widget exactly as it's dragged between
            corners. */}
        {minimized ? (
          <Animated.View
            {...minimizedDragPanResponder.panHandlers}
            style={[
              styles.minimizedHitbox,
              minimizedCornerAnchor === "top-left" || minimizedCornerAnchor === "bottom-left"
                ? { left: MINIMIZED_WIDGET_LEFT }
                : { right: MINIMIZED_WIDGET_LEFT },
              minimizedCornerAnchor === "top-left" || minimizedCornerAnchor === "top-right"
                ? { top: MINIMIZED_WIDGET_TOP }
                : { bottom: MINIMIZED_WIDGET_BOTTOM_MARGIN },
              { transform: minimizedCornerDrag.getTranslateTransform() },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Restore call"
          />
        ) : null}

        {/* Tap target for auto-hidden chrome, AND the swipe-down-to-minimize
            gesture surface. box-none so it never steals touches meant for
            the header/controls above it — it only ever sees a tap/drag that
            already fell through to bare video.
            2026-09-27: rendered HERE, before the corner hitbox below,
            specifically so the hitbox paints on top of it. This Pressable
            covers the WHOLE screen and is not box-none, so when it used to
            render AFTER (visually on top of) the corner hitbox, it silently
            captured every touch meant for the hitbox before the hitbox ever
            saw one — the actual reason tap-to-swap and drag-to-reposition
            never worked, through two different gesture implementations
            (react-native-gesture-handler, then the built-in PanResponder)
            that were never actually the problem. */}
        {minimizeEligible && !minimized ? (
          <Animated.View
            style={[StyleSheet.absoluteFill, { opacity: Animated.subtract(1, minimizeAnim) }]}
            {...minimizePanResponder.panHandlers}
          >
            {/* revealChrome only makes sense where chrome can actually be
                hidden — an audio call's buttons never auto-hide (see
                autoHideEligible above), so tapping this surface on an
                audio call has nothing to reveal. onPress is conditionally
                omitted rather than the whole Pressable, so the swipe
                gesture on the parent still works identically either way. */}
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={autoHideEligible ? revealChrome : undefined}
            />
          </Animated.View>
        ) : null}

        {/* Single positioned container for everything that lives in the
            draggable corner spot — the tap/drag hitbox AND whichever
            camera-off avatar (self or peer) belongs there. 2026-09-28:
            these used to be up to three separate Animated.Views, each
            calling cornerDrag.getTranslateTransform() independently and
            each mounting/unmounting on its own condition. A real call
            crashed specifically at the moment several of these mounted
            together for the first time (right when the peer answers AND
            the camera was already toggled off) — consistent with several
            native views racing to attach to the same Animated node at
            once. Collapsing to one positioned wrapper with one transform
            subscription removes that scenario entirely: there is now at
            most one thing reading cornerDrag's transform in the corner
            spot, and the avatar is a CHILD of the hitbox rather than a
            competing sibling. */}
        {showVideo && !cornerHidden && !minimized ? (
          <Animated.View
            {...cornerPanResponder.panHandlers}
            style={[
              styles.cornerHitbox,
              cornerAnchor === "top-left" || cornerAnchor === "bottom-left" ? { left: 16 } : { right: 16 },
              cornerAnchor === "top-left" || cornerAnchor === "top-right" ? { top: 60 } : { bottom: 100 },
              { transform: cornerDrag.getTranslateTransform() },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Swap video, or hold to hide"
          >
            {/* Whichever side is currently in the corner (self, unless
                swapped) shows its camera-off avatar here instead of the
                real video peeking through underneath. */}
            {(swapped ? peerCameraOff : cameraOff) ? (
              <View style={[StyleSheet.absoluteFill, styles.cameraOffCorner]} pointerEvents="none">
                <Avatar name={swapped ? peerName : myName} uri={swapped ? peerAvatarUrl : myAvatarUrl} size={48} />
              </View>
            ) : null}
          </Animated.View>
        ) : null}

        {/* Restore button — the corner box is cosmetically hidden, not
            unmounted (see WebRtcBridge's cornerHidden doc comment), so
            there's always a way back without ending or restarting anything. */}
        {showVideo && cornerHidden && !minimized ? (
          <Pressable
            style={[styles.restoreButton, { top: 60 }]}
            onPress={() => setCornerHidden(false)}
            accessibilityRole="button"
            accessibilityLabel="Show video thumbnail"
          >
            <Text style={styles.restoreButtonText}>▢</Text>
          </Pressable>
        ) : null}

        {/* Full-screen camera-off cover — for whichever side (self or peer)
            is CURRENTLY the big/full-screen view, not the corner one (that
            case is handled inside the corner hitbox above). Deliberately an
            overlay ON TOP of WebRtcBridge rather than a change to ITS
            props: the full-screen RTCView must stay mounted at full size
            underneath for its audio to keep playing (see WebRtcBridge's
            own "audio must never depend on video layout" comment) —
            shrinking or unmounting it to show this avatar would risk the
            exact audio-silence bug fixed on 2026-09-24. */}
        {showVideo && (swapped ? cameraOff : peerCameraOff) && !minimized ? (
          <View style={[StyleSheet.absoluteFill, styles.cameraOffOverlay]} pointerEvents="none">
            <CameraOffBackdrop />
            <Avatar name={swapped ? myName : peerName} uri={swapped ? myAvatarUrl : peerAvatarUrl} size={120} />
            <Text style={styles.cameraOffName}>{swapped ? myName : peerName}</Text>
          </View>
        ) : null}

        {/* Ringing/connecting, before showVideo is true: self preview is
            full-screen (WebRtcBridge's "localFull" style) regardless of
            swap, since there's no peer video yet to swap with. */}
        {showSelfPreview && cameraOff && !showVideo && !minimized ? (
          <View style={[StyleSheet.absoluteFill, styles.cameraOffOverlay]} pointerEvents="none">
            <CameraOffBackdrop />
            <Avatar name={myName} uri={myAvatarUrl} size={120} />
            <Text style={styles.cameraOffName}>{myName}</Text>
          </View>
        ) : null}

        {minimized ? (
          <MinimizedCallWidget
            peerName={peerName}
            statusText={statusText}
            onPress={restoreFromMinimized}
            theme={theme}
          />
        ) : null}

        {/* Legibility scrims over video: header on top, controls below. Fade
            with the chrome so auto-hidden UI leaves clean full-bleed video. */}
        {(showVideo || showSelfPreview) && !minimized ? (
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: chromeFade }]}>
            <Scrim position="top" height={230} />
            <Scrim position="bottom" height={280} />
          </Animated.View>
        ) : null}

        <SafeAreaView
          style={[styles.content, minimized ? styles.hidden : null]}
          pointerEvents={minimized ? "none" : "box-none"}
        >
          <Animated.View
            style={[styles.header, { opacity: chromeFade }]}
            pointerEvents={uiHidden ? "none" : "box-none"}
          >
            {!showVideo ? (
              <Animated.View
                style={{
                  transform: [
                    { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) },
                  ],
                  opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.82] }),
                }}
              >
                <Avatar name={peerName} uri={peerAvatarUrl} size={120} />
              </Animated.View>
            ) : null}
            <Text style={[styles.name, { color: showVideo ? "#FFFFFF" : theme.text }]}>
              {peerName}
            </Text>
            <Pressable
              onLongPress={() => {
                if (!getDiagnosticsReport) return;
                const report = getDiagnosticsReport();
                Alert.alert("Call diagnostics", report, [
                  { text: "Close", style: "cancel" },
                  { text: "Share", onPress: () => void Share.share({ message: report }) },
                ]);
              }}
              accessibilityRole="button"
              accessibilityLabel="Show call diagnostics"
              hitSlop={12}
            >
              <View style={styles.statusRow}>
                {recovering ? <ActivityIndicator size="small" color={showVideo ? "#FFFFFF" : theme.textSecondary} /> : null}
                <Text style={[styles.status, { color: showVideo ? "#FFFFFF" : theme.textSecondary }]}>
                  {statusText}
                </Text>
              </View>
            </Pressable>
            {state.phase === "active" || state.phase === "connecting" ? (
              <View style={styles.metaRow}>
                <EncryptedPill onVideo={showVideo || showSelfPreview} />
                {mediaConfirmed && quality !== null ? <QualityBars level={quality} onVideo={showVideo || showSelfPreview} /> : null}
              </View>
            ) : null}
          </Animated.View>

          <Animated.View
            style={[styles.controls, { opacity: Animated.multiply(controlsFade, chromeFade) }]}
            pointerEvents={uiHidden ? "none" : "box-none"}
          >
            {state.phase === "incoming" ? (
              <View style={styles.incomingRow}>
                <CallButton icon="close" color={theme.danger} onPress={onDecline} label="Decline" />
                <CallButton
                  icon="call"
                  color={theme.online}
                  onPress={() => {
                    setAnswering(true);
                    onAccept();
                  }}
                  label="Accept"
                />
              </View>
            ) : state.phase === "outgoing" || state.phase === "connecting" || state.phase === "active" ? (
              <View style={styles.activeRow}>
                <CallButton
                  icon={muted ? "mic-off" : "mic"}
                  color={glass ? (muted ? GLASS_ON : GLASS) : muted ? theme.text : theme.surfaceElevated}
                  iconColor={glass ? (muted ? GLASS_ON_ICON : "#FFFFFF") : muted ? theme.background : theme.text}
                  onPress={onToggleMute}
                  label={muted ? "Unmute" : "Mute"}
                  small
                  showLabel
                  labelColor={labelColor}
                />
                {isVideo ? (
                  <CallButton
                    icon={cameraOff ? "videocam-off" : "videocam"}
                    color={glass ? (cameraOff ? GLASS_ON : GLASS) : theme.surfaceElevated}
                    iconColor={glass ? (cameraOff ? GLASS_ON_ICON : "#FFFFFF") : theme.text}
                    onPress={onToggleCamera}
                    label={cameraOff ? "Camera on" : "Camera"}
                    small
                    showLabel
                    labelColor={labelColor}
                  />
                ) : null}
                {isVideo && !cameraOff ? (
                  <CallButton
                    icon="camera-reverse"
                    color={glass ? GLASS : theme.surfaceElevated}
                    iconColor={glass ? "#FFFFFF" : theme.text}
                    onPress={onSwitchCamera}
                    label="Flip"
                    small
                    showLabel
                    labelColor={labelColor}
                  />
                ) : null}
                {hasExternalRoute && currentRoute ? (
                  // A headset or AirPods is connected: the button opens a
                  // picker instead of toggling, and shows where sound is now.
                  <CallButton
                    icon={routeIcon(currentRoute)}
                    color={glass ? (currentRoute.kind === "receiver" ? GLASS : GLASS_ON) : currentRoute.kind === "receiver" ? theme.surfaceElevated : theme.accent}
                    iconColor={glass ? (currentRoute.kind === "receiver" ? "#FFFFFF" : GLASS_ON_ICON) : currentRoute.kind === "receiver" ? theme.text : "#FFFFFF"}
                    onPress={() => setRouteSheetOpen(true)}
                    label={routeLabel(currentRoute)}
                    small
                    showLabel
                    labelColor={labelColor}
                  />
                ) : (
                  <CallButton
                    icon={speakerOn ? "volume-high" : "volume-medium-outline"}
                    color={glass ? (speakerOn ? GLASS_ON : GLASS) : speakerOn ? theme.accent : theme.surfaceElevated}
                    iconColor={glass ? (speakerOn ? GLASS_ON_ICON : "#FFFFFF") : speakerOn ? "#FFFFFF" : theme.text}
                    onPress={onToggleSpeaker}
                    label="Speaker"
                    small
                    showLabel
                    labelColor={labelColor}
                  />
                )}
                <CallButton icon="call" color={END_RED} onPress={onHangup} label="End" rotate small showLabel labelColor={labelColor} />
              </View>
            ) : null}
          </Animated.View>
        </SafeAreaView>

        {/* iOS voice calls: the native SwiftUI screen, drawn over the React
            Native one (which stays mounted underneath, WebRtcBridge
            included). Video calls and Android keep the screen above. */}
        {isNativeCallScreenAvailable && !isVideo && !minimized ? (
          <TelevoCallView
            style={StyleSheet.absoluteFill}
            peerName={peerName}
            avatarUrl={peerAvatarUrl ?? undefined}
            statusText={statusText}
            phase={state.phase}
            connected={mediaConfirmed}
            reconnecting={
              recovering ||
              ((state.phase === "connecting" || (state.phase === "active" && !mediaConfirmed)) &&
                connectingSeconds >= SLOW_CONNECT_SECONDS)
            }
            quality={mediaConfirmed && quality !== null ? quality : -1}
            muted={muted}
            routeKind={hasExternalRoute && currentRoute ? currentRoute.kind : speakerOn ? "speaker" : "receiver"}
            routeLabel={hasExternalRoute && currentRoute ? routeLabel(currentRoute) : "Speaker"}
            routeIsPicker={hasExternalRoute}
            canMinimize={minimizeEligible}
            onAction={handleNativeAction}
          />
        ) : null}
      </View>
      </TouchPassthrough>
      <ActionSheet
        visible={routeSheetOpen}
        onClose={() => setRouteSheetOpen(false)}
        title="Audio output"
        options={audioRoutes.routes.map((route) => ({
          key: route.id,
          label: route.id === audioRoutes.current ? `${routeLabel(route)}  ✓` : routeLabel(route),
          icon: routeIcon(route),
          onPress: () => chooseRoute(route),
        }))}
      />
    </Modal>
  );
}

// Frosted controls over video, matching TelevoCallScreen.swift's CallActionButton.
const GLASS = "rgba(255,255,255,0.16)";
const GLASS_ON = "rgba(255,255,255,0.95)";
const GLASS_ON_ICON = "#111218";
const END_RED = "#EB4D4B";

function isExternalRoute(route: AudioRoute): boolean {
  return route.kind !== "receiver" && route.kind !== "speaker";
}

function routeLabel(route: AudioRoute): string {
  if (route.kind === "receiver") return "iPhone";
  if (route.kind === "speaker") return "Speaker";
  return route.name;
}

function routeIcon(route: AudioRoute): "phone-portrait-outline" | "volume-high" | "bluetooth" | "headset" | "car" | "tv-outline" {
  switch (route.kind) {
    case "receiver": return "phone-portrait-outline";
    case "speaker": return "volume-high";
    case "bluetooth": return "bluetooth";
    case "car": return "car";
    case "airplay": return "tv-outline";
    default: return "headset";
  }
}

/** The green status bar + tap-to-restore hint shown while a call is
 * minimized — the video itself keeps playing in the small corner thumbnail
 * WebRtcBridge is scaled into by the caller; this only renders the bar, so
 * it never touches the live RTCView surfaces. Modeled on iOS's own
 * in-call/PiP green bar, since that's the pattern this feature is
 * deliberately matching. */
function MinimizedCallWidget({
  peerName,
  statusText,
  onPress,
  theme,
}: {
  peerName: string;
  statusText: string;
  onPress: () => void;
  theme: ReturnType<typeof useTheme>["theme"];
}) {
  return (
    <Pressable
      style={[styles.minimizedBar, { backgroundColor: theme.online }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Return to call with ${peerName}`}
    >
      <Text style={styles.minimizedBarText} numberOfLines={1}>
        {peerName} · {statusText}
      </Text>
      <Text style={styles.minimizedBarHint}>Tap to return</Text>
    </Pressable>
  );
}

/** Formats seconds as call-app-standard duration: M:SS under an hour,
 * H:MM:SS from an hour on — matches Phone.app/WhatsApp/Telegram. */
function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Past this many seconds of negotiation, the label admits it is taking a
 * while. Below it, a plain "Connecting…" is honest and unalarming; above it,
 * silence reads as failure and people hang up on calls that were about to
 * connect (three such calls measured on 2026-09-19, abandoned at 8-14s). */
const SLOW_CONNECT_SECONDS = 5;

function statusLabel(
  state: CallState,
  elapsedSeconds: number,
  mediaConfirmed: boolean,
  connectingSeconds: number
) {
  const connectingText =
    connectingSeconds >= SLOW_CONNECT_SECONDS ? "Still connecting…" : "Connecting…";
  switch (state.phase) {
    case "outgoing":
      return "Ringing…";
    case "incoming":
      return "Incoming call…";
    case "connecting":
      return connectingText;
    case "active":
      // "active" alone only means SDP/ICE/DTLS finished — a dead TURN relay
      // reports the same phase while carrying no actual media. Keep showing
      // "Connecting…" until getStats() confirms real packets are arriving
      // (mediaConfirmed), so the UI stops lying that a silent call is fine.
      if (!mediaConfirmed) return connectingText;
      // Shows "Connected" for the first second (elapsedSeconds is still 0
      // before the interval's first tick), then switches to the running
      // duration — this is what "должно быть время звонка... сначала
      // напишет connected потом время звонка" asked for.
      return elapsedSeconds > 0 ? formatDuration(elapsedSeconds) : "Connected";
    case "ended":
      return state.reason === "declined"
        ? "Declined"
        : state.reason === "missed"
          ? "Missed"
          : state.reason === "failed"
            ? // Names the actual cause when it is known, instead of a bare
              // "Call failed" that looks like a bug in the app. With no TURN
              // relay configured (see HAS_NO_TURN in lib/webrtc), a call can
              // only connect when the two networks can reach each other
              // directly — on mobile data that is a coin flip, and when it
              // loses there is nothing the app could have done differently.
              HAS_NO_TURN
              ? "Couldn't connect — network blocked"
              : "Call failed"
            : "Call ended";
    default:
      return "";
  }
}

const styles = StyleSheet.create({
  container: { zIndex: 1000, elevation: 1000 },
  content: { flex: 1, justifyContent: "space-between", paddingVertical: spacing.xxl },
  hidden: { opacity: 0 },
  minimizedBar: {
    position: "absolute",
    top: MINIMIZED_WIDGET_TOP - 4,
    left: MINIMIZED_WIDGET_LEFT + MINIMIZED_WIDGET_SIZE + spacing.sm,
    right: 12,
    height: MINIMIZED_BAR_HEIGHT,
    borderRadius: 20,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  minimizedBarText: { flex: 1, color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
  minimizedBarHint: { color: "#FFFFFF", fontSize: 12, opacity: 0.85 },
  header: { alignItems: "center", gap: spacing.sm, marginTop: spacing.xxl },
  name: {
    fontSize: 26,
    fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.35)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  status: { fontSize: 15, fontVariant: ["tabular-nums"] },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 },
  controls: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },
  incomingRow: { flexDirection: "row", justifyContent: "space-around" },
  activeRow: { flexDirection: "row", justifyContent: "center", gap: spacing.lg },
  cameraOffOverlay: {
    backgroundColor: "#0C0D16",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
  cameraOffName: { fontSize: 20, fontWeight: "600", color: "#FFFFFF" },
  // Matches WebRtcBridge's own cornerBox size exactly (100x150) — this is a
  // transparent hit target laid exactly over that real video box, not a
  // visible element of its own.
  cornerHitbox: { position: "absolute", width: 100, height: 150 },
  minimizedHitbox: {
    position: "absolute",
    width: MINIMIZED_WIDGET_SIZE,
    height: MINIMIZED_WIDGET_SIZE,
  },
  cameraOffCorner: {
    backgroundColor: "#1C1C1E",
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  restoreButton: {
    position: "absolute",
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  restoreButtonText: { fontSize: 18, color: "#FFFFFF" },
});
