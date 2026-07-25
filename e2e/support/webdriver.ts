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

  /** Click the element, retrying while WebKit reports it is in the DOM but
   *  not yet hit-testable — a menu/portal animating in, an overlay
   *  mid-transition, or a layout that has not settled (the switcher
   *  `vault-row`, the Settings select rows, etc.). "element not interactable"
   *  / "element click intercepted" both mean the click did NOT dispatch, so
   *  a retry cannot double-fire. Any other error surfaces immediately. */
  async click(): Promise<void> {
    await this.session.waitUntil(
      async () => {
        try {
          await this.session.send("POST", this.path("/click"));
          return true;
        } catch (e) {
          if (
            e instanceof WebDriverError &&
            (e.code === "element not interactable" ||
              e.code === "element click intercepted")
          ) {
            return null; // not hit-testable yet — keep polling
          }
          throw e;
        }
      },
      { label: "element interactable + clicked", timeoutMs: 10_000 },
    );
  }

  /** One raw click attempt — no interactability/stale retry. For callers that
   *  re-locate the element themselves between attempts (typeIntoEditor's
   *  note-open re-render race): a fresh handle clicks at once, and a handle that
   *  staled mid-open throws immediately so the caller re-finds instead of burning
   *  click()'s whole 10 s budget polling a dead node. */
  async clickOnce(): Promise<void> {
    await this.session.send("POST", this.path("/click"));
  }

  /** Click via the W3C Actions API (pointer move to centre → button-0 down/up)
   *  in ONE sequence — the same transport as `rightClick`, with NO interactability
   *  pre-check. WebKit's `/click` endpoint refuses an element it deems
   *  non-interactable (notably `opacity: 0`), but opacity does NOT affect
   *  hit-testing — a hover-revealed gutter fold marker (opacity 0 → 0.7 only
   *  while the editor is hovered) receives the pointer fine. Moving the pointer
   *  ONTO the marker also satisfies the `.cm-editor:hover` reveal, and the brief
   *  pause lets the opacity transition settle before the press. Use for
   *  hover-gated affordances `/click` rejects; prefer `click()` (which retries on
   *  transient non-interactability) for ordinary buttons/rows. */
  async actionClick(offsetX = 0, offsetY = 0): Promise<void> {
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
              x: offsetX,
              y: offsetY,
            },
            { type: "pause", duration: 200 },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }

  /** Double-click via the W3C Actions API — pointer move to the in-view centre,
   *  then two button-0 down/up pairs in one action sequence (synthesizes
   *  `dblclick`). Drives the folder-row open gesture (`FolderRow.onActivate`,
   *  MYND-370). The single `click` between the pairs toggles disclosure twice
   *  (nets to no fold change), exactly as a real double-click does. */
  async doubleClick(): Promise<void> {
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
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
            { type: "pause", duration: 0 },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
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

  /** W3C "Get Element Rect" — the element's viewport position + size
   *  (`{ x, y, width, height }`). Used to right-click a specific region of a
   *  wide element (e.g. the bottom-bar's empty LEFT zone vs its affordances). */
  async rect(): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.session.send<{ x: number; y: number; width: number; height: number }>(
      "GET",
      this.path("/rect"),
    );
  }

  /** Right-click via the W3C Actions API (context-menu affordances —
   *  e.g. note/folder rows). Element-origin pointer move targets the
   *  in-view center by default; pass `offsetX`/`offsetY` (pixels from center)
   *  to hit a specific region — e.g. the bottom-bar's empty area, which opens
   *  the bar's list menu rather than a per-affordance menu. Button 2 down+up
   *  synthesizes `contextmenu`. */
  async rightClick(offsetX = 0, offsetY = 0): Promise<void> {
    // Retry while WebKit reports the element is in the DOM but not yet
    // hit-testable (a sidebar row mid expand/collapse animation — the
    // grid-template-rows reveal — or a layout that has not settled). The
    // pointerMove resolves the element's in-view centre first; if that throws
    // "not interactable" NOTHING was dispatched (no contextmenu fired), so the
    // retry cannot double-open a menu. Mirrors `click()`'s retry contract.
    await this.session.waitUntil(
      async () => {
        try {
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
                    x: offsetX,
                    y: offsetY,
                  },
                  { type: "pointerDown", button: 2 },
                  { type: "pointerUp", button: 2 },
                ],
              },
            ],
          });
          return true;
        } catch (e) {
          if (
            e instanceof WebDriverError &&
            (e.code === "element not interactable" ||
              e.code === "element click intercepted")
          ) {
            return null; // not hit-testable yet — keep polling
          }
          throw e;
        }
      },
      { label: "element interactable + right-clicked", timeoutMs: 10_000 },
    );
  }

  /** Move the pointer over this element (no buttons) via the W3C Actions API —
   *  synthesizes `pointermove`/`mouseenter`, driving hover-gated affordances
   *  (e.g. a card's "Set cover" button shown only on hover). */
  async hover(): Promise<void> {
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
          ],
        },
      ],
    });
  }

  /** Click while holding ONE modifier key, via the W3C Actions API with
   *  the key + pointer input sources run in lockstep (the modifier is DOWN
   *  across the pointer move/down/up ticks, then released). Drives the
   *  workspace open-modifier affordances on a note row (`NoteRow`): Control
   *  ("") or Meta ("") → open in a new tab; Alt ("") →
   *  open to the side / split. Pass `key` as a `\uE0xx` escape, never a
   *  literal (the invisible-key hazard — see the U+E007 memory). */
  // NOTE (MYND-367): Cmd/Ctrl-click on a note row now TOGGLES the multi-
  // selection (no longer "open in a new tab"); Alt still opens to the side.
  // The new-tab affordance moved to `middleClick` (and the row context menu).
  async middleClick(): Promise<void> {
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
            { type: "pointerDown", button: 1 },
            { type: "pointerUp", button: 1 },
          ],
        },
      ],
    });
  }

  async modifierClick(key: string): Promise<void> {
    await this.session.send("POST", "/actions", {
      actions: [
        {
          type: "key",
          id: "kbd",
          actions: [
            { type: "keyDown", value: key },
            { type: "pause", duration: 0 },
            { type: "pause", duration: 0 },
            { type: "pause", duration: 0 },
            { type: "keyUp", value: key },
          ],
        },
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pause", duration: 0 },
            {
              type: "pointerMove",
              duration: 0,
              origin: { [ELEMENT_KEY]: this.elementId },
              x: 0,
              y: 0,
            },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
            { type: "pause", duration: 0 },
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

  /** Scroll this element to the centre of its nearest scroll container. The
   *  W3C `/click` "scroll into view" step only guarantees the element's border
   *  box intersects the VIEWPORT — it does not reliably reveal an element that
   *  is clipped inside an overflowing modal body (the `SearchableSelect` trigger
   *  near the bottom of a tall settings modal), so `/click` there can report
   *  "element not interactable" indefinitely. Call this first to bring the
   *  target into its container's centre before clicking. */
  async scrollIntoView(): Promise<void> {
    await this.session.execute(
      "arguments[0].scrollIntoView({ block: 'center', inline: 'center' })",
      [{ [ELEMENT_KEY]: this.elementId }],
    );
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
  /** Total wait budget for the element to appear. Default `DEFAULT_TIMEOUT_MS` (45_000 ms). */
  timeoutMs?: number;
  /** Poll interval. Default 100 ms. */
  intervalMs?: number;
}

// Default wait budget. Held generous deliberately: the whole e2e suite drives
// ~84 real tauri-driver + production-binary launches through a SINGLE container
// + xvfb, up to MYNE_E2E_SHARDS (=2) file-workers in parallel, so files run under
// cumulative host pressure that an isolated spec never sees — element mounts,
// editor re-mounts, and async engine work (spell tokenize, view re-query) that
// land in <1 s alone routinely need several seconds under that load. Every
// element-appearance/poll wait inherits this headroom, which (with the config's
// retry: 2) is what closes the full-suite "different test flakes each run" tail.
// A real never-appears bug still fails — just 45 s later instead of 20.
// Raised 20 s → 45 s: under a contended CI runner (MAX_WORKFLOWS in parallel)
// even the lock-screen / attachment-preview first paint was observed slipping
// past 30 s, flaking a *different* mount-bound scenario each full-suite run
// (nav1 unlock, tp1 attachment-text-preview). The headroom trades slower
// never-appears failures for a closed flake tail.
const DEFAULT_TIMEOUT_MS = 45_000;
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
   *  A poll iteration that races a DOM mutation surfaces as a
   *  `stale element reference` from the driver — either on a handle
   *  read (find succeeded, node detached before the read) or from
   *  WebKitWebDriver's find itself ("Stale element found when trying
   *  to create the node handle": the node matched, then unmounted
   *  before the handle was minted). Inside a retry loop that is by
   *  definition transient — the next iteration re-queries from the
   *  document root — so it counts as a falsy poll, not a failure. A
   *  handle that is GENUINELY stale (captured before the loop) times
   *  out instead, with the swallowed error named in the message. */
  async waitUntil<T>(
    fn: () => Promise<T | null | undefined | false>,
    opts?: FindOptions & { label?: string },
  ): Promise<T> {
    const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const interval = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
    const deadline = Date.now() + timeout;
    let lastStale: WebDriverError | undefined;
    for (;;) {
      let result: T | null | undefined | false;
      try {
        result = await fn();
      } catch (e) {
        if (e instanceof WebDriverError && e.code === "stale element reference") {
          lastStale = e;
          result = null;
        } else {
          throw e;
        }
      }
      if (result) return result;
      if (Date.now() >= deadline) {
        throw new Error(
          `waitUntil(${opts?.label ?? "predicate"}) timed out after ${timeout} ms` +
            (lastStale ? ` (last poll error: ${lastStale.message})` : ""),
        );
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

  /** Async script: the LAST argument injected into `script` is a callback
   *  that resolves this promise. Used to await page-side Promises (e.g.
   *  `axe.run(...)`) that the sync endpoint cannot. */
  executeAsync<T>(script: string, args: unknown[] = []): Promise<T> {
    return this.send("POST", "/execute/async", { script, args });
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
  /** Argv for the app binary — `tauri:options.args`. Used to model an OS
   *  deep-link cold launch (the URL is the process's only argument). */
  args?: readonly string[];
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
          // `undefined` is dropped by JSON.stringify, so a scenario that passes
          // no args sends the byte-identical payload it sent before.
          args: opts.args?.length ? [...opts.args] : undefined,
        },
      },
    },
  });
  return new Session(opts.baseUrl, value.sessionId);
}
