// Platform seam — `@tauri-apps/plugin-opener`.
//
// `openUrl` has a browser equivalent (`window.open`); `openPath` and
// `revealItemInDir` do not — a browser cannot open a local file in the user's
// default app nor reveal it in a file manager. Those two are the canonical
// examples of the typed "unsupported on web" outcome, and the capability
// descriptor omits their affordances rather than showing them broken
// (`prd.md` story 19).

export { openUrl, openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
