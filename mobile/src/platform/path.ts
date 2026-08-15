// Platform seam — `@tauri-apps/api/path`.
//
// `documentDir`, not desktop's `appDataDir`: the two clients address different
// directories on purpose. Mobile writes user-visible exports into the Documents
// container (the one iOS surfaces in Files and Android exposes to the share
// sheet); the desktop's equivalent is its app-data directory. The seam names
// what its own host is asked for rather than mirroring the other client's
// member list.
//
// See `./core.ts` for why this tree has a seam.

export { documentDir, join } from "@tauri-apps/api/path";
