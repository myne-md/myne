// Storage-quota precheck before the first sync materialises a vault
// (phase3-web-client task 24).
//
// NOT WIRED YET. Nothing in the client calls `precheckQuota` — only this
// module's unit test imports it, and `scripts/check-unwired.mjs` records that
// as a violation in so many words: "the precheck the web client is documented
// to run does not run". Everything below describes the DESIGN and is written in
// the present tense; until a boot-path caller exists, none of it happens.
//
// This notice is load-bearing rather than a courtesy. The paragraph after it
// states "the check happens before any write, and a refusal leaves nothing
// behind" as fact, and a reader deciding whether this area needs work would
// conclude it is done. `tests/web/quotaPrecheckWiring.test.ts` holds the two
// together in BOTH directions: it fails while the module is unwired and this
// notice is absent, and it fails again the day a production importer lands and
// the notice is still here (myne-md/myne#556).
//
// It also blocks a test. The `web.storage.quota-exhaustion` bullet asks for a
// browser scenario driving CDP's `Storage.overrideQuotaForOrigin` to force a
// refusal; that scenario cannot be written against a module on no code path,
// and writing it anyway would produce a failure saying the app ignored the
// quota — true, and useless.
//
// The failure this exists to prevent is a *partial* vault. Materialising a
// large vault into OPFS is thousands of writes; running out of quota halfway
// leaves a container that is neither empty nor complete, and the client cannot
// tell those apart after the fact — a half-materialised vault looks exactly
// like a vault the user has only partly synced. So the check happens **before
// any write**, and a refusal leaves nothing behind.
//
// Measured headroom from the Phase 0 spike: Chrome 10 GB, Firefox 10 GB,
// Safari 76.8 GB. So this refuses rarely — which is precisely why it has to be
// legible when it does. A rare error path that says "quota exceeded" and
// nothing else is a support ticket; one that names the shortfall is an action.
//
// Deliberately NOT here: requesting persistence. `navigator.storage.persist()`
// is Window-only and the spike could not call it (the probe ran in a Worker);
// whether it is granted without a user gesture is unmeasured and is PRD open
// question 1. Asking for something we cannot predict the answer to, in the
// middle of a precheck, would make the precheck's own result nondeterministic.

/** Fraction of remaining quota we are willing to fill in one materialisation. */
const HEADROOM_FRACTION = 0.9;

/** Narrowed `navigator.storage`, so tests can drive it. */
export interface StorageEstimator {
  estimate(): Promise<{ quota?: number; usage?: number }>;
}

export type QuotaVerdict =
  | { ok: true; availableBytes: number }
  | { ok: false; reason: "insufficient"; requiredBytes: number; availableBytes: number; shortfallBytes: number }
  | { ok: false; reason: "unknown" };

function defaultEstimator(): StorageEstimator | null {
  const s = (globalThis.navigator as unknown as { storage?: StorageEstimator } | undefined)?.storage;
  return s && typeof s.estimate === "function" ? s : null;
}

/**
 * Decide whether `requiredBytes` can be materialised.
 *
 * `reason: "unknown"` is returned when the browser reports no usable estimate —
 * and it is deliberately **not** folded into either "ok" or "insufficient".
 * Treating an absent estimate as ok would reintroduce the partial-vault failure
 * it exists to prevent; treating it as insufficient would refuse a user whose
 * storage is fine. It is a third outcome because it is a third situation, and
 * the caller decides (task 39's first-sync flow warns and proceeds).
 */
export async function precheckQuota(
  requiredBytes: number,
  estimator: StorageEstimator | null = defaultEstimator(),
): Promise<QuotaVerdict> {
  if (!estimator) return { ok: false, reason: "unknown" };

  let estimate: { quota?: number; usage?: number };
  try {
    estimate = await estimator.estimate();
  } catch {
    return { ok: false, reason: "unknown" };
  }

  const quota = estimate.quota;
  const usage = estimate.usage ?? 0;
  if (typeof quota !== "number" || !Number.isFinite(quota) || quota <= 0) {
    return { ok: false, reason: "unknown" };
  }

  // Headroom, not the raw remainder: filling a browser's quota to the last byte
  // is how you get evicted, and the client needs room for the writes that come
  // *after* materialisation (index rebuild, prefs, the sync baseline).
  const availableBytes = Math.max(0, Math.floor((quota - usage) * HEADROOM_FRACTION));

  if (requiredBytes > availableBytes) {
    return {
      ok: false,
      reason: "insufficient",
      requiredBytes,
      availableBytes,
      shortfallBytes: requiredBytes - availableBytes,
    };
  }
  return { ok: true, availableBytes };
}

/** Human-readable byte size. Deliberately coarse — this is for a sentence, not a meter. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * The refusal sentence. Names the shortfall, because "not enough space" alone
 * does not tell the user whether to free 10 MB or 10 GB.
 */
export function describeShortfall(v: Extract<QuotaVerdict, { reason: "insufficient" }>): string {
  return `This vault needs ${formatBytes(v.requiredBytes)} of browser storage and ${formatBytes(
    v.availableBytes,
  )} is available — ${formatBytes(v.shortfallBytes)} short.`;
}
