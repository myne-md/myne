// Platform seam — `@tauri-apps/api/event`.
//
// Backend→UI push, plus the UI→UI `emit` two flows use to fan a local signal
// across sibling components (`app/flows/EditorFlow.tsx`, `lib/share.ts`).
//
// `emit` is exported here and NOT in the desktop seam, because no desktop
// module calls it. That asymmetry is stated rather than smoothed over: a seam
// models what its host is asked to do, and adding an unused member to the
// desktop side to make the two files match would be inventing a call site.
//
// See `./core.ts` for why this tree has a seam and why nothing here wraps.

export { emit, listen } from "@tauri-apps/api/event";
export type { Event, EventCallback, UnlistenFn } from "@tauri-apps/api/event";
