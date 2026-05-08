/// <reference types="vite/client" />

/**
 * Compile-time injection from `vite.config.ts`'s `define` block.
 * Sourced from `package.json::version`. Used by `AboutPanel` to
 * display "Myne <version>" in Settings → About.
 */
declare const __APP_VERSION__: string;
