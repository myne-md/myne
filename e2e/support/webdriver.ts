import { appendFileSync } from "node:fs";
// Minimal W3C WebDriver client for the Myne E2E harness.
//
// Hand-rolled instead of the `webdriver` npm package by deliberate
// decision (e2e-harness grill Q2, 2026-06-10): the package carries the
// whole @wdio family + undici + ws (50+ transitives — a
// `myne-agents/docs/dependency-policy.md` red flag), while the protocol surface the
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
   *  a retry cannot double-fire. Any other error surfaces immediately.
   *
   *  **A refusal also scrolls the element into view inside its own scroller.**
   *  WebDriver's pre-click scroll reaches the DOCUMENT viewport and not a
   *  nested `overflow: auto` body, so a control that is painted but clipped by
   *  its scrolling ancestor is reported "not interactable" for the whole
   *  budget and no amount of waiting fixes it. Measured 2026-11-02: the
   *  Settings → Sync → Devices body grew tall enough that
   *  `sync.enroll.submit` sat at y=657 inside a scroller whose visible edge was
   *  ≈637, which made `startOwnerIdentity` time out and took 26 scenarios down
   *  with it — while `clickBySelector` in `flows.ts`, which scrolls per poll,
   *  was green on the same tree. */
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
            await this.scrollIntoViewBestEffort();
            return null; // not hit-testable yet — keep polling
          }
          throw e;
        }
      },
      { label: "element interactable + clicked", timeoutMs: 10_000 },
    );
  }

  /** Centre this element in whatever scroll container holds it, best-effort:
   *  a scroll failure must not become the caller's error, because the click
   *  that follows is the assertion. */
  private async scrollIntoViewBestEffort(): Promise<void> {
    try {
      await this.session.send("POST", "/execute/sync", {
        script:
          "var el = arguments[0];" +
          "if (el) el.scrollIntoView({ block: 'center', inline: 'center' });",
        args: [{ "element-6066-11e4-a52e-4f735466cecf": this.elementId }],
      });
    } catch {
      // The node may have gone between the find and this call; the poll re-finds.
    }
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
    await this.doubleClickAt(0, 0);
  }

  /** Double-click at an offset from the element's top-left (W3C element origin).
   *  (0,0) is the border-box corner, which for a full-width `.cm-line` sits in
   *  the line-height leading above the glyphs and misses word-select. */
  async doubleClickAt(offsetX: number, offsetY: number): Promise<void> {
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

  /** Triple-click via the W3C Actions API: three button-0 down/up pairs in ONE
   *  action sequence, which is what raises `event.detail` to 3 and makes CM6
   *  run its line-selection gesture. Three separate `click` calls would each
   *  arrive with `detail: 1` and select nothing.
   *
   *  Drives `taskRowSelection` (myne-md/myne#560), whose whole subject is what
   *  a triple-click leaves behind on a list row. jsdom has no `detail`-aware
   *  selection model, so the two unit lanes assert the decision and the wiring
   *  and both DISPATCH the transaction the gesture would produce; this is the
   *  only lane where the gesture itself runs. */
  async tripleClick(): Promise<void> {
    await this.tripleClickAt(0, 0);
  }

  /** Triple-click at an offset from the element's top-left (W3C element origin).
   *  (0,0) is the border-box corner, which for a full-width `.cm-line` sits in
   *  the line-height leading above the glyphs — same trap as `doubleClickAt`. */
  async tripleClickAt(offsetX: number, offsetY: number): Promise<void> {
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
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
            { type: "pause", duration: 0 },
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
// A real never-appears bug still fails — just later. Raised 20 s → 45 s. (A
// 90 s experiment was REVERTED: it did not make the tail-contention scenarios
// pass — the failure shape is a host too loaded to paint in budget, not a small
// margin — it only tripled their fail time, bloating the suite to ~46 min and
// tripping the 60-min Woodpecker pipeline timeout, which Canceled the whole run
// mid-e2e. The real fixes are elsewhere: the e2e step is now non-blocking
// (.woodpecker/e2e.yml) so a tail flake no longer gates, the repo timeout is raised
// to 120 min for headroom, and the durable cure is the boot-cost work. With
// e2e non-blocking a FAST fail is preferable, so 45 s stays.) 45 s already
// closed most of the tail (nav1 unlock, tp1 attachment-text); the rest is the
// quarantine set + the boot-cost debt.
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_INTERVAL_MS = 100;

/**
 * Multiplier on EVERY wait budget in the suite (`MYNE_E2E_TIMEOUT_SCALE`).
 *
 * # Why a budget the host cannot honour is a false red
 *
 * The budgets above are tuned for a machine running this suite alone, and the
 * CI runner is not that machine: it hosts several Woodpecker pipelines at once
 * (this lane is triggered by hand while other branches are mid-push), and every
 * scenario drives a real WebKit app whose rendering and CodeMirror measure loops
 * queue behind whatever else is running. What that produces is not a slightly
 * slower app, it is a rotating set of ~1% failures that changes identity on
 * every run and every one of which passes in isolation: pipeline 936 read
 * `folder-notes`, `search-casefold`, `typewriter-anchor`, `vim-mode`; 944 read
 * `code-block-typography`, `editor-vertical-caret`, `state-machine`,
 * `unsynced-marker`, `wikilink-hover`.
 *
 * Scaling the budget is the honest half of the fix and it hides nothing: a
 * scenario whose flow is genuinely broken never settles, so it still fails, only
 * later; and the number in the timeout message is the scaled one, so a report
 * says what the machine was actually given. `retry: 2` in the config was the
 * earlier answer to the same shape and it cannot help here, because the load that
 * starves an attempt also starves its retries.
 *
 * Read once: a per-call `process.env` lookup would run on every poll.
 */
const TIMEOUT_SCALE = ((): number => {
  const raw = process.env.MYNE_E2E_TIMEOUT_SCALE;
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
})();

/**
 * Opt-in wait profiler (`MYNE_E2E_WAIT_PROFILE=1`).
 *
 * A scenario's wall clock is dominated by its WAITS, and the suite's JSON
 * reporter gives per-TEST durations, which cannot separate "the app was slow"
 * from "this wait was long". So with the flag set every `waitUntil` appends
 * `{label, ms, timedOut}` to `MYNE_E2E_WAIT_PROFILE_OUT` (default
 * `/tmp/myne-e2e-waits.jsonl`) and `scripts/e2e-wait-profile.mjs` ranks it
 * across shards, which is what turns "tighten the budgets" from a guess into a
 * list.
 *
 * **Written per record rather than on `process.on("exit")`.** The first version
 * flushed on exit and wrote nothing at all: a vitest fork worker does not
 * reliably reach its own `exit` handler, so the profile was silently empty,
 * which reads exactly like "nothing was waiting". An `appendFileSync` per wait
 * costs microseconds against the driver round trips the wait is made of.
 *
 * It lives in the harness, never in the binary under test, so the
 * zero-test-hooks rule (`e2e/AGENTS.md`) is untouched: nothing here can change
 * what the app does.
 */
const WAIT_PROFILE_ON = process.env.MYNE_E2E_WAIT_PROFILE === "1";
const WAIT_PROFILE_OUT =
  process.env.MYNE_E2E_WAIT_PROFILE_OUT ?? "/tmp/myne-e2e-waits.jsonl";

/** Record one wait. Exported for `scenario()`'s launch timing, which is a wait
 *  in everything but name. */
export function recordWait(label: string, ms: number, timedOut: boolean): void {
  if (!WAIT_PROFILE_ON) return;
  try {
    appendFileSync(
      WAIT_PROFILE_OUT,
      `${JSON.stringify({ label, ms, timedOut, pid: process.pid })}\n`,
    );
  } catch {
    // Best-effort: a profile that cannot be written must never fail a run.
  }
}

/** One WebDriver session against a running tauri-driver. */
/** A toplevel window's geometry, as W3C `GET/POST /window/rect` reports it. */
export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

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
    // A LAZY label is allowed, and it is what lets a poll report why it kept
    // failing. The label is read only on the timeout path, so a thunk costs a
    // passing wait nothing, and the alternative — building the string up front —
    // cannot see anything the polls learned. `clickByTestId` is the case that
    // needed it: its three retry arms are the diagnosis, and they are only
    // observable from inside the predicate.
    opts?: FindOptions & { label?: string | (() => string) },
  ): Promise<T> {
    const timeout = Math.round((opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS) * TIMEOUT_SCALE);
    const interval = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
    const deadline = Date.now() + timeout;
    const started = WAIT_PROFILE_ON ? Date.now() : 0;
    // The label is a THUNK on purpose (see `FindOptions`'s note: it is read only
    // on the timeout path, where the polls have something to report). The
    // profile needs a name on the passing path too, and calling a lazy label
    // early is exactly what its own design forbids, so a thunk records this
    // placeholder rather than being asked at the start of the wait.
    const profileLabel =
      typeof opts?.label === "string" ? opts.label : "<lazy label>";
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
      if (result) {
        recordWait(profileLabel, Date.now() - started, false);
        return result;
      }
      if (Date.now() >= deadline) {
        recordWait(profileLabel, Date.now() - started, true);
        const label =
          typeof opts?.label === "function" ? opts.label() : opts?.label ?? "predicate";
        throw new Error(
          `waitUntil(${label}) timed out after ${timeout} ms` +
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

  /** Navigate to `url` (plain W3C `POST /url`).
   *
   *  Unused by the desktop lane and that is not an oversight: there, the app IS
   *  the page and tauri-driver opens it — there is no URL to go to, and a
   *  scenario that navigated would be leaving the application under test. The
   *  web lane (MYND-574 task 105) needs it for the opposite reason: the bundle
   *  is served over HTTP and every scenario starts by going there. */
  navigate(url: string): Promise<void> {
    return this.send("POST", "/url", { url });
  }

  /** The BROWSER's own Back (W3C `POST /back`).
   *
   *  Unused by the desktop lane, which has no browser chrome and no session
   *  history to walk — its navigation history is in-app and driven through the
   *  UI. The web lane needs the real thing: the claim under test in
   *  `history-privacy.e2e.ts` is about what the browser stores and restores,
   *  and an in-app "back" control would answer a different question entirely.
   *
   *  Waits for nothing. A back navigation may be served from the bfcache
   *  (instant, no re-execution) or as a fresh load, and which one it is depends
   *  on the engine and the page — so the caller settles on what it actually
   *  cares about rather than on a fixed delay here. */
  back(): Promise<void> {
    return this.send("POST", "/back");
  }

  /** The toplevel window's geometry (W3C `GET /window/rect`). */
  windowRect(): Promise<WindowRect> {
    return this.send<WindowRect>("GET", "/window/rect");
  }

  /**
   * Resize/move the toplevel window (W3C `POST /window/rect`), returning what
   * the window manager actually granted.
   *
   * The return value is not a formality: a request is a REQUEST. Under xvfb
   * there is no window manager to honour or refuse one, the X server's screen
   * size is a hard ceiling, and GTK enforces the window's own minimum size — so
   * a caller that assumes it got what it asked for can silently measure a
   * layout at a width it never reached. Every caller in this suite asserts on
   * the granted rect.
   *
   * This is the primitive `src/screens/responsiveCollapse.ts` said the harness
   * did not have ("the trigger is a window resize, which the tauri-driver
   * harness has no primitive to drive"). It has had it since W3C WebDriver;
   * nothing here had needed it, and that comment was read as a statement about
   * the harness rather than about that file's coverage (myne-md/myne#555).
   */
  setWindowRect(rect: Partial<WindowRect>): Promise<WindowRect> {
    return this.send<WindowRect>("POST", "/window/rect", {
      x: rect.x ?? null,
      y: rect.y ?? null,
      width: rect.width ?? null,
      height: rect.height ?? null,
    });
  }

  /** The current top-level browsing context's handle (W3C `GET /window`).
   *
   *  Unused by the desktop lane — one window, nothing to switch between. The
   *  web lane needs it because a browser lets the user open the same origin
   *  twice, which is the whole subject of the single-tab-lock scenario (#254). */
  windowHandle(): Promise<string> {
    return this.send("GET", "/window");
  }

  /** Open a second top-level context and switch to it (W3C `POST /window/new`).
   *
   *  A TAB rather than a window, deliberately: Web Locks are scoped to the agent
   *  cluster, and a tab in the same profile is the pair a user actually creates
   *  when they duplicate a tab or re-open a bookmark. */
  async newWindow(): Promise<string> {
    const res = await this.send<{ handle: string }>("POST", "/window/new", {
      type: "tab",
    });
    await this.switchToWindow(res.handle);
    return res.handle;
  }

  /** Switch the session to an already-open context (W3C `POST /window`). */
  switchToWindow(handle: string): Promise<void> {
    return this.send("POST", "/window", { handle });
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
