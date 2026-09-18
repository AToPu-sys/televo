import Svg, { Path } from "react-native-svg";

/**
 * Apple's actual Face ID glyph — four rounded corner brackets framing a
 * simple face — not a generic Ionicons "scan" icon, which reads as a
 * barcode/document scanner rather than Face ID. Matches the shape used in
 * iOS's own Face ID system prompts and Settings entry.
 */
export function FaceIdIcon({ size = 28, color = "#000000" }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Four corner brackets forming a rounded viewfinder frame */}
      <Path
        d="M3 8V6a3 3 0 0 1 3-3h2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Eyes */}
      <Path
        d="M9 10v1.2M15 10v1.2"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
      {/* Nose */}
      <Path d="M12 10.5v2.3c0 .5-.4.8-.9.8" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      {/* Smile */}
      <Path d="M9 15.5c.8.7 1.9 1 3 1s2.2-.3 3-1" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}
