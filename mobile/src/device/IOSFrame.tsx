import type { ReactNode } from "react";
import { IOSStatusBar } from "./StatusBars";
import { IOSKeyboard } from "./Keyboards";

/**
 * iOS 26 device frame — ported from ios-frame.jsx (IOSDevice).
 * Bezel + dynamic island + absolute status bar + home indicator, with the
 * screen content filling the interior. `dark` drives the PHYSICAL chrome colour
 * (status-bar glyphs, indicator); the screen's own colours come from tokens.
 */
export function IOSFrame({
  children,
  dark = false,
  keyboard = false,
  width = 402,
  height = 874,
}: {
  children: ReactNode;
  dark?: boolean;
  keyboard?: boolean;
  width?: number;
  height?: number;
}) {
  return (
    <div
      style={{
        width,
        height,
        flex: "none",
        borderRadius: 48,
        overflow: "hidden",
        position: "relative",
        background: dark ? "#000" : "#F2F2F7",
        boxShadow: "0 40px 80px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.12)",
        fontFamily: "-apple-system, system-ui, sans-serif",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      {/* dynamic island */}
      <div
        style={{
          position: "absolute",
          top: 11,
          left: "50%",
          transform: "translateX(-50%)",
          width: 126,
          height: 37,
          borderRadius: 24,
          background: "#000",
          zIndex: 50,
        }}
      />
      {/* status bar (absolute overlay) */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 10 }}>
        <IOSStatusBar dark={dark} />
      </div>
      {/* nav + content */}
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>{children}</div>
        {keyboard && <IOSKeyboard dark={dark} />}
      </div>
      {/* home indicator — always on top */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 60,
          height: 34,
          display: "flex",
          justifyContent: "center",
          alignItems: "flex-end",
          paddingBottom: 8,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            width: 139,
            height: 5,
            borderRadius: 100,
            background: dark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.25)",
          }}
        />
      </div>
    </div>
  );
}
