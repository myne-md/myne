// Platform seam — `@tauri-apps/plugin-clipboard-manager`.
//
// Three members, one caller (`lib/secret-export.ts`): write the recovery
// phrase, read it back 30 s later, clear it only if it still matches.
//
// ── this seam does NOT match its desktop twin, and that is a finding ────────
//
// `src/platform/clipboardManager.ts` exports `writeText` ALONE. It used to
// export all three for this same auto-clear, and myne#379 removed the other two
// because holding a process-lifetime OS-clipboard READ grant to run a
// comparison is the wrong trade: the read-back moved host-side
// (`plugin:secret-export|clipboard_clear_if_matches`) and
// `clipboard-manager:allow-read-text` plus `allow-clear` left
// `src-tauri/capabilities/default.json` in the same change.
//
// Mobile never got that change. Worse, and measured while writing this file:
// `mobile/package.json` depends on the JS package, but
// `mobile/src-tauri/Cargo.toml` has no `tauri-plugin-clipboard-manager` and
// `mobile/src-tauri/capabilities/default.json` grants no `clipboard-manager:*`
// permission — so the Rust half of the plugin is not registered at all and
// none of these three calls can reach a command on a device. The caller wraps
// them in a `catch` that logs an error kind, which is why nothing surfaced.
//
// Kept as-is here ON PURPOSE. Routing the call through the seam is a mechanical
// move that must not change behaviour, and the fix (port the host-side
// clear-if-matches command to mobile, or drop the affordance) is its own change
// with its own review. Recorded here, in the file a reader reaches first,
// rather than left for the next person to rediscover.
//
// See `./core.ts` for why this tree has a seam.

export { writeText, readText, clear } from "@tauri-apps/plugin-clipboard-manager";
