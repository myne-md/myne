// Minimal W3C WebDriver client for the Myne E2E harness.
//
// Hand-rolled instead of the `webdriver` npm package by deliberate
// decision (e2e-harness grill Q2, 2026-06-10): the package carries the
// whole @wdio family + undici + ws (50+ transitives — a
// `docs/dependency-policy.md` red flag), while the protocol surface the
// suites need is ~a dozen plain HTTP+JSON endpoints. Node ≥18's global
// `fetch` covers transport; this module has ZERO runtime dependencies.
//
// Scope: exactly what the scenario suites use — session lifecycle,
// element find/click/type/clear, text/attribute/property reads,
// refresh (the WebView-reload / slot-priority scenarios), screenshot,
// execute, page source. Anything beyond that should be a conscious
// addition, not a convenience import.
//
// Spec: https://www.w3.org/TR/webdriver2/ — responses are
// `{ value: ... }`; errors are `{ value: { error, message } }`;
// element refs use the `element-6066-11e4-a52e-4f735466cecf` key.

import { setTimeout as sleep } from "node:timers/promises";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

/** The SYNC-8 selector idiom — single encoding for testid lookups.
 *  Optional `attrs` narrows to one instance of a repeated testid
 *  (picker/switcher rows: `{ "data-vault-id": id }`). */
export function testIdSelector(testId: string, attrs?: Record<string, string>): string {
  let selector = `[data-testid="${testId}"]`;
  for (const [name, value] of Object.entries(attrs ?? {})) {
    selector += `[${name}="${value}"]`;
  }
  return selector;
}

export class WebDriverError extends Error {
  /** W3C error code, e.g. "no such element", "invalid session id". */
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(`[${code}] ${message}`);
    this.name = "WebDriverError";
    this.code = code;
    this.status = status;
  }
}

interface WireValue {
  value: unknown;
}

async function wire<T>(
  baseUrl: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json; charset=utf-8" },
    // W3C requires a JSON body on every POST, even parameter-less ones.
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const payload = (await res.json()) as WireValue;
  if (!res.ok) {
    const err = payload.value as { error?: string; message?: string };
    throw new WebDriverError(
      err?.error ?? "unknown error",
      err?.message ?? JSON.stringify(payload.value),
      res.status,
    );
  }
  return payload.value as T;
}

/** Handle to a located element, scoped to its session. */
export class Element {
  constructor(
    private readonly session: Session,
    readonly elementId: string,
  ) {}

  private path(suffix: string): string {
    return `/element/${this.elementId}${suffix}`;
  }

  click(): Promise<void> {
    return this.session.send("POST", this.path("/click"));
  }

  /** Types text into the element (W3C "element send keys"). */
  sendKeys(text: string): Promise<void> {
    return this.session.send("POST", this.path("/value"), { text });
  }

  clear(): Promise<void> {
    return this.session.send("POST", this.path("/clear"));
  }

  /** Replace the element's value via REAL keystrokes (BACKSPACE × the
   *  current length, then the new text). W3C `clear` sets the value
   *  outside the native keystroke path, which React's controlled-input
   *  value tracker ignores on some components (observed on the Input
   *  primitive: post-clear keystrokes APPEND) — keystrokes always land. */
  async replaceText(text: string): Promise<void> {
    const current = await this.property<string>("value");
    await this.sendKeys("\uE003".repeat((current ?? "").length) + text);
  }

  /** Right-click via the W3C Actions API (context-menu affordances —
   *  e.g. note/folder rows). Element-origin pointer move targets the
   *  in-view center; button 2 down+up synthesizes `contextmenu`. */
  async rightClick(): Promise<void> {
    await this.session.send("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              duration: 0,
              origin: { [ELEMENT_KEY]: this.elementId },
              x: 0,
              y: 0,
            },
            { type: "pointerDown", button: 2 },
            { type: "pointerUp", button: 2 },
          ],
        },
      ],
    });
  }

  text(): Promise<string> {
    return this.session.send("GET", this.path("/text"));
  }

  /** Full text including nested descendants. This driver's W3C getText
   *  drops text inside child elements (observed on switcher rows and
   *  CodeMirror lines) — prefer this whenever the target nests its
   *  copy; keep `text()` for direct text nodes (banner literals). */
  async textContent(): Promise<string> {
    return (await this.property<string>("textContent")) ?? "";
  }

  /** DOM attribute as serialized in markup (e.g. `data-vault-id`). */
  attribute(name: string): Promise<string | null> {
    return this.session.send("GET", this.path(`/attribute/${name}`));
  }

  /** Live DOM property (e.g. `value` of an input, `disabled`). */
  property<T = unknown>(name: string): Promise<T> {
    return this.session.send("GET", this.path(`/property/${name}`));
  }

  enabled(): Promise<boolean> {
    return this.session.send("GET", this.path("/enabled"));
  }
}

export interface FindOptions {
  /** Total wait budget for the element to appear. Default 10_000 ms. */
  timeoutMs?: number;
  /** Poll interval. Default 100 ms. */
  intervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 100;

/** One WebDriver session against a running tauri-driver. */
export class Session {
  constructor(
    readonly baseUrl: string,
    readonly sessionId: string,
  ) {}

  send<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    return wire<T>(this.baseUrl, method, `/session/${this.sessionId}${path}`, body);
  }

  /** Convenience: find by `data-testid` (the SYNC-8 selector idiom). */
  byTestId(testId: string, opts?: FindOptions): Promise<Element> {
    return this.waitForElement(testIdSelector(testId), opts);
  }

  /** All current matches for a testid (empty array when none). */
  byTestIdAll(testId: string): Promise<Element[]> {
    return this.findElements(testIdSelector(testId));
  }

  /** Single immediate lookup; throws `no such element` when absent. */
  async findElement(cssSelector: string): Promise<Element> {
    const value = await this.send<Record<string, string>>("POST", "/element", {
      using: "css selector",
      value: cssSelector,
    });
    return new Element(this, value[ELEMENT_KEY]);
  }

  /** All current matches (empty array when none). */
  async findElements(cssSelector: string): Promise<Element[]> {
    const value = await this.send<Record<string, string>[]>("POST", "/elements", {
      using: "css selector",
      value: cssSelector,
    });
    return value.map((v) => new Element(this, v[ELEMENT_KEY]));
  }

  /** Poll until the selector matches; the harness's default lookup. */
  waitForElement(cssSelector: string, opts?: FindOptions): Promise<Element> {
    return this.waitUntil(
      async () => {
        try {
          return await this.findElement(cssSelector);
        } catch (e) {
          if (e instanceof WebDriverError && e.code === "no such element") return null;
          throw e;
        }
      },
      { ...opts, label: `waitForElement(${cssSelector})` },
    );
  }

  /** Poll until the selector matches nothing. */
  async waitForGone(cssSelector: string, opts?: FindOptions): Promise<void> {
    await this.waitUntil(
      async () => (await this.findElements(cssSelector)).length === 0 || null,
      { ...opts, label: `waitForGone(${cssSelector})` },
    );
  }

  /** Poll an arbitrary predicate (for non-element conditions).
   *
   *  A stale-element error thrown INSIDE the predicate counts as "not
   *  yet", not as a failure: it means the DOM moved between a find and
   *  the dependent read (React remounts race every handle — observed on
   *  `waitForGone`'s mid-enumeration unmounts and on CodeMirror reads
   *  across reload), and the next tick re-finds a fresh handle. A
   *  predicate that keeps hitting stale exhausts the budget and fails
   *  with this label, never silently passes. */
  async waitUntil<T>(
    fn: () => Promise<T | null | undefined | false>,
    opts?: FindOptions & { label?: string },
  ): Promise<T> {
    const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const interval = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
    const deadline = Date.now() + timeout;
    for (;;) {
      let result: T | null | undefined | false;
      try {
        result = await fn();
      } catch (e) {
        if (!(e instanceof WebDriverError && e.code === "stale element reference")) throw e;
        result = null;
      }
      if (result) return result;
      if (Date.now() >= deadline) {
        throw new Error(`waitUntil(${opts?.label ?? "predicate"}) timed out after ${timeout} ms`);
      }
      await sleep(interval);
    }
  }

  /** WebView reload — the Cmd+R / slot-priority scenario primitive.
   *  The Rust host (and its `HashMap<VaultId, Slot>`) survives this. */
  refresh(): Promise<void> {
    return this.send("POST", "/refresh");
  }

  /** Base64 PNG of the current viewport. */
  screenshot(): Promise<string> {
    return this.send("GET", "/screenshot");
  }

  /** Synchronous script in the page context. NOTE: `withGlobalTauri` is
   *  OFF — `window.__TAURI__` does not exist; scripts can read DOM
   *  state but cannot fire IPC (zero-hook policy, SYNC-3). */
  execute<T>(script: string, args: unknown[] = []): Promise<T> {
    return this.send("POST", "/execute/sync", { script, args });
  }

  /** Full page source (debugging aid for failure artifacts). */
  source(): Promise<string> {
    return this.send("GET", "/source");
  }

  async deleteSession(): Promise<void> {
    await wire<void>(this.baseUrl, "DELETE", `/session/${this.sessionId}`);
  }
}

export interface NewSessionOptions {
  /** tauri-driver endpoint, e.g. `http://127.0.0.1:4444`. */
  baseUrl: string;
  /** Absolute path to the production app binary under test. */
  application: string;
}

/** GET /status — used to poll driver readiness after spawn. */
export async function driverStatus(baseUrl: string): Promise<{ ready?: boolean }> {
  return wire<{ ready?: boolean }>(baseUrl, "GET", "/status");
}

export async function newSession(opts: NewSessionOptions): Promise<Session> {
  const value = await wire<{ sessionId: string }>(opts.baseUrl, "POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": {
          application: opts.application,
        },
      },
    },
  });
  return new Session(opts.baseUrl, value.sessionId);
}
