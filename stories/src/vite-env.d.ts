/// <reference types="vite/client" />

/**
 * Compile-time globals the stories Vite config defines (myne-md/myne#845).
 *
 * `__APP_VERSION__` is also declared by the app's own `src/vite-env.d.ts`; it is
 * repeated here so the catalogue does not depend on that file being in scope.
 * `__STORIES_BRANCH__` is the branch a source link is pinned to.
 * `__STORIES_PUBLIC__` is true for the variant served at `design.myne.md`, which
 * renders neither the source link nor the issue form — see `vite.config.ts`.
 */
declare const __APP_VERSION__: string;
declare const __STORIES_BRANCH__: string;
declare const __STORIES_PUBLIC__: boolean;
