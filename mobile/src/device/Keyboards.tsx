import { Fragment, type CSSProperties, type ReactNode } from "react";

/**
 * Software keyboards — ported from ios-frame.jsx (IOSKeyboard) and
 * android-frame.jsx (AndroidKeyboard). Decorative only (no input). Rendered in
 * the device-frame content flow when a screen wants the keyboard up.
 */

// ── iOS 26 liquid-glass keyboard ───────────────────────────────────────────
export function IOSKeyboard({ dark = false }: { dark?: boolean }) {
  const glyph = dark ? "rgba(255,255,255,0.7)" : "#595959";
  const sugg = dark ? "rgba(255,255,255,0.6)" : "#333";
  const keyBg = dark ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.85)";

  const icons: Record<string, ReactNode> = {
    shift: (
      <svg width="19" height="17" viewBox="0 0 19 17">
        <path d="M9.5 1L1 9.5h4.5V16h8V9.5H18L9.5 1z" fill={glyph} />
      </svg>
    ),
    del: (
      <svg width="23" height="17" viewBox="0 0 23 17">
        <path d="M7 1h13a2 2 0 012 2v11a2 2 0 01-2 2H7l-6-7.5L7 1z" fill="none" stroke={glyph} strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M10 5l7 7M17 5l-7 7" stroke={glyph} strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
    ret: (
      <svg width="20" height="14" viewBox="0 0 20 14">
        <path d="M18 1v6H4m0 0l4-4M4 7l4 4" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  };

  const key = (
    content: ReactNode,
    opts: { w?: number; flex?: boolean; ret?: boolean; fs?: number; k?: string } = {},
  ) => {
    const { w, flex, ret, fs = 25, k } = opts;
    return (
      <div
        key={k}
        style={{
          height: 42,
          borderRadius: 8.5,
          flex: flex ? 1 : undefined,
          width: w,
          minWidth: 0,
          background: ret ? "#08f" : keyBg,
          boxShadow: "0 1px 0 rgba(0,0,0,0.075)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: '-apple-system, "SF Compact", system-ui',
          fontSize: fs,
          fontWeight: 458,
          color: ret ? "#fff" : glyph,
        }}
      >
        {content}
      </div>
    );
  };

  const row = (keys: string[], pad = 0) => (
    <div style={{ display: "flex", gap: 6.5, justifyContent: "center", padding: `0 ${pad}px` }}>
      {keys.map((l) => key(l, { flex: true, k: l }))}
    </div>
  );

  return (
    <div
      style={{
        position: "relative",
        zIndex: 15,
        borderRadius: 27,
        overflow: "hidden",
        padding: "11px 0 2px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        boxShadow: dark
          ? "0 -2px 20px rgba(0,0,0,0.09)"
          : "0 -1px 6px rgba(0,0,0,0.018), 0 -3px 20px rgba(0,0,0,0.012)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 27,
          backdropFilter: "blur(12px) saturate(180%)",
          WebkitBackdropFilter: "blur(12px) saturate(180%)",
          background: dark ? "rgba(120,120,128,0.14)" : "rgba(255,255,255,0.25)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 27,
          boxShadow: dark
            ? "inset 1.5px 1.5px 1px rgba(255,255,255,0.15)"
            : "inset 1.5px 1.5px 1px rgba(255,255,255,0.7), inset -1px -1px 1px rgba(255,255,255,0.4)",
          border: dark ? "0.5px solid rgba(255,255,255,0.15)" : "0.5px solid rgba(0,0,0,0.06)",
          pointerEvents: "none",
        }}
      />

      {/* autocorrect bar */}
      <div
        style={{
          display: "flex",
          gap: 20,
          alignItems: "center",
          padding: "8px 22px 13px",
          width: "100%",
          boxSizing: "border-box",
          position: "relative",
        }}
      >
        {['"The"', "the", "to"].map((w, i) => (
          <Fragment key={i}>
            {i > 0 && <div style={{ width: 1, height: 25, background: "#ccc", opacity: 0.3 }} />}
            <div
              style={{
                flex: 1,
                textAlign: "center",
                fontFamily: "-apple-system, system-ui",
                fontSize: 17,
                color: sugg,
                letterSpacing: -0.43,
                lineHeight: "22px",
              }}
            >
              {w}
            </div>
          </Fragment>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 13,
          padding: "0 6.5px",
          width: "100%",
          boxSizing: "border-box",
          position: "relative",
        }}
      >
        {row(["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"])}
        {row(["a", "s", "d", "f", "g", "h", "j", "k", "l"], 20)}
        <div style={{ display: "flex", gap: 14.25, alignItems: "center" }}>
          {key(icons.shift, { w: 45, k: "shift" })}
          <div style={{ display: "flex", gap: 6.5, flex: 1 }}>
            {["z", "x", "c", "v", "b", "n", "m"].map((l) => key(l, { flex: true, k: l }))}
          </div>
          {key(icons.del, { w: 45, k: "del" })}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {key("ABC", { w: 92.25, fs: 18, k: "abc" })}
          {key("", { flex: true, k: "space" })}
          {key(icons.ret, { w: 92.25, ret: true, k: "ret" })}
        </div>
      </div>

      <div style={{ height: 56, width: "100%", position: "relative" }} />
    </div>
  );
}

// ── Android Material keyboard ───────────────────────────────────────────────
export function AndroidKeyboard({ dark = false }: { dark?: boolean }) {
  const glyph = dark ? "#c2c1b9" : "#3a3934";
  const keyBg = dark ? "#3a3935" : "#fbfbfa";
  const barBg = dark ? "#1a1a17" : "#d7dae0";

  let k = 0;
  const key = (
    l: ReactNode,
    opts: { flex?: number; bg?: string; minW?: number; fs?: number } = {},
  ) => {
    const { flex = 1, bg = keyBg, minW, fs = 20 } = opts;
    const style: CSSProperties = {
      height: 44,
      borderRadius: 7,
      flex,
      minWidth: minW,
      background: bg,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "Inter, system-ui",
      fontSize: fs,
      fontWeight: 500,
      color: glyph,
      boxShadow: "0 1px 0 rgba(0,0,0,0.12)",
    };
    return (
      <div key={k++} style={style}>
        {l}
      </div>
    );
  };

  const row = (keys: string[], padW?: number) => (
    <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
      {padW ? <div style={{ flex: padW }} /> : null}
      {keys.map((l) => key(l))}
      {padW ? <div style={{ flex: padW }} /> : null}
    </div>
  );

  const shiftBg = dark ? "#2c2b28" : "#c2c6cd";
  return (
    <div style={{ background: barBg, padding: "8px 5px 6px", display: "flex", flexDirection: "column", gap: 8 }}>
      {row(["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"])}
      {row(["a", "s", "d", "f", "g", "h", "j", "k", "l"], 0.5)}
      <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
        {key("⇧", { flex: 1.4, bg: shiftBg })}
        {["z", "x", "c", "v", "b", "n", "m"].map((l) => key(l))}
        {key("⌫", { flex: 1.4, bg: shiftBg })}
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
        {key("?123", { flex: 1.6, bg: shiftBg, fs: 14 })}
        {key(",", { flex: 1 })}
        {key("", { flex: 5, minW: 120 })}
        {key(".", { flex: 1 })}
        {key("return", { flex: 1.6, bg: "#2c4a7a", fs: 13 })}
      </div>
      <div style={{ height: 14 }} />
    </div>
  );
}
