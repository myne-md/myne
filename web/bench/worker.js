// The benchmark's worker (phase3-web-client task 63).
//
// A Worker rather than the page, and not for tidiness: `createSyncAccessHandle`
// is worker-only in every target browser — the Phase 0 spike confirmed it, and
// it is the architectural constraint the whole client is built around. A
// benchmark measuring OPFS from the main thread would measure a different API
// than the one the app uses.
//
// Timing lives here rather than in wasm because `Instant::now()` panics on
// wasm32 (a correction the Phase 0 session paid for once already), so
// `performance.now()` is the one clock and this is the one place that reads it.

import init, { bench_argon2id_once, bench_params_json } from "./pkg/myne_web_bench.js";

/** Median of a sample set. Median, not mean: one scheduler hiccup should not
 *  move the number a reader is meant to compare across browsers. */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function benchArgon2id(runs) {
  // One warm-up, discarded — the first 256 MiB allocation is a page-fault storm
  // that measures the allocator. The native half discards one for the same
  // reason, or the ratio would compare a cold run against a warm one.
  bench_argon2id_once();

  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const first = bench_argon2id_once();
    samples.push(performance.now() - t0);
    if (typeof first !== "number") throw new Error("derivation did not return a byte");
  }
  return {
    runs,
    median_ms: +median(samples).toFixed(1),
    min_ms: +Math.min(...samples).toFixed(1),
    max_ms: +Math.max(...samples).toFixed(1),
    params: JSON.parse(bench_params_json()),
  };
}

/** A directory the benchmark owns, wiped before and after so a re-run measures
 *  the same starting state and leaves nothing behind in the user's origin. */
async function benchDir() {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry("bench", { recursive: true });
  } catch {
    /* absent on a first run — not an error */
  }
  return root.getDirectoryHandle("bench", { create: true });
}

async function writeFile(dir, name, bytes) {
  const h = await dir.getFileHandle(name, { create: true });
  // `createSyncAccessHandle` where available (the app's own write path), since
  // that is what the number is supposed to describe.
  if (h.createSyncAccessHandle) {
    const sync = await h.createSyncAccessHandle();
    sync.write(bytes, { at: 0 });
    sync.flush();
    sync.close();
    return;
  }
  const w = await h.createWritable();
  await w.write(bytes);
  await w.close();
}

async function benchOpfs(noteCount, noteBytes, bigBytes) {
  const dir = await benchDir();
  const note = new Uint8Array(noteBytes).fill(0x4d);

  const t0 = performance.now();
  for (let i = 0; i < noteCount; i++) {
    await writeFile(dir, `note-${i}.myn`, note);
  }
  const writeMs = performance.now() - t0;

  const t1 = performance.now();
  let total = 0;
  for (let i = 0; i < noteCount; i++) {
    const f = await (await dir.getFileHandle(`note-${i}.myn`)).getFile();
    total += (await f.arrayBuffer()).byteLength;
  }
  const readMs = performance.now() - t1;
  if (total !== noteCount * noteBytes) throw new Error("read back the wrong number of bytes");

  const big = new Uint8Array(bigBytes).fill(0x42);
  const t2 = performance.now();
  await writeFile(dir, "big.bin", big);
  const bigMs = performance.now() - t2;

  const root = await navigator.storage.getDirectory();
  await root.removeEntry("bench", { recursive: true });

  return {
    note_count: noteCount,
    note_bytes: noteBytes,
    write_total_ms: +writeMs.toFixed(0),
    write_ms_per_file: +(writeMs / noteCount).toFixed(2),
    read_total_ms: +readMs.toFixed(0),
    big_write_mib: +(bigBytes / (1024 * 1024)).toFixed(0),
    big_write_ms: +bigMs.toFixed(0),
    sync_access_handle: typeof (await (await benchDir()).getFileHandle("probe", { create: true }))
      .createSyncAccessHandle === "function",
  };
}

self.onmessage = async (e) => {
  const { kdfRuns = 5, noteCount = 400, noteBytes = 4096, bigBytes = 32 * 1024 * 1024 } =
    e.data ?? {};
  try {
    await init();
    const kdf = await benchArgon2id(kdfRuns);
    const opfs = await benchOpfs(noteCount, noteBytes, bigBytes);
    // Cleanup after the sync-access-handle probe re-created the directory.
    try {
      (await navigator.storage.getDirectory()).removeEntry("bench", { recursive: true });
    } catch {
      /* best effort */
    }
    self.postMessage({
      ok: true,
      kind: "browser",
      cross_origin_isolated: self.crossOriginIsolated,
      kdf,
      opfs,
    });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.stack) || err) });
  }
};
