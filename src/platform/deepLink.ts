// Platform seam — `@tauri-apps/plugin-deep-link`.
//
// Loaded lazily because the plugin is desktop-only and the import itself
// pulls in a Tauri IPC binding: `src/lib/themeDeepLink.ts` guards on
// `HAS_TAURI` before awaiting it, so the module never loads in a context
// that has no Tauri runtime. Keeping the dynamic import inside the seam (a
// static re-export would defeat the laziness) means the web build can
// substitute a module that resolves to the no-op handler set.

export async function loadDeepLink(): Promise<{
  getCurrent: () => Promise<string[] | null>;
  onOpenUrl: (handler: (urls: string[]) => void) => Promise<() => void>;
}> {
  const mod = await import("@tauri-apps/plugin-deep-link");
  return { getCurrent: mod.getCurrent, onOpenUrl: mod.onOpenUrl };
}
