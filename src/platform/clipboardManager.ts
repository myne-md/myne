// Platform seam — `@tauri-apps/plugin-clipboard-manager`.
//
// WRITE ONLY, and the absence is the point (myne#379). The seam used to
// re-export `readText` and `clear` as well, for one consumer: the 30 s
// auto-clear in `src/lib/secret-export.ts`, which read the clipboard back to
// check it still held the recovery phrase before wiping it. That comparison now
// runs host-side (`plugin:secret-export|clipboard_clear_if_matches`), so the
// main window no longer holds a process-lifetime OS-clipboard READ grant —
// `clipboard-manager:allow-read-text` and `allow-clear` are both out of
// `capabilities/default.json`.
//
// The members are removed rather than left exported-but-unused on purpose: an
// unused seam member is a door the next caller can reopen with no ACL edit and
// no review, and here it would not even fail loudly — a `readText()` call would
// compile, ship, and be refused only at runtime. Restoring either one means
// restoring its capability entry in the same change, which is the review this
// is protecting.
//
// A seam models host capability rather than current use, so this IS a narrowing
// of what the seam claims the host will do — deliberately, because the desktop
// capability really did narrow.

export { writeText } from "@tauri-apps/plugin-clipboard-manager";
