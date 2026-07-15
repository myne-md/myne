// Self-hosted Excalidraw asset base (drawing-notes SF1, MYND-498; SYNC-5).
//
// Excalidraw fetches its hand-drawn fonts from a CDN (unpkg) by default. Myne's
// CSP (`font-src 'self' data:`) + the compiled `no_egress` allowlist + the
// `ai-no-network` CI gate forbid any external fetch, so we vendor
// `@excalidraw/excalidraw/dist/prod/fonts` into `public/excalidraw-assets/fonts`
// (Vite copies `public/` verbatim into `dist/`) and repoint Excalidraw's loader
// here. Every font then resolves same-origin at `/excalidraw-assets/fonts/...`.
//
// Set as a boot side-effect (imported first in main.tsx) so the global is in
// place long before the lazy Excalidraw chunk ever loads. Excalidraw reads
// `window.EXCALIDRAW_ASSET_PATH` at font-load time.
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

if (typeof window !== "undefined") {
  window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";
}

export {};
