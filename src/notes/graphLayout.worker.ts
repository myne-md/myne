// Web Worker entry for the graph layout. Thin wiring only: the simulation and
// the streaming loop live in the SHARED modules (myne-md/myne#200 for the
// kernel, myne-md/myne#727 for the run contract), which every client uses and
// which are testable without a Worker.
//
// This entry stays in the desktop tree — and its mobile twin in mobile's — even
// though everything it calls is shared, because
// `new Worker(new URL("…", import.meta.url))` has to be statically analysable
// by the bundler compiling THIS client, and a specifier resolved through the
// `@myne/editor` alias is not. Instantiated from the shared `startLayout()`,
// which owns the worker's lifetime and terminates it on teardown.
//
// No IPC / DOM here — a worker cannot call Tauri `invoke`; the main thread does
// the edge dump and hands over a resolved model.

import {
  serveLayoutWorker,
  type WorkerScope,
} from "@myne/editor/host/notes/graphLayoutServe";

// The tsconfig `lib` is DOM-only (no WebWorker lib), so `self` types as `Window`
// whose `postMessage` demands a `targetOrigin`. `WorkerScope` is the narrow
// shape this driver actually uses, which keeps the file typechecking under
// `pnpm build`.
serveLayoutWorker(self as unknown as WorkerScope);
