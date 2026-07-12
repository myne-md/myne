import { useEffect, useState } from "react";
import { Gallery } from "./gallery/Gallery";
import { AppShell } from "./app/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PlatformProvider, type Platform } from "./platform/PlatformContext";
import { SizeClassProvider, useSizeClassObserver } from "./platform/SizeClassContext";
import { useSyncLifecycle } from "./lib/use-sync-lifecycle";

/**
 * Track the VISUAL viewport so the app fills *exactly* the space above the
 * on-screen keyboard. Two symptoms this fixes on iOS WKWebView:
 *
 *   1. Header drifting behind the status bar. When a textarea autofocuses,
 *      WKWebView scrolls its internal scroll view to reveal the caret, sliding
 *      our position:fixed body up — the visual viewport's `offsetTop` becomes
 *      positive while our container stays pinned at document-top, so the header
 *      ends up above the visible area (under the notch/status bar).
 *   2. A dead gap under the footer. Binding height alone to `visualViewport`
 *      isn't enough if the container top no longer aligns with the visible top.
 *
 * Binding BOTH `height` and a `translateY(offsetTop)` makes the container follow
 * the visible viewport precisely: footer sits right on the keyboard, header
 * stays under the notch. `scroll` events matter as much as `resize` because the
 * offset changes as the caret moves.
 */
interface Viewport {
  height: number;
  offsetTop: number;
}
function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>(() => ({
    height: typeof window !== "undefined" ? window.innerHeight : 800,
    offsetTop: 0,
  }));
  useEffect(() => {
    const vv = window.visualViewport;
    const update = () =>
      setVp(vv ? { height: vv.height, offsetTop: vv.offsetTop } : { height: window.innerHeight, offsetTop: 0 });
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return vp;
}

/**
 * Two entry points:
 *   - default: the real, wired app (AppShell — Stage machine + functional flows
 *     backed by the mirrored Tauri vault/notes/prefs backend).
 *   - `?gallery`: the static design gallery — every screen in its device frame
 *     with platform/theme toggles, for pixel-faithful design review.
 *
 * The real app fills the viewport; on a wide desktop preview (`pnpm tauri dev`)
 * it's centred at phone width.
 */
function detectPlatform(): Platform {
  if (typeof navigator !== "undefined" && /android/i.test(navigator.userAgent)) return "android";
  return "ios";
}

export default function App() {
  const showGallery =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("gallery");
  const { height, offsetTop } = useViewport();
  const sizeClass = useSizeClassObserver();

  // Background/foreground → sync scheduler suspend/resume (SYNC-37/38). Gallery
  // previews skip it (no Tauri backend; the hook's invokes would just no-op).
  useSyncLifecycle(!showGallery);

  // Real app only: pin the document so iOS can't scroll the whole page up when
  // the keyboard opens (the gallery board keeps its free scroll — class absent).
  useEffect(() => {
    if (showGallery) return;
    const html = document.documentElement;
    html.classList.add("app-locked");
    return () => html.classList.remove("app-locked");
  }, [showGallery]);

  if (showGallery) return <Gallery />;

  return (
    <div
      data-size-class={sizeClass}
      style={{
        height,
        width: "100%",
        position: "relative",
        overflow: "hidden",
        background: "var(--bg-1)",
        // Landscape-tablet safe areas (rounded corners / camera housings).
        // Resolves to 0 wherever it doesn't apply. The old phone cage
        // (maxWidth 480) moved into <PhoneColumn> around the single-column
        // flows (AppShell) — the editor is adaptive (SizeClassContext).
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
        // Follow the visible viewport's top edge — see useViewport(). Keeps the
        // header under the notch and the footer glued to the keyboard when iOS
        // scrolls the layout viewport on input focus.
        transform: offsetTop ? `translateY(${offsetTop}px)` : undefined,
      }}
    >
      <PlatformProvider platform={detectPlatform()}>
        <SizeClassProvider sizeClass={sizeClass}>
          <ErrorBoundary>
            <AppShell />
          </ErrorBoundary>
        </SizeClassProvider>
      </PlatformProvider>
    </div>
  );
}
