// Web Worker entry for the graph layout (Phase A4 / Tier 1). Thin wiring only:
// the heavy d3-force run lives in the pure `computeGraphLayout` kernel so it is
// unit-testable without a Worker. Instantiated from `GraphCanvas` via
// `new Worker(new URL("../graphLayout.worker.ts", import.meta.url), { type: "module" })`
// (Vite-native module worker). No IPC / DOM here — a worker cannot call Tauri
// `invoke`; the main thread does the edge dump and hands over a resolved model.

import {
  computeGraphLayout,
  type LayoutRequest,
  type LayoutResponse,
} from "./graphLayoutProtocol";

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
