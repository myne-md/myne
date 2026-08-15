// Platform seam — `@tauri-apps/api/path`.
//
// `documentDir`, not desktop's `appDataDir`: the two clients address different
// directories on purpose. Mobile writes user-visible exports into the Documents
// container; the desktop's equivalent is its app-data directory. The seam names
// what its own host is asked for rather than mirroring the other client's
// member list.
//
// **This comment used to call that container "the one iOS surfaces in Files and
// Android exposes to the share sheet", and both halves were wrong** (myne#491).
// iOS declares no `UIFileSharingEnabled`, so the directory is invisible in the
// Files app there and the share sheet is the user's only route to a file in it.
// Android is the platform with no share sheet (`share_file.rs::present` is a
// documented no-op, myne#505), and its copy of the directory is
// `Android/data/<pkg>/files/Documents`, which the system Files app has refused
// to navigate into since Android 11 (API 30) while `minSdk` here is 24.
//
// The correction matters at THIS file rather than only at the call sites,
// because this is where a future export flow reads what the directory is. Every
// plaintext writer in the tree resolves through the accessor below, and that
// directory is excluded from the platform's automatic cloud backup on both
// platforms (`mobile/src-tauri/src/backup_exclude.rs`, myne#491). An export flow
// that reaches for a different accessor gets no such exclusion:
// `scripts/check-mobile-export-backup.mjs` fails the commit rather than letting
// one ship, and myne#517 is the follow-up that would make it unrepresentable.
//
// See `./core.ts` for why this tree has a seam.

export { documentDir, join } from "@tauri-apps/api/path";
