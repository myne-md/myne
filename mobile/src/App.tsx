import { Gallery } from "./gallery/Gallery";
import { AppShell } from "./app/AppShell";
import { PlatformProvider, type Platform } from "./platform/PlatformContext";

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

  if (showGallery) return <Gallery />;

  return (
    <div
      style={{
        height: "100vh",
        width: "100%",
        maxWidth: 480,
        margin: "0 auto",
        position: "relative",
        overflow: "hidden",
        background: "var(--bg-1)",
      }}
    >
      <PlatformProvider platform={detectPlatform()}>
        <AppShell />
      </PlatformProvider>
    </div>
  );
}
