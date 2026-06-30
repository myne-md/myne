import { useState } from "react";
import { SECTIONS } from "./registry";
import type { ScreenDef } from "./types";
import { DeviceFrame } from "../device";
import { PlatformProvider, type Platform } from "../platform/PlatformContext";
import { useTheme } from "../platform/theme";
import type { ThemeName } from "../platform/PlatformContext";
import { MyneMark } from "../components/Icon";

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "ios", label: "iOS" },
  { id: "android", label: "Android" },
  { id: "ipad", label: "iPad" },
];
const THEMES: ThemeName[] = ["light", "dark", "amoled"];

function appliesTo(def: ScreenDef, platform: Platform): boolean {
  const p = def.platforms ?? ["ios", "android"];
  return p.includes(platform);
}

function Toggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 2, padding: 3, background: "var(--bg-2)", border: "1px solid var(--line-1)", borderRadius: 8 }}>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          style={{
            border: "none",
            cursor: "pointer",
            padding: "6px 14px",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "var(--font-sans)",
            background: value === o.id ? "var(--accent)" : "transparent",
            color: value === o.id ? "var(--accent-on)" : "var(--fg-2)",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ScreenCard({ def, platform, dark }: { def: ScreenDef; platform: Platform; dark: boolean }) {
  return (
    <div data-screen={def.id} style={{ flex: "none", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-2)" }}>
        {def.id} · {def.label}
      </div>
      <PlatformProvider platform={platform}>
        <DeviceFrame
          platform={platform}
          dark={dark}
          keyboard={def.keyboard}
          orientation={def.orientation}
        >
          <def.Component />
        </DeviceFrame>
      </PlatformProvider>
    </div>
  );
}

export function Gallery() {
  const { theme, setTheme } = useTheme("light");
  const [platform, setPlatform] = useState<Platform>("ios");
  const dark = theme !== "light";
  const boardBg = theme === "light" ? "#e3e1da" : theme === "amoled" ? "#0a0a09" : "#1a1916";

  const visibleSections = SECTIONS.map((s) => ({
    ...s,
    screens: s.screens.filter((d) => appliesTo(d, platform)),
  })).filter((s) => s.screens.length > 0);

  return (
    <div
      style={{
        minWidth: "100%",
        width: "max-content",
        minHeight: "100vh",
        boxSizing: "border-box",
        padding: 56,
        background: boardBg,
        display: "flex",
        flexDirection: "column",
        gap: 56,
      }}
    >
      {/* Board header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 24,
          position: "sticky",
          left: 56,
          width: "calc(100vw - 112px)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <MyneMark size={34} radius={6} />
          <div>
            <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)", lineHeight: 1.1 }}>
              myne — mobile UI
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-3)" }}>
              End-to-end encrypted markdown notes · {platform} · {theme}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <Toggle options={PLATFORMS} value={platform} onChange={setPlatform} />
          <Toggle
            options={THEMES.map((t) => ({ id: t, label: t[0].toUpperCase() + t.slice(1) }))}
            value={theme}
            onChange={(t) => setTheme(t as ThemeName)}
          />
        </div>
      </div>

      {visibleSections.map((section) => (
        <div key={section.title} data-section={section.title} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--fg-3)",
            }}
          >
            {section.title}
          </div>
          <div style={{ display: "flex", gap: 44, alignItems: "flex-start", flexWrap: "wrap" }}>
            {section.screens.map((def) => (
              <ScreenCard key={def.id + def.label} def={def} platform={platform} dark={dark} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
