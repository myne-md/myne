// Platform seam — `@tauri-apps/api/webviewWindow`.
//
// Used for per-webview event scoping (`getCurrentWebviewWindow().listen(...)`).
// On web there is exactly one page context, so the web implementation returns
// a handle whose `listen` is the same subscription the plain event module
// serves.

export { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
