// `runLayout` — the one entry point for a cold-start layout computation.
// Prefers the Vite module worker (keeps the O(n²) force run off the WebView
// main thread); falls back to a synchronous main-thread compute when the
// Worker cannot be constructed OR errors while loading — module workers are
// unproven on WKWebView / Android WebView in this codebase, and a
// worker-that-fails-to-load surfaces as an `error` event, not a constructor
// throw. The fallback defers one macrotask so the caller's mount frame (the
// ring-seeded first paint) hits the screen before the stall.

import {
  computeGraphLayout,
  type LayoutRequest,
  type LayoutResponse,
} from "./graph-layout-kernel";

export function runLayout(req: LayoutRequest): Promise<LayoutResponse> {
  return new Promise((resolve) => {
    const fallback = () => {
      setTimeout(() => resolve(computeGraphLayout(req)), 0);
    };

    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./graph-layout.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      fallback();
      return;
    }

    let settled = false;
    worker.onmessage = (e: MessageEvent<LayoutResponse>) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      fallback();
    };
    worker.postMessage(req);
  });
}
