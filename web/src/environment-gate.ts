// Unsupported-environment gate (phase3-web-client task 29).
//
// Mobile browsers are out of scope, and people will open the URL on a phone
// anyway. The failure that must not happen is a crash *mid-derivation*: iOS
// Safari cannot reliably allocate the 256 MiB Argon2id block, and the
// parameters are AAD-bound and read from `vault.meta`, so they cannot be
// lowered for a constrained device without producing a vault no other client
// can open (`protocol.md` §4.1, §4.2). Refusing up front is therefore the only
// honest option: the alternative is a browser tab that dies half a second into
// unlocking, with nothing said and nothing to act on.
//
// **Capability detection, never a user-agent string.** UA sniffing is wrong in
// both directions here — it refuses a capable browser it does not recognise,
// and it admits an incapable one that lies (every mobile browser has, at some
// point, claimed to be a desktop one). The probes below ask the platform the
// questions the client actually depends on, and the memory probe in particular
// asks the *exact* question that decides whether unlocking can work at all.
//
// Every probe here is cheap and side-effect-free. `WebAssembly.Memory` is a
// virtual reservation, not a commit, so the headroom probe costs a syscall on a
// capable machine and throws immediately on one that cannot serve it.
//
// ── and the reason capability probing alone was not enough ───────────────────
//
// That last sentence is also the hole. A virtual reservation is exactly what a
// 64-bit Android Chrome serves without hesitation: it has OPFS, synchronous
// access handles, Web Locks and a CSPRNG, so every probe below goes green and a
// phone reaches a mounted desktop UI on a 390 px touch screen — and, on the
// devices whose reservation was a promise rather than a fact, still dies part-way
// into Argon2id. iPadOS Safari makes the same trip while presenting itself as
// desktop Safari.
//
// So there is a second, earlier refusal: **device class**. This client is the
// desktop-browser client; phones and tablets have native apps that are better on
// every axis, and admitting one here has no good outcome. The stance above is
// NARROWED by this, not abandoned — nothing here parses a user-agent string. The
// signals are a boolean the platform publishes (`navigator.userAgentData.mobile`),
// two CSS media features about the primary input device, and a touch-point count.
// See `isMobileFormFactor` for what each one is for and, more importantly, for
// the one signal deliberately absent from the list.

/** Everything the client structurally requires to open a vault at all. */
export type RequiredCapability =
  /** Not a browser API — a precondition. See `isMobileFormFactor`. */
  | "desktop-form-factor"
  | "webassembly"
  | "wasm-memory-headroom"
  | "worker"
  | "opfs"
  | "opfs-sync-access-handle"
  | "web-locks"
  | "crypto-getrandomvalues"
  /** Not a browser feature the user chose — a DEPLOYMENT one. See
   *  `hasCrossOriginIsolation`. */
  | "cross-origin-isolation";

export interface EnvironmentVerdict {
  supported: boolean;
  /** Capabilities that are missing. Empty when `supported`. */
  missing: RequiredCapability[];
}

// ── device class ─────────────────────────────────────────────────────────────

/**
 * What the platform will tell us about the device it is running on, gathered in
 * one place so the decision below is a pure function of four values.
 */
export interface FormFactorSignals {
  /** `navigator.userAgentData.mobile` — `undefined` where UA-CH is not shipped. */
  uaDataMobile: boolean | undefined;
  /** `(pointer: coarse) and (hover: none)` — the PRIMARY input device. */
  coarsePrimaryPointer: boolean;
  /** `navigator.maxTouchPoints`. */
  maxTouchPoints: number;
  /** `navigator.platform`. Deprecated, and used here for exactly one thing. */
  platform: string;
}

/** Read the signals from the running browser. Never throws. */
export function readFormFactorSignals(): FormFactorSignals {
  const nav =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & {
          userAgentData?: { mobile?: boolean };
          maxTouchPoints?: number;
          platform?: string;
        })
      : undefined;
  return {
    uaDataMobile: nav?.userAgentData?.mobile,
    coarsePrimaryPointer:
      typeof matchMedia === "function" &&
      matchMedia("(pointer: coarse) and (hover: none)").matches,
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    platform: nav?.platform ?? "",
  };
}

/**
 * Is this a phone or a tablet?
 *
 * Three signals, OR-ed, because each covers a device the others miss:
 *
 * 1. **`uaDataMobile`** — the browser's own structured answer. Chromium sets it
 *    on Android and it is the cheapest correct case. Absent on WebKit and
 *    Gecko, which is why it cannot be the only signal.
 * 2. **`coarsePrimaryPointer`** — phones and tablets, including iPadOS Safari
 *    under "Request Desktop Website", where every string lies and the media
 *    features do not. The media query asks about the PRIMARY pointer, so a
 *    touch-screen Windows laptop — whose primary pointer is `fine` and which
 *    hovers — is not caught by it. That distinction is the whole reason this is
 *    `(pointer: coarse)` rather than `any-pointer`.
 * 3. **`maxTouchPoints > 1` on a Mac platform** — an iPad with a trackpad or a
 *    mouse attached, which reports `pointer: fine` / `hover: hover` and
 *    `platform === "MacIntel"`, and is otherwise indistinguishable from a
 *    desktop Safari. A real Mac reports `maxTouchPoints === 0`; a Magic
 *    Trackpad does not change that, because it is not a touchscreen.
 *
 * **Viewport width is deliberately not a signal, and must not become one.** A
 * desktop window snapped to a quarter of the screen is ~400 px wide and is a
 * SUPPORTED configuration — `e2e-web/isolation-and-viewport.e2e.ts` pins
 * 400 × 900 as the narrow end of the range this client is expected to lay out
 * for. A width rule would refuse that window, and it would refuse it silently,
 * on the one signal a user can change by dragging an edge.
 */
export function isMobileFormFactor(s: FormFactorSignals): boolean {
  if (s.uaDataMobile === true) return true;
  if (s.coarsePrimaryPointer) return true;
  return s.maxTouchPoints > 1 && /^Mac/.test(s.platform);
}

/**
 * Argon2id at the v0.1 baseline needs a 256 MiB block; the Phase 0 spike
 * measured wasm linear memory settling at **321 MiB** across all three
 * browsers (the block plus allocator overhead). Probe a little above that so a
 * browser that can serve 256 MiB but not the real working set is caught here
 * rather than mid-KDF.
 */
const REQUIRED_WASM_PAGES = Math.ceil((336 * 1024 * 1024) / 65536);

/** Injectable global, so the probes are testable without a real browser. */
export interface EnvironmentProbes {
  isMobileFormFactor: () => boolean;
  hasWebAssembly: () => boolean;
  canReserveWasmMemory: (pages: number) => boolean;
  hasWorker: () => boolean;
  hasOpfs: () => boolean;
  hasWebLocks: () => boolean;
  hasCryptoRandom: () => boolean;
  hasCrossOriginIsolation: () => boolean;
}

export const defaultProbes: EnvironmentProbes = {
  isMobileFormFactor: () => isMobileFormFactor(readFormFactorSignals()),

  hasWebAssembly: () => typeof WebAssembly === "object" && typeof WebAssembly.Memory === "function",

  canReserveWasmMemory: (pages) => {
    try {
      // Reserve and drop. A browser that cannot serve this cannot run the KDF,
      // and finding that out here costs one failed allocation instead of a dead
      // tab after the user has typed their password.
      const m = new WebAssembly.Memory({ initial: pages });
      return m.buffer.byteLength >= pages * 65536;
    } catch {
      return false;
    }
  },

  hasWorker: () => typeof Worker === "function",

  // Presence of the OPFS entry point only. The synchronous access handle is
  // probed separately, IN A WORKER — see `probeSyncAccessHandle` below for why
  // a main-thread detect is wrong.
  hasOpfs: () =>
    typeof navigator !== "undefined" &&
    typeof (navigator as Navigator & { storage?: { getDirectory?: unknown } }).storage
      ?.getDirectory === "function",

  hasWebLocks: () =>
    typeof navigator !== "undefined" &&
    typeof (navigator as Navigator & { locks?: { request?: unknown } }).locks?.request ===
      "function",

  hasCryptoRandom: () =>
    typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function",

  /**
   * Cross-origin isolation, i.e. `SharedArrayBuffer` (myne#320).
   *
   * The one probe here that is about the DEPLOYMENT rather than the browser,
   * and it was missing — so a bundle served from anything that does not send
   * COOP `same-origin` + COEP `require-corp` (a generic nginx/Caddy/S3 host, or
   * an intermediary that strips them) passed every gate, unlocked normally, and
   * then died at the first HTTP 429 from the sync server.
   *
   * That path is not exotic: the Worker's own 1 s sync loop drives it, and the
   * first materialisation of a large vault is precisely the burst-cap case the
   * backoff exists for. The rate-limit backoff sleeps via `Atomics.wait` on a
   * `SharedArrayBuffer`, which is unavailable without isolation; the Rust side
   * treats that as a hard failure on purpose (a backoff that does not wait is a
   * hot retry loop against a server that is already rate-limiting), so the wasm
   * instance aborts. The page then rejects every later `invoke` with a fatal
   * error for the rest of its life — no save, no read, no lock — and the
   * aborted Worker's linear memory, which held the vault keys, stays resident
   * until the tab is reloaded.
   *
   * Refusing at boot turns that into a sentence the operator can act on.
   *
   * Both halves are checked, matching what the web E2E lane already asserts:
   * `crossOriginIsolated` is the browser's own verdict, and the constructor is
   * what the backoff actually reaches for.
   */
  hasCrossOriginIsolation: () =>
    globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === "function",
};

/**
 * Probe the running environment. Pure — it reserves and releases memory and
 * touches nothing else, so it is safe to call at module scope before the app
 * mounts.
 *
 * Ordered cheapest-first so a browser missing something obvious is refused
 * without paying for the memory reservation.
 */
export function probeEnvironment(probes: EnvironmentProbes = defaultProbes): EnvironmentVerdict {
  // Device class first, and ALONE. A phone gets one sentence saying it is a
  // phone, rather than a list that also mentions Web Locks — the reader has a
  // native app to open, and nothing else on the list is actionable for them.
  // It also means a refused device never pays for the 336 MiB reservation.
  if (probes.isMobileFormFactor()) {
    return { supported: false, missing: ["desktop-form-factor"] };
  }

  const missing: RequiredCapability[] = [];

  if (!probes.hasCryptoRandom()) missing.push("crypto-getrandomvalues");
  if (!probes.hasWorker()) missing.push("worker");
  if (!probes.hasOpfs()) missing.push("opfs");
  if (!probes.hasWebLocks()) missing.push("web-locks");
  if (!probes.hasCrossOriginIsolation()) missing.push("cross-origin-isolation");

  if (!probes.hasWebAssembly()) {
    missing.push("webassembly");
  } else if (!probes.canReserveWasmMemory(REQUIRED_WASM_PAGES)) {
    // The iOS-Safari case, and the one that would otherwise surface as a crash.
    missing.push("wasm-memory-headroom");
  }

  return { supported: missing.length === 0, missing };
}


// ── the capability that cannot be detected from the main thread ──────────────
//
// `createSyncAccessHandle` is **dedicated-worker-only**, and browsers implement
// that literally: the method is absent from `FileSystemFileHandle.prototype` on
// the main thread and present on the same prototype inside a Worker. Verified
// in a real browser while building this gate — the main-thread prototype
// carried exactly `["createWritable", "getFile", "move", "constructor"]`, while
// a Worker in the same page reported the method present.
//
// A main-thread `typeof FileSystemFileHandle.prototype.createSyncAccessHandle`
// check therefore refuses **every capable browser**. That bug was written here
// first and caught by running the gate against a real browser rather than only
// against a fake; it is called out at this length because the check *looks*
// obviously correct, and a unit test with a hand-written fake will happily
// agree with it forever.
//
// So the probe runs where the capability lives. It is also the only async
// probe, which is why the composed gate below is async.
//
// **CSP note for task 55:** this spawns a Worker from a `blob:` URL, so a
// strict policy must allow `worker-src blob:` — or, better, this probe moves
// into the real vault Worker when task 11 lands and the blob form disappears.
// Whichever survives has to be in the policy deliberately; a CSP that silently
// blocks the probe would refuse every browser again, in a different way.

const SYNC_HANDLE_PROBE_SRC = `self.postMessage(
  typeof FileSystemFileHandle === "function" &&
  typeof FileSystemFileHandle.prototype.createSyncAccessHandle === "function"
);`;

/** Probe the sync access handle inside a dedicated Worker. Never throws. */
export async function probeSyncAccessHandle(timeoutMs = 3000): Promise<boolean> {
  if (typeof Worker !== "function" || typeof Blob !== "function" || typeof URL === "undefined") {
    return false;
  }
  let url: string | null = null;
  let worker: Worker | null = null;
  try {
    url = URL.createObjectURL(new Blob([SYNC_HANDLE_PROBE_SRC], { type: "text/javascript" }));
    worker = new Worker(url);
    const w = worker;
    return await new Promise<boolean>((resolve) => {
      const done = (v: boolean) => resolve(v);
      const timer = setTimeout(() => done(false), timeoutMs);
      w.onmessage = (e: MessageEvent) => {
        clearTimeout(timer);
        done(e.data === true);
      };
      w.onerror = () => {
        clearTimeout(timer);
        done(false);
      };
    });
  } catch {
    // A CSP that blocks blob workers lands here. Reported as missing rather
    // than as supported: refusing a capable browser is recoverable by fixing
    // the policy; admitting an incapable one is a crash mid-KDF.
    return false;
  } finally {
    worker?.terminate();
    if (url) URL.revokeObjectURL(url);
  }
}

/**
 * The whole gate: the synchronous probes plus the Worker-hosted one.
 *
 * The Worker probe is skipped when a synchronous probe already disqualified the
 * environment — there is no point spawning a Worker to add a second reason to a
 * refusal, and on a browser with no `Worker` at all it could not run anyway.
 */
export async function gateEnvironment(
  probes: EnvironmentProbes = defaultProbes,
  syncHandleProbe: () => Promise<boolean> = () => probeSyncAccessHandle(),
): Promise<EnvironmentVerdict> {
  const base = probeEnvironment(probes);
  if (!base.supported) return base;
  if (await syncHandleProbe()) return base;
  return { supported: false, missing: [...base.missing, "opfs-sync-access-handle"] };
}

/**
 * One sentence per missing capability, saying what is needed rather than naming
 * an API the reader has no reason to know. The memory line is deliberately the
 * most concrete: it is the one people will hit, and "your browser is not
 * supported" would leave them with nothing to do about it.
 */
export function explainMissing(cap: RequiredCapability): string {
  switch (cap) {
    case "desktop-form-factor":
      return "Myne in the browser is built for a desktop computer. It needs the memory and the input a phone or tablet browser cannot give it. On this device the Myne app is the better client anyway: it is faster, it works offline, and it keeps your notes when the browser clears its storage.";
    case "wasm-memory-headroom":
      return "This browser cannot reserve the ~336 MB of memory the vault's key derivation needs. Phone and tablet browsers generally cannot; that limit is set by the vault itself and cannot be lowered for one device without making the vault unreadable everywhere else.";
    case "webassembly":
      return "This browser does not support WebAssembly, which the encryption core runs on.";
    case "worker":
      return "This browser does not support Web Workers, which the vault's storage and encryption run inside.";
    case "opfs":
      return "This browser does not provide private local storage for web apps, so there is nowhere to keep your vault between page loads.";
    case "opfs-sync-access-handle":
      return "This browser's private local storage is missing the synchronous file access the vault needs to write safely.";
    case "web-locks":
      return "This browser does not support the lock that keeps two tabs from writing to one vault at the same time.";
    case "crypto-getrandomvalues":
      return "This browser does not provide a cryptographic random-number source.";
    case "cross-origin-isolation":
      // Addressed to whoever is serving the page, because they are the only
      // one who can fix it — and named precisely, because "contact the
      // administrator" is what a reader gets everywhere else.
      return "This page is not cross-origin isolated, so the vault cannot pause and retry when the sync server asks it to wait. The server must send the headers `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; if you are self-hosting, check that nothing in front of it is stripping them.";
  }
}

/**
 * The heading for a device-class refusal.
 *
 * "Can't run in this browser" would be a lie here and, worse, an unhelpful one:
 * the browser is fine, the device is a phone, and a reader told their browser is
 * at fault will go looking for a different browser. So the mobile case gets its
 * own heading, pointing at the thing that actually works.
 */
export const MOBILE_REFUSAL_TITLE = "Open Myne's app on this device";

/** Where to go instead. Named clients, not a vague suggestion. */
export const NATIVE_HANDOFF =
  "Myne's desktop app (macOS, Windows, Linux) and mobile app (iOS, Android) have no such limit, and they verify their own signature before running, which a web page cannot.";
