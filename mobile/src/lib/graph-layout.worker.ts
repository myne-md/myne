// Web Worker entry for the cold-start graph layout. Thin wiring only: the
// bounded force run lives in the pure `computeGraphLayout` kernel so it is
// unit-testable without a Worker. Instantiated from `runLayout()` via
// `new Worker(new URL("./graph-layout.worker.ts", import.meta.url), { type: "module" })`
// (Vite-native module worker). No IPC / DOM here — a worker cannot call Tauri
// `invoke`; the main thread hands over a resolved model and gets positions back.
// Module workers are unvalidated on WKWebView / Android WebView in this
// codebase — `runLayout()` carries the synchronous fallback.

import {
  computeGraphLayout,
  type LayoutRequest,
  type LayoutResponse,
} from "./graph-layout-kernel";

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
