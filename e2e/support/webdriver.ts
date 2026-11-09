import { appendFileSync } from "node:fs";
// Minimal W3C WebDriver client for the Myne E2E harness.
//
// Hand-rolled instead of the `webdriver` npm package by deliberate
// decision (e2e-harness grill Q2, 2026-06-10): the package carries the
// whole @wdio family + undici + ws (50+ transitives — a
// `agent-tooling/docs/dependency-policy.md` red flag), while the protocol surface the
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
import { missingTestIdHint } from "./testid-census";

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

/**
 * A driver call that never answers must say so in under a minute.
 *
 * `fetch` here inherits undici's 300 s `headersTimeout`, and when a driver accepts
 * the connection but never replies the suite sat on that for five minutes and then
 * reported a bare `TypeError: fetch failed` — no URL, no method, no clue which of
 * the two devices was wedged (measured 2026-11-07 on `sync-replication`'s canary,
 * 305 s). A WebDriver call is local: if it has not answered in a minute, waiting
 * longer cannot help, and the SAME budget the waits use is the honest bound.
 */
const WIRE_TIMEOUT_MS = 60_000;

/** How long to wait for `POST /element/<id>/value` before typing page-side. Short
 *  on purpose: the same session answers `execute` in milliseconds while the
 *  keystroke command wedges, so waiting the full minute buys nothing. */
const SEND_KEYS_TIMEOUT_MS = 12_000;

/** Text longer than this is set page-side in one act instead of typed. */
const PASTE_ABOVE_CHARS = 120;

async function wire<T>(
  baseUrl: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  attempt = 0,
  timeoutMs = WIRE_TIMEOUT_MS,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json; charset=utf-8" },
      // W3C requires a JSON body on every POST, even parameter-less ones.
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as Error)?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") {
      // **Ask the page, not the driver, before giving up.** Both answers point at
      // different owners: a page that still runs `execute` means the DRIVER's
      // element path wedged, while a page that answers nothing means the WebView is
      // gone and the fault is the app's. Without this line the two were one
      // message, and the session spent hours on the wrong side of it.
      let pageSays = "did not answer either";
      try {
        const probe = await fetch(`${baseUrl}/execute/sync`, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ script: "return 1 + 1;", args: [] }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = (await probe.json()) as { value?: unknown };
        pageSays = `answers execute (${String(body?.value)}) - the page is ALIVE, the driver's element path wedged`;
      } catch {
        pageSays = "answers nothing - the WebView is GONE";
      }
      // **A live page earns one retry.** A stall that leaves the page answering is
      // the driver's scheduling, not the scenario's subject, and the same request
      // answers on the next attempt — measured 2026-11-08: the four member
      // scenarios wedge on `POST /element/...` only in a long full run, and each
      // passes alone in 40-124 s. One retry keeps a transient stall from consuming
      // the whole scenario; a genuinely dead page still fails immediately, with
      // the sentence below naming which of the two it was.
      // **Three attempts, with a pause, because the block can be long.** A page
      // that answers now may be inside a production-KDF round on the next call — the
      // member scenarios are the only ones that create an identity at m=256 MiB, and
      // measured 2026-11-08 the wedge hops between `element/value` and `execute/sync`
      // within one scenario. Pausing gives the app's main thread time to finish
      // rather than hammering a blocked WebView.
      if (pageSays.startsWith("answers execute") && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return await wire(baseUrl, method, path, body, attempt + 1, timeoutMs);
      }
      throw new Error(
        `the driver at ${baseUrl} did not answer ${method} ${path} within ${timeoutMs} ms ` +
          `(attempt ${attempt + 1}); the page ${pageSays}`,
      );
    }
    throw e;
  }
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
    let refreshed = false;
    try {
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
              // Once, not per poll: a stale hit-test map is a one-shot repair
              // and the retry loop is the budget, not the cure.
              if (!refreshed) {
                refreshed = true;
                await this.refreshHitTestMap();
              }
              return null; // not hit-testable yet — keep polling
            }
            throw e;
          }
        },
        { label: "element interactable + clicked", timeoutMs: 10_000 },
      );
    } catch (raw) {
      // **Name the node and what is on top of it.** "element interactable +
      // clicked timed out" cannot distinguish the four explanations this has — a
      // zero-sized node, a node under an `inert` ancestor (the importer offer
      // registers the whole page inert, `useOverlayInert`), a node covered by a
      // real overlay, and a node the driver simply will not hit-test. Measured
      // 2026-11-03: four specs failed on this message and none of them could say
      // which of the four it was.
      let seen = "<unreadable>";
      try {
        seen = await this.session.execute<string>(
          "const el = arguments[0]; if (!el) return 'gone';" +
            "const r = el.getBoundingClientRect();" +
            "const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);" +
            "return JSON.stringify({ testid: el.getAttribute('data-testid')," +
            " rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]," +
            " top: t ? (t.getAttribute('data-testid') || t.className || t.tagName) : 'none'," +
            " stack: Array.prototype.slice.call(document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2), 0, 4)" +
            "   .map(function (n) { return n.getAttribute('data-testid') || String(n.className || n.tagName).slice(0, 24); })," +
            " sameId: document.querySelectorAll('[data-testid=\"editor.tab\"]').length," +
            " inert: el.closest('[inert]') ? (el.closest('[inert]').getAttribute('data-testid') || 'yes') : null," +
            " pointerEvents: getComputedStyle(el).pointerEvents," +
            " visible: getComputedStyle(el).visibility });",
          [{ [ELEMENT_KEY]: this.elementId }],
        );
      } catch {
        /* the session may be wedged; the timeout is still the failure */
      }
      throw new Error(`${(raw as Error).message} | node: ${seen} | refresh: ${this.lastRefresh}`);
    }
  }

  /** Repair a STALE hit-test map around this element, best-effort.
   *
   *  WebKitGTK does not always invalidate a scrolling layer's hit-test data when
   *  the overflow APPEARS — content grew, a long name landed, a control was added
   *  — so `POST /click` answers `element not interactable` for a control that is
   *  painted, unobstructed and `pointer-events: auto`, and
   *  `document.elementsFromPoint` at its own centre does not list it at all while
   *  listing its ANCESTORS. A real pointer rarely sees it, because moving onto the
   *  surface repaints it and `/click` goes straight to the hit test.
   *
   *  Measured 2026-11-03, and the scope here is what it actually cured. The
   *  identity-setup phrase step (`vault-format-upgrade`) is GREEN with this
   *  repair and was red on every attempt before it. The overflowing tab strip is
   *  NOT cured: two resident tabs make the strip 446 px wide inside a 428 px row,
   *  after which `editor.tab` is unreachable, and a probe showed the hit map
   *  refreshing only when the row's own `overflow` is released INSIDE one page
   *  task and re-read before the next — the same release split across two round
   *  trips still answers `hit:no`. So the tab case stays open on its own; do not
   *  read this helper as covering it.
   *
   *  Two repairs, in the order a user performs them: a pointer MOVE over the node
   *  at viewport coordinates the page computed (element origin would ask the
   *  driver to resolve the element, which is the very hit test that is stale),
   *  then a no-op release-and-restore of the nearest scrollable ancestor's own
   *  `overflow`. Both are idempotent: nothing is dispatched and no scroll
   *  position changes. */

  private async refreshHitTestMap(): Promise<void> {
    let hover = "not-sent";
    let toggle = "none";
    let hit = "?";
    const centre = async (): Promise<{ x: number; y: number } | null> => {
      try {
        const raw = await this.session.execute<string>(
          "var el = arguments[0]; if (!el) return 'null';" +
            "var r = el.getBoundingClientRect();" +
            "return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });",
          [{ [ELEMENT_KEY]: this.elementId }],
        );
        return JSON.parse(raw) as { x: number; y: number };
      } catch {
        return null;
      }
    };
    // 1. A pointer MOVE over the node, at VIEWPORT coordinates the page computed.
    //    Element-origin would ask the driver to resolve the element, which is the
    //    very hit test that is stale.
    const pt = await centre();
    if (pt !== null) {
      try {
        await this.session.send("POST", "/actions", {
          actions: [
            {
              type: "pointer",
              id: "mouse",
              parameters: { pointerType: "mouse" },
              actions: [
                { type: "pointerMove", duration: 0, origin: "viewport", x: pt.x, y: pt.y },
              ],
            },
          ],
        });
        await this.session.send("DELETE", "/actions");
        hover = "sent";
      } catch {
        hover = "refused";
      }
    }
    // 2. Re-establish the nearest scrollable ancestor's OWN overflow, in two
    //    round trips so a frame passes with it released: the layer teardown that
    //    refreshes the hit map is committed by the next paint, not inside the
    //    task that asked for it (measured: a single-task toggle leaves the map
    //    stale, the same toggle split across two evaluates cures it).
    const toggleScript = (mode: string) =>
      "var el = arguments[0], mode = arguments[1];" +
      "var n = el;" +
      "while (n && n !== document.body) {" +
      "  var cs = getComputedStyle(n);" +
      "  if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {" +
      "    if (mode === 'remember') {" +
      "      n.dataset.e2eOverflow = (n.style.overflow || '');" +
      "      n.style.overflow = 'visible';" +
      "      void n.offsetHeight;" +
      "      return 'released';" +
      "    }" +
      "    n.style.overflow = n.dataset.e2eOverflow || '';" +
      "    delete n.dataset.e2eOverflow;" +
      "    void n.offsetHeight;" +
      "    return 'restored';" +
      "  }" +
      "  n = n.parentElement;" +
      "}" +
      "return 'none';";
    try {
      const args = [{ [ELEMENT_KEY]: this.elementId }];
      toggle = await this.session.execute<string>(toggleScript("remember"), args);
      if (toggle === "released") {
        await this.session.execute<string>(toggleScript("restore"), args);
      }
      hit = await this.session.execute<string>(
        "var el = arguments[0]; if (!el) return 'gone';" +
          "var r = el.getBoundingClientRect();" +
          "return document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).indexOf(el) === -1 ? 'no' : 'yes';",
        args,
      );
    } catch {
      // Best-effort by design; the timeout below is still the failure.
    }
    this.lastRefresh = `hover:${hover} toggle:${toggle} hit:${hit}`;
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
    const sequence = (origin: unknown, x: number, y: number) => ({
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", duration: 0, origin, x, y },
            { type: "pause", duration: 200 },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    try {
      await this.session.send(
        "POST",
        "/actions",
        sequence({ [ELEMENT_KEY]: this.elementId }, offsetX, offsetY),
      );
    } catch (raw) {
      // **WebKit 2.54 applies the interactability check to an ELEMENT origin's
      // pointer move too**, which is the check this method exists to bypass
      // (`element not interactable` raised by `/actions`, measured 2026-11-03 in
      // `e2e/Dockerfile`'s seat against `heading-list-folding`). The W3C route
      // that carries no element reference is a VIEWPORT coordinate, so the same
      // gesture is re-sent from the element's own rect. Opacity was never the
      // obstacle: a hover-revealed gutter marker is hit-testable, its centre is
      // simply computed here instead of being looked up by the driver.
      if (!/not interactable/i.test((raw as Error).message)) throw raw;
      // The rect comes from the PAGE, not from `GET /rect`: the driver answers
      // that one with the same refusal it gave the sequence above, so a fallback
      // built on it fails one call later with the identical message (measured
      // 2026-11-03: `element not interactable` from both the element-origin
      // `/actions` and `GET /rect`, while the viewport-origin sequence the page's
      // own rect feeds SUCCEEDS on the same node).
      const rect = await this.session.execute<{ x: number; y: number; width: number; height: number }>(
        "const el = arguments[0]; if (!el) return null; const r = el.getBoundingClientRect();" +
          "return { x: r.x, y: r.y, width: r.width, height: r.height };",
        [{ [ELEMENT_KEY]: this.elementId }],
      );
      if (rect === null || rect === undefined) throw raw;
      await this.session.send(
        "POST",
        "/actions",
        sequence(
          "viewport",
          Math.round(rect.x + rect.width / 2 + offsetX),
          Math.round(rect.y + rect.height / 2 + offsetY),
        ),
      );
    }
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
  /**
   * Type into this element through the driver, and fall back to the page when the
   * driver will not answer.
   *
   * `POST /element/<id>/value` (W3C Element Send Keys) hangs for its whole budget
   * on this WebKitGTK build for SOME inputs while the page itself is perfectly
   * alive — measured 2026-11-08, twice in a row at 60 s each, on the member
   * scenarios' invite/identity fields, with `execute` answering normally on the
   * same session. The short bound and the page-side fallback are what turn that
   * from a scenario-killer into a keystroke.
   *
   * The fallback is not a shortcut around React: it uses the native value setter
   * and dispatches `input` + `change`, which is what a controlled input listens
   * for — the same technique `replaceText` documents (W3C `clear` sets the value
   * outside the keystroke path and React's tracker then ignores it).
   */
  async sendKeys(text: string): Promise<void> {
    try {
      await this.session.send("POST", this.path("/value"), { text }, SEND_KEYS_TIMEOUT_MS);
      return;
    } catch (e) {
      if (!(e instanceof Error) || !/did not answer/.test(e.message)) throw e;
    }
    await this.setText(text);
  }

  /** Set the value in ONE page-side act: the native setter, then the two events a
   *  controlled input listens for. */
  private setText(text: string): Promise<void> {
    return this.session.execute<void>(
      "var el = arguments[0], text = arguments[1];" +
        "el.focus();" +
        "var proto = Object.getPrototypeOf(el);" +
        "var desc = Object.getOwnPropertyDescriptor(proto, 'value');" +
        "if (desc && desc.set) desc.set.call(el, text); else el.value = text;" +
        "el.dispatchEvent(new Event('input', { bubbles: true }));" +
        "el.dispatchEvent(new Event('change', { bubbles: true }));",
      [{ [ELEMENT_KEY]: this.elementId }, text],
    );
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
    // **Long text pastes; it does not type.** Keystrokes are replayed one char at
    // a time and the app pays a React render for each: measured 2026-11-09 on the
    // roster's identity-code field, a 730-char code did not finish inside 180 s
    // (`POST /element/<id>/value`, Element Send Keys, timed out three times and the
    // page-side retry then queued behind the backlog the first one left). No user
    // types an identity code - it is pasted - so one page-side set is both the
    // honest and the only bounded shape.
    if (text.length > PASTE_ABOVE_CHARS) {
      await this.setText(text);
      return;
    }
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
    let refreshed = false;
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
            // A stale hit-test map refuses the pointer MOVE before any button
            // event exists, so this is the same one-shot repair `click()` makes.
            // Measured 2026-11-03: the tab strip's `tab.pin` menu never opened
            // for its whole 10 s budget while the tab was visible, because the
            // strip had overflowed and the driver could not resolve the element.
            if (!refreshed) {
              refreshed = true;
              await this.refreshHitTestMap();
            }
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

  send<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    return wire<T>(this.baseUrl, method, `/session/${this.sessionId}${path}`, body, 0, timeoutMs);
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

  /** Poll until the selector matches; the harness's default lookup.
   *
   *  A timeout here appends {@link missingTestIdHint}: when the id is named
   *  nowhere in the shared tree, the wait could never have succeeded and the
   *  failure is a withdrawn affordance rather than a slow render. That hint is
   *  what turns "45 s timeout on `welcome.join-cta`" into a one-line diagnosis
   *  (measured: two days of red, 2026-11-01 to 2026-11-03). */
  async waitForElement(cssSelector: string, opts?: FindOptions): Promise<Element> {
    try {
      return await this.waitUntil(
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
    } catch (raw) {
      const hint = missingTestIdHint(cssSelector);
      if (hint === "") throw raw;
      throw new Error(`${(raw as Error).message}${hint}`);
    }
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
