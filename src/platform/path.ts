// Platform seam — `@tauri-apps/api/path`.
//
// Path arithmetic over the OS filesystem. On web there is no filesystem to
// address: OPFS is reached by name through the Worker, never by absolute
// path, so the web implementation of `appDataDir` returns the vault's OPFS
// container name and `join` stays pure string arithmetic.

export { appDataDir, join } from "@tauri-apps/api/path";
