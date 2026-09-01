import { forwardRef, useImperativeHandle, useRef } from "react";
import { StyleSheet, View } from "react-native";
import WebView from "react-native-webview";

import { WEBRTC_BRIDGE_HTML } from "../lib/webrtcBridgeHtml";

export type BridgeEvent =
  | { type: "ready" }
  | { type: "local-ready" }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit }
  | { type: "connection-state"; state: string }
  | { type: "log"; message: string }
  | { type: "error"; message: string };

export type WebRtcBridgeHandle = {
  send: (command: object) => void;
};

type WebRtcBridgeProps = {
  onEvent: (event: BridgeEvent) => void;
  /** true renders the video surfaces full-bleed; false keeps them off-screen for audio-only calls. */
  visible: boolean;
};

/**
 * Hosts the browser-WebRTC page from webrtcBridgeHtml.ts. The WebView itself
 * IS the WebRTC engine here — getUserMedia/RTCPeerConnection run inside its
 * browser context, which Expo Go already supports without any native module.
 * React Native only ever sees JSON events in and JSON commands out.
 */
export const WebRtcBridge = forwardRef<WebRtcBridgeHandle, WebRtcBridgeProps>(function WebRtcBridge(
  { onEvent, visible },
  ref
) {
  const webviewRef = useRef<WebView>(null);

  useImperativeHandle(ref, () => ({
    send(command: object) {
      const script = `document.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(
        JSON.stringify(command)
      )} })); true;`;
      webviewRef.current?.injectJavaScript(script);
    },
  }));

  return (
    <View style={visible ? styles.visible : styles.hidden} pointerEvents="none">
      <WebView
        ref={webviewRef}
        originWhitelist={["*"]}
        source={{ html: WEBRTC_BRIDGE_HTML }}
        onMessage={(event) => {
          try {
            const parsed = JSON.parse(event.nativeEvent.data) as BridgeEvent;
            onEvent(parsed);
          } catch {
            // Ignore malformed frames rather than crashing the call.
          }
        }}
        // Required for getUserMedia to fire without a tap inside the page.
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        mediaCapturePermissionGrantType="grant"
        // Android: this react-native-webview version doesn't expose
        // onPermissionRequest, but Expo Go's own WebView host already
        // auto-grants getUserMedia by default, so no handler is needed here.
        // If this ever moves to a standalone/dev build on a newer webview
        // version, add onPermissionRequest to explicitly grant camera/mic.
        javaScriptEnabled
        domStorageEnabled
      />
    </View>
  );
});

const styles = StyleSheet.create({
  visible: StyleSheet.absoluteFillObject,
  // Off-screen rather than unmounted: keeps the peer connection and mic/cam
  // streams alive for audio-only calls without showing video surfaces.
  hidden: { position: "absolute", width: 1, height: 1, opacity: 0, top: -9999, left: -9999 },
});
