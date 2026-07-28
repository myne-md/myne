// Platform seam — `@tauri-apps/plugin-clipboard-manager`.
//
// Secret export (`src/lib/secret-export.ts`) writes a credential to the
// clipboard and clears it again. The browser's async Clipboard API can write
// and (with permission) read, but `clear()` has no equivalent — the web
// implementation overwrites with an empty string, which is weaker, and the
// capability descriptor records that difference rather than hiding it.

export { writeText, readText, clear } from "@tauri-apps/plugin-clipboard-manager";
