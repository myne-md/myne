import type { ReactNode } from "react";

/**
 * iPad device frame — portrait (834×1112) or landscape (1194×834) interior.
 * Bezel padding 13, outer radius 42, inner radius 28, single camera dot on the
 * long edge centre. The three-pane / sidebar layout is the screen's own job.
 */
export function IPadFrame({
  children,
  orientation = "portrait",
  dark = false,
}: {
  children: ReactNode;
  orientation?: "portrait" | "landscape";
  dark?: boolean;
}) {
  const portrait = orientation === "portrait";
  const w = portrait ? 834 : 1194;
  const h = portrait ? 1112 : 834;
  return (
    <div
      style={{
        width: w + 26,
        height: h + 26,
        flex: "none",
        borderRadius: 42,
        padding: 13,
        background: "#0c0c0b",
        boxShadow: "0 50px 90px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.14)",
        position: "relative",
        boxSizing: "border-box",
      }}
    >
      {/* camera dot — centre of the top edge (portrait) / left edge (landscape) */}
      <div
        style={{
          position: "absolute",
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "#2a2a2a",
          zIndex: 20,
          ...(portrait
            ? { top: 6, left: "50%", transform: "translateX(-50%)" }
            : { left: 6, top: "50%", transform: "translateY(-50%)" }),
        }}
      />
      <div
        style={{
          width: w,
          height: h,
          borderRadius: 28,
          overflow: "hidden",
          position: "relative",
          background: dark ? "var(--bg-1)" : "var(--bg-1)",
          fontFamily: "Inter, system-ui, sans-serif",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        {children}
      </div>
    </div>
  );
}
