import type { ReactNode } from "react";
import { AndroidStatusBar } from "./StatusBars";
import { AndroidKeyboard } from "./Keyboards";

/**
 * Android (Material) device frame — ported from android-frame.jsx
 * (AndroidDevice). Punch-hole camera + absolute status bar + gesture pill.
 */
export function AndroidFrame({
  children,
  dark = false,
  keyboard = false,
  width = 412,
  height = 892,
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
        borderRadius: 40,
        overflow: "hidden",
        position: "relative",
        background: dark ? "#000" : "#fff",
        boxShadow: "0 40px 80px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.12)",
        fontFamily: "Inter, system-ui, sans-serif",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      {/* punch-hole camera */}
      <div
        style={{
          position: "absolute",
          top: 13,
          left: "50%",
          transform: "translateX(-50%)",
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: "#000",
          zIndex: 50,
        }}
      />
      {/* status bar (absolute overlay) */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 10 }}>
        <AndroidStatusBar dark={dark} />
      </div>
      {/* content fills full height */}
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>{children}</div>
        {keyboard && <AndroidKeyboard dark={dark} />}
      </div>
      {/* gesture pill — always on top */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 60,
          height: 24,
          display: "flex",
          justifyContent: "center",
          alignItems: "flex-end",
          paddingBottom: 9,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            width: 132,
            height: 4,
            borderRadius: 100,
            background: dark ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.5)",
          }}
        />
      </div>
    </div>
  );
}
