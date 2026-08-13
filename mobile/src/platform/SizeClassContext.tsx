import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/**
 * Width-driven size class — the layout axis of the "one adaptive codebase"
 * strategy. Orthogonal to PlatformContext (platform = brand/biometric copy;
 * size class = pane layout). Deliberately driven by the WINDOW's width, not a
 * Tauri device API: iPad Split View narrows the window and must fall back to
 * the phone layout, and the Playwright flow tier drives it purely by viewport.
 *
 *   expanded  ≥ 1000px  sidebar 248 + list 316 + editor ≥ 360 (WS-01 three-pane)
 *   medium    ≥  700px  list + editor two-pane (desktop CENTER_MIN_WIDTH discipline)
 *   compact   <  700px  the phone layout (full-screen list ↔ editor swap)
 *
 * Phone guard: a device whose SMALLER screen dimension is under 480px is always
 * compact — this keeps phone-landscape (up to ~950px wide) on the phone layout
 * without UA sniffing. The guard reads `window.screen`, NOT the window height:
 * the Android IME shrinks the layout viewport when the keyboard opens, and a
 * window-height guard would flip the size class mid-typing (remounting the
 * editor and dismissing the keyboard — an open-close oscillation). `screen.*`
 * is IME-invariant, and taking the min of both axes makes it orientation-proof.
 */

export type SizeClass = "compact" | "medium" | "expanded";

export interface SizeClassInfo {
  sizeClass: SizeClass;
  /** Any multi-pane layout (medium or expanded). */
  isRegular: boolean;
}

const PHONE_DEVICE_MAX = 480;
const MEDIUM_MIN = 700;
const EXPANDED_MIN = 1000;

export function computeSizeClass(): SizeClass {
  if (typeof window === "undefined") return "compact";
  const deviceMin = Math.min(window.screen.width, window.screen.height);
  if (deviceMin < PHONE_DEVICE_MAX) return "compact";
  const w = window.innerWidth;
  if (w >= EXPANDED_MIN) return "expanded";
  if (w >= MEDIUM_MIN) return "medium";
  return "compact";
}

/** Live size class of the current window (resize + rotation aware). */
export function useSizeClassObserver(): SizeClass {
  const [sizeClass, setSizeClass] = useState<SizeClass>(computeSizeClass);
  useEffect(() => {
    const update = () => setSizeClass(computeSizeClass());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return sizeClass;
}

const SizeClassCtx = createContext<SizeClassInfo>({
  sizeClass: "compact",
  isRegular: false,
});

export function SizeClassProvider({
  sizeClass,
  children,
}: {
  sizeClass: SizeClass;
  children: ReactNode;
}) {
  const info: SizeClassInfo = {
    sizeClass,
    isRegular: sizeClass !== "compact",
  };
  return <SizeClassCtx.Provider value={info}>{children}</SizeClassCtx.Provider>;
}

export function useSizeClass(): SizeClassInfo {
  return useContext(SizeClassCtx);
}
