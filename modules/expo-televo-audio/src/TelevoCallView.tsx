import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import type { ComponentType } from "react";
import { Platform, type StyleProp, type ViewStyle } from "react-native";

export type CallScreenAction = "mute" | "route" | "hangup" | "accept" | "decline" | "minimize";

export type TelevoCallViewProps = {
  style?: StyleProp<ViewStyle>;
  peerName: string;
  avatarUrl?: string;
  statusText: string;
  phase: "outgoing" | "incoming" | "connecting" | "active" | "ended";
  connected: boolean;
  reconnecting: boolean;
  muted: boolean;
  routeKind: string;
  routeLabel: string;
  routeIsPicker: boolean;
  canMinimize: boolean;
  onAction: (action: CallScreenAction) => void;
};

type NativeProps = Omit<TelevoCallViewProps, "onAction"> & {
  onAction: (event: { nativeEvent: { action: CallScreenAction } }) => void;
};

// Only on iOS, and only when the installed binary has the view: a JS update
// landing on an older build must fall back to the React Native call screen
// instead of rendering nothing.
let NativeView: ComponentType<NativeProps> | null = null;
if (Platform.OS === "ios" && requireOptionalNativeModule("TelevoCallView")) {
  try {
    NativeView = requireNativeViewManager<NativeProps>("TelevoCallView");
  } catch {
    NativeView = null;
  }
}

export const isNativeCallScreenAvailable = NativeView !== null;

/** The native SwiftUI voice-call screen. Renders nothing where unavailable. */
export function TelevoCallView({ onAction, ...props }: TelevoCallViewProps) {
  if (!NativeView) return null;
  return <NativeView {...props} onAction={(event) => onAction(event.nativeEvent.action)} />;
}
