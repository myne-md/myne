// Platform seam — `@tauri-apps/plugin-deep-link`.
//
// Loaded lazily, and the laziness is the caller's design rather than this
// file's: `lib/deep-link.ts` guards on `HAS_TAURI` and then swallows a failed
// load ("plugin missing / older host — deep links are simply inert"). A static
// re-export would defeat both halves, so the dynamic import moves INTO the seam
// instead of being flattened by it. Same shape as `src/platform/deepLink.ts`.
//
// See `./core.ts` for why this tree has a seam.

export async function loadDeepLink(): Promise<{
  getCurrent: () => Promise<string[] | null>;
  onOpenUrl: (handler: (urls: string[]) => void) => Promise<() => void>;
}> {
  const mod = await import("@tauri-apps/plugin-deep-link");
  return { getCurrent: mod.getCurrent, onOpenUrl: mod.onOpenUrl };
}
