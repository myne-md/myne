// Web Worker entry for the graph layout. Thin wiring only: the bounded force
// run lives in the SHARED `computeGraphLayout` kernel (myne-md/myne#200), which
// desktop uses too and which is testable without a Worker.
//
// This entry stays in the mobile tree even though the kernel is shared, because
// `new Worker(new URL("…", import.meta.url))` has to be statically analysable
// by the bundler compiling THIS client, and a specifier resolved through the
// `@myne/editor` alias is not. Instantiated from the shared `runLayout()`,
// which carries the synchronous fallback module workers still need here —
// they are unvalidated on WKWebView / the Android WebView in this codebase.
// No IPC / DOM here — a worker cannot call Tauri `invoke`; the main thread
// hands over a resolved model and gets positions back.

import {
  computeGraphLayout,
  type LayoutRequest,
  type LayoutResponse,
} from "@myne/editor/host/notes/graphLayout";

// The tsconfig `lib` is DOM-only (no WebWorker lib), so `self` types as `Window`
// whose `postMessage` demands a `targetOrigin`. Narrow to the worker scope's
// minimal shape to keep the file typechecking under `pnpm build`.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<LayoutRequest>) => void) | null;
  postMessage: (message: LayoutResponse) => void;
};

ctx.onmessage = (e: MessageEvent<LayoutRequest>) => {
  ctx.postMessage(computeGraphLayout(e.data));
};
