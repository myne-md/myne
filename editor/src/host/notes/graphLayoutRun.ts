// `runLayout` — the one entry point for a graph layout computation
// (myne-md/myne#200). Prefers a module worker so the force run stays off the
// WebView main thread; falls back to a synchronous compute when the Worker
// cannot be constructed OR errors while loading. That fallback came from the
// mobile client, where module workers are unproven on WKWebView and the Android
// WebView, and a worker that fails to load surfaces as an `error` event rather
// than a constructor throw. Desktop never had it and now does.
//
// The worker ENTRY stays in each client's own tree and is passed in as
// `makeWorker`. That is deliberate: `new Worker(new URL("./x.worker.ts",
// import.meta.url))` has to be statically analysable by the bundler compiling
// that client, and a specifier resolved through the `@myne/editor` alias is
// not. The entry is ~20 lines of wiring; the kernel it wires is shared.

import { computeGraphLayout, type LayoutRequest, type LayoutResponse } from "./graphLayout";

export function runLayout(
  req: LayoutRequest,
  makeWorker: () => Worker,
): Promise<LayoutResponse> {
  return new Promise((resolve) => {
    const fallback = () => {
      // Defer one macrotask so the caller's mount frame (the seeded first
      // paint) reaches the screen before the stall.
      setTimeout(() => resolve(computeGraphLayout(req)), 0);
    };

    let worker: Worker;
    try {
      worker = makeWorker();
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
