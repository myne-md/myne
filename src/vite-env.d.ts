/// <reference types="vite/client" />

/**
 * Compile-time injection from `vite.config.ts`'s `define` block.
 * Sourced from `package.json::version`. Used by `AboutPanel` to
 * display "Myne <version>" in Settings → About.
 */
declare const __APP_VERSION__: string;
/** The short commit this build came from, or `"unknown"` (task 114). */
declare const __BUILD_COMMIT__: string;
