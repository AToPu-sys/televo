import { requireNativeViewManager } from "expo-modules-core";
import type { ComponentType, PropsWithChildren } from "react";
import { Platform, View, type ViewProps } from "react-native";

type TouchPassthroughNativeProps = ViewProps & {
  /** See TouchPassthroughView.swift's own doc comment for the full "why".
   * False (the default) behaves like a plain View. True makes this view's
   * native hitTest return nil — instead of UIKit's default `self` — for any
   * point none of its subviews claim, the same semantics RN's own
   * pointerEvents="box-none" already gives every ordinary view. The one
   * place that semantic is actually missing is the root content view
   * `<Modal>` presents its children inside, which is plain UIKit, not an
   * RCTView — this component exists only to sit directly inside <Modal> and
   * patch that one gap. */
  passthroughEnabled?: boolean;
};

// Same defensive-load reasoning as expo-call-pip and expo-speaker-toggle's
// own modules: this is imported from CallOverlay, which is mounted
// app-wide once a session exists. An unguarded throw from a build that
// hasn't picked up this native module yet would take down the whole app
// rather than just leaving the minimized-call-freezes-the-chat bug
// unfixed. Falls back to a plain RN View, which reproduces the OLD
// (buggy) behavior exactly — minimized still visually works, it just
// doesn't let touches through, same as before this module existed.
//
// The Platform.OS check below is load-bearing, not a style choice — this
// module is apple-only (expo-module.config.json: "platforms": ["apple"]),
// and on Android requireNativeViewManager does NOT throw the way
// requireNativeModule does when the native side is absent. It instead
// silently registers a React Native host component pointing at a native
// view manager name that is never going to exist on that platform, and the
// failure only happens later, at actual render time, as a hard native crash
// (ViewManager not found) — which brought down EVERY incoming call on
// Android, since CallOverlay (and so this component) mounts the instant a
// call starts ringing. The try/catch below still covers iOS builds that
// predate this native module existing, which is the one case where
// requireNativeViewManager genuinely can throw.
let NativeTouchPassthroughView: ComponentType<TouchPassthroughNativeProps> | null = null;
if (Platform.OS === "ios") {
  try {
    NativeTouchPassthroughView = requireNativeViewManager("TouchPassthrough");
  } catch {
    NativeTouchPassthroughView = null;
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(
        "[expo-touch-passthrough] native view missing — rebuild the app in Xcode. The chat screens underneath a minimized call will stay frozen until then."
      );
    }
  }
}

/**
 * Wrap the single child <Modal> renders in this. See the module's own
 * TouchPassthroughView.swift for the full explanation of what problem this
 * solves (minimized-call Modal freezing the chat screens underneath) and
 * why RN's own pointerEvents can't solve it alone.
 */
export function TouchPassthrough({
  passthroughEnabled,
  style,
  children,
}: PropsWithChildren<{ passthroughEnabled: boolean; style?: ViewProps["style"] }>) {
  if (!NativeTouchPassthroughView) {
    // Fallback keeps the tree shape identical either way, so this never
    // becomes its own source of a layout difference between a rebuilt and
    // a not-yet-rebuilt app.
    return <View style={style}>{children}</View>;
  }
  return (
    <NativeTouchPassthroughView style={style} passthroughEnabled={passthroughEnabled}>
      {children}
    </NativeTouchPassthroughView>
  );
}
