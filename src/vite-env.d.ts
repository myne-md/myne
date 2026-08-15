/// <reference types="vite/client" />

/**
 * Compile-time injection from `vite.config.ts`'s `define` block.
 * Sourced from `package.json::version`. Used by `AboutPanel` to
 * display "Myne <version>" in Settings → About.
 */
declare const __APP_VERSION__: string;
/**
 * The short commit this build came from, PER TARGET.
 *
 * Desktop and mobile: `git rev-parse --short=9`, or `"unknown"` outside a
 * git checkout (task 114). **Web: the fixed literal `"unknown"`**, so the
 * bundle takes no commit from its build environment and a local build hashes
 * the same as the container one (myne-md/myne#458). The web client's real
 * commit arrives at runtime from the served `version.json`, through
 * `servedBuildInfo()` on the platform seam.
 */
declare const __BUILD_COMMIT__: string;
