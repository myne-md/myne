// Per-worker driver/native port bands for the PARALLEL e2e run.
//
// vitest runs each `*.e2e.ts` file in a worker slot; `VITEST_POOL_ID` is that
// slot (1..maxWorkers). Each concurrent worker drives its OWN tauri-driver +
// production app, so its port pair must not collide with a neighbour's.
//
// session.ts (`launchApp`) and multi-device.ts BOTH already resolve their port
// from `MYNE_E2E_DRIVER_PORT` / `MYNE_E2E_NATIVE_PORT` (env, defaulting to
// 4444/4445), so setting those here — once per worker, before the test module
// and its imports load — parallelises the whole harness with NO change to
// either file. The 100-port stride per slot leaves ample room for
// multi-device's own ±(index * PORT_STRIDE=10) per-device offset, so no
// worker's band ever reaches into the next slot's.
//
// Registered as a vitest `setupFiles` entry (vitest.e2e.config.ts). Runs on
// every platform; harmless where the harness self-skips (macOS has no
// tauri-driver — `harnessSupported()` short-circuits each scenario).

const slot = Number(process.env.VITEST_POOL_ID ?? "1");
const band = (Number.isFinite(slot) && slot > 0 ? slot - 1 : 0) * 100;

process.env.MYNE_E2E_DRIVER_PORT = String(4444 + band);
process.env.MYNE_E2E_NATIVE_PORT = String(4445 + band);
