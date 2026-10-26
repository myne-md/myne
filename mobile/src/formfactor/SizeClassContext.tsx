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
 *   expanded     ≥ 1000px  sidebar 248 + list 316 + editor ≥ 360 (WS-01 three-pane)
 *   medium       ≥  700px  list + editor two-pane (desktop CENTER_MIN_WIDTH discipline)
 *   compactWide  ≥  600px  one column, the note takes the width, the list is an
 *                          overlay drawer (the unfolded foldable band), ONLY
 *                          when min(screen) < 700
 *   compact      the rest  the phone layout (full-screen list ↔ editor swap)
 *
 * The band is not a width-only row: a 600 to 700 window on a tablet's screen is
 * still `compact`, which is what keeps an iPad Split View window where it was.
 *
 * Phone guard: a device whose SMALLER screen dimension is under 480px is always
 * compact — this keeps phone-landscape (up to ~950px wide) on the phone layout
 * without UA sniffing. The guard reads `window.screen`, NOT the window height:
 * the Android IME shrinks the layout viewport when the keyboard opens, and a
 * window-height guard would flip the size class mid-typing (remounting the
 * editor and dismissing the keyboard — an open-close oscillation). `screen.*`
 * is IME-invariant, and taking the min of both axes makes it orientation-proof.
 *
 * Fold exception: on a device with two panels, `screen` describes the panel the
 * platform decided to report, which need not be the one the user is looking at.
 * A stale (folded) reading looks exactly like a window WIDER than the widest
 * dimension of its own screen, and that is the signature the guard yields to.
 *
 * The band's own gate is `min(screen) < 700`: every iPad clears it (744 and up),
 * so a 600pt Split View window keeps the phone layout it has today, while a
 * foldable satisfies it whichever panel it reports. Above 700 the foldable gets
 * the iPad arrangements unchanged, because the note's measure is already capped
 * at 620px and the extra width belongs to the list.
 */

export type SizeClass = "compact" | "compactWide" | "medium" | "expanded";

export interface SizeClassInfo {
  sizeClass: SizeClass;
  /** Any multi-pane layout (medium or expanded). `compactWide` is NOT regular:
   *  it is one column, and a second pane may never mount in it. */
  isRegular: boolean;
}

const PHONE_DEVICE_MAX = 480;
/** Above this, a "phone-class" screen reads as a tablet: every iPad is 744+. */
const FOLDABLE_DEVICE_MAX = 700;
const BAND_MIN = 600;
const MEDIUM_MIN = 700;
const EXPANDED_MIN = 1000;

export function computeSizeClass(): SizeClass {
  if (typeof window === "undefined") return "compact";
  const screen = window.screen;
  const screenMin = Math.min(screen.width, screen.height);
  const w = window.innerWidth;
  // A foldable reports the panel the platform chose, not necessarily the one in
  // use. A window wider than the widest dimension of the screen it reports is
  // that stale reading, and the guard yields to it rather than pinning an
  // unfolded device to the phone layout. No extra floor is needed: below
  // BAND_MIN the guard and the exception both answer compact, so the two paths
  // cannot disagree where it matters.
  const staleScreen = w > Math.max(screen.width, screen.height);
  if (!staleScreen && screenMin < PHONE_DEVICE_MAX) return "compact";
  if (w >= EXPANDED_MIN) return "expanded";
  if (w >= MEDIUM_MIN) return "medium";
  // The band is gated on a phone-class screen so it never reaches an iPad window.
  if (w >= BAND_MIN && screenMin < FOLDABLE_DEVICE_MAX) return "compactWide";
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

/** The one definition of "this layout can mount a second pane". `compactWide`
 *  is deliberately not in it: it is one column with an overlay drawer. */
export function isRegularSizeClass(sizeClass: SizeClass): boolean {
  return sizeClass === "medium" || sizeClass === "expanded";
}

export function SizeClassProvider({
  sizeClass,
  children,
}: {
  sizeClass: SizeClass;
  children: ReactNode;
}) {
  const info: SizeClassInfo = {
    sizeClass,
    isRegular: isRegularSizeClass(sizeClass),
  };
  return <SizeClassCtx.Provider value={info}>{children}</SizeClassCtx.Provider>;
}

export function useSizeClass(): SizeClassInfo {
  return useContext(SizeClassCtx);
}
