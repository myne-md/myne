// Platform seam — `@tauri-apps/api/event`.
//
// Backend→UI push. The web implementation delivers Worker messages through
// the same `listen(name, handler) => Promise<UnlistenFn>` shape, so the
// subscribe/unsubscribe lifecycle every caller already writes (subscribe in
// an effect, await the unlisten in its cleanup) keeps working unchanged.
// The contract tests pin that lifecycle for both implementations.
//
// See `src/platform/core.ts` for why nothing here wraps.

export { listen } from "@tauri-apps/api/event";
export type { Event, EventCallback, UnlistenFn } from "@tauri-apps/api/event";
