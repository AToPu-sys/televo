import { Platform, useWindowDimensions } from "react-native";

/** Televo Web on a desktop-sized window: the chat list stays on the left and
 * the open chat (or any other screen) shows on the right. */
export const WIDE_WEB_MIN_WIDTH = 900;

export function useWideWeb(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === "web" && width >= WIDE_WEB_MIN_WIDTH;
}
