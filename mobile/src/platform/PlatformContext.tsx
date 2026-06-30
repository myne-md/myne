import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

/**
 * Platform + theme context.
 *
 * Per the "one adaptive codebase" decision, every screen is a single component;
 * the surrounding device chrome (status bar, nav, keyboard, biometric glyph,
 * gesture affordance) and a handful of platform-specific bits are swapped from
 * this context rather than duplicated into per-platform copies.
 *
 * UI-only build: nothing here touches Tauri / native APIs. The values are set
 * by the device frame that wraps a screen, or the gallery harness.
 */

export type Platform = "ios" | "android" | "ipad";
export type ThemeName = "light" | "dark" | "amoled";

export interface PlatformInfo {
  platform: Platform;
  /** Convenience flags. */
  isIOS: boolean;
  isAndroid: boolean;
  isIPad: boolean;
  /** Primary biometric for this platform (drives the unlock screen glyph/copy). */
  biometric: "Face ID" | "Touch ID" | "Fingerprint";
}

const PlatformCtx = createContext<PlatformInfo>({
  platform: "ios",
  isIOS: true,
  isAndroid: false,
  isIPad: false,
  biometric: "Face ID",
});

export function PlatformProvider({
  platform,
  children,
}: {
  platform: Platform;
  children: ReactNode;
}) {
  const info: PlatformInfo = {
    platform,
    isIOS: platform === "ios",
    isAndroid: platform === "android",
    isIPad: platform === "ipad",
    biometric: platform === "android" ? "Fingerprint" : "Face ID",
  };
  return <PlatformCtx.Provider value={info}>{children}</PlatformCtx.Provider>;
}

export function usePlatform(): PlatformInfo {
  return useContext(PlatformCtx);
}
