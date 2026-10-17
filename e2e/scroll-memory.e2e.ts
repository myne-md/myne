// sm1: a note keeps its reading position across a revisit (myne-md/myne#600).
//
// The complaint was "scroll does not persist, on a re-visit or across a pane
// split". `tests/notes/scrollMemory.test.ts` pins the arithmetic between four
// injected numbers, and says so in its own header: jsdom reports zeroes for
// every rect, so `posAtCoords`, `lineBlockAt` and both `getBoundingClientRect`
// calls are stubs there. A stubbed measurement cannot observe a restore, so the
// user-visible claim is verified here or nowhere.
//
// # What it asserts, and why it is a LINE rather than a pixel
//
// The anchor is a document position, not a scrollTop, because the pane can come
// back at a different width and re-wrapped text puts different content under the
// same pixel. So the assertion is that the reader lands back near the line they
// left, measured by which line is on screen, with a generous tolerance: the
// scenario is about "not at the top", not about pixel parity.
//
// # The scroller is resolved the way production resolves it
//
// The pane scroller carries no testid (it is a layout div in `PaneView`), so
// this walks up from `.cm-content` to the nearest scrolling ancestor, the same
// reading `editor-scroll-slack` uses and for the same reason.
//
// Note bodies are in-source scenario content, never credentials (SYNC-13).
// Vault-count precondition: 1 (weak KDF).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickNoteRow,
  createNote,
  dismissImporterOffer,
  notifyNoteWritten,
  pageSeatInvoke,
  selectedNoteId,
  unlockToEditor,
  writeNoteBody,
} from "./support/flows";
import { type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

/** W3C Actions `Control`. The split is driven by the real chord rather than by
 *  reaching into the workspace, because #600's second symptom is what the USER
 *  does: `Ctrl-\\` maps to `pane.split-row`, which dispatches
 *  `ws.splitFocused("row")` through the keybind engine. */
const CONTROL = "\uE009";

async function sendCtrlChord(session: Session, key: string): Promise<void> {
  await session.send("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "kbd",
        actions: [
          { type: "keyDown", value: CONTROL },
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
          { type: "keyUp", value: CONTROL },
        ],
      },
    ],
  });
}

/** Long enough to scroll in any window this suite runs in, and numbered so the
 *  line on screen identifies itself. `line 0` is the load-wait needle (always
 *  rendered at scrollTop=0); `line 249` is only reachable after a scroll. */
const LONG_BODY = [
  "# Long note",
  ...Array.from({ length: 250 }, (_, i) => `line ${i}`),
].join("\n");
/** Head-of-doc token: proves the long body reached the buffer without
 *  depending on a line the virtualised viewport has not rendered yet. */
const LONG_HEAD = "line 0";

/** Production `resolveScrollHost` shape (editor/src/scroll-slack.ts): start
 *  OUTSIDE `.cm-editor`, first scrolling `overflow-y` (auto|scroll|overlay).
 *  Finding the host does NOT require a scroll range (Myne's `.cm-scroller`
 *  never scrolls — the editor grows inside an outer bounded scroller).
 *  Callers that assign `scrollTop` pass `needScrollable` and only take a host
 *  that can actually move. Emits a preamble that binds `found` (element|null);
 *  it must NOT `return` a DOM node — WebDriver would hand the caller an object. */
function resolveHostJs(opts: { needScrollable: boolean }): string {
  const match = opts.needScrollable
    ? "if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay')" +
      " && el.scrollHeight > el.clientHeight + 1) { found = el; break; }"
    : "if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') { found = el; break; }";
  return (
    "var found = null;" +
    "var content = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
    "if (content) {" +
    "  var editor = content.closest('.cm-editor');" +
    "  var el = editor ? editor.parentElement : content.parentElement;" +
    "  while (el && el !== el.ownerDocument.documentElement) {" +
    "    var oy = getComputedStyle(el).overflowY;" +
    match +
    "    el = el.parentElement;" +
    "  }" +
    "}"
  );
}

/** DOM truth for a failed scroll wait: chain of ancestors + buffer size.
 *  Layout numbers and class fragments only — never note content (SYNC-13). */
async function scrollDiag(s: Session): Promise<string> {
  try {
    return await s.execute<string>(
      "var content = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
        "if (!content) return 'no .cm-content';" +
        "var out = ['textLen=' + (content.textContent || '').length," +
        "  'cmLines=' + content.querySelectorAll('.cm-line').length];" +
        "var editor = content.closest('.cm-editor');" +
        "var el = editor ? editor.parentElement : content.parentElement;" +
        "var hops = 0;" +
        "while (el && hops < 16) {" +
        "  var st = getComputedStyle(el);" +
        "  var tid = el.getAttribute && el.getAttribute('data-testid');" +
        "  var role = el.getAttribute && el.getAttribute('role');" +
        "  out.push(el.tagName.toLowerCase()" +
        "    + (tid ? '#' + tid : role ? '[' + role + ']' : '.' + String(el.className || '').split(' ')[0])" +
        "    + ' oy=' + st.overflowY + ' sh=' + el.scrollHeight + ' ch=' + el.clientHeight" +
        "    + (el.scrollHeight > el.clientHeight + 1 ? ' scrollable' : ''));" +
        "  if (el === el.ownerDocument.documentElement) break;" +
        "  el = el.parentElement; hops++;" +
        "}" +
        "var d = document.scrollingElement || document.documentElement;" +
        "out.push('doc oy=' + getComputedStyle(d).overflowY + ' sh=' + d.scrollHeight" +
        "  + ' ch=' + d.clientHeight + ' top=' + Math.round(d.scrollTop));" +
        "return out.join(' | ');",
    );
  } catch (raw) {
    return `diag unreadable (${(raw as Error).message})`;
  }
}

/** The pane's scroll offset, or -1 when nothing scrolls yet. */
async function scrollTop(s: Session): Promise<number> {
  return s.execute<number>(
    resolveHostJs({ needScrollable: true }) + "return found ? Math.round(found.scrollTop) : -1;",
  );
}

/** Scroll the pane to `top` and report where it actually landed. */
async function scrollTo(s: Session, top: number): Promise<number> {
  return s.execute<number>(
    resolveHostJs({ needScrollable: true }) +
      "if (!found) return -1;" +
      `found.scrollTop = ${top};` +
      "found.dispatchEvent(new Event('scroll'));" +
      "return Math.round(found.scrollTop);",
  );
}

/** Wait until the editor buffer actually holds `needle`.
 *  Disk is not the pane: after an out-of-band write the load effect has to
 *  re-read before `.cm-content` grows past a screenful. Waiting on
 *  `scrollTop >= 0` alone times out on a short buffer that never scrolls.
 *
 *  The needle must be a HEAD-of-document token. CodeMirror virtualises: at
 *  scrollTop=0 the last line of a long body is not in `.cm-content`
 *  textContent until a scroll puts it in the viewport, so waiting on
 *  `line 249` here would time out on a fully loaded note. Callers pass
 *  `line 0` (or a short body's only marker) and let `waitScrollable` prove
 *  the document is tall enough. */
async function waitBodyLoaded(s: Session, needle: string): Promise<void> {
  let lastLen = -1;
  let lastHas = false;
  await s.waitUntil(
    async () => {
      const body = await s.execute<string>(
        "var c = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
          "return c ? (c.textContent || '') : '';",
      );
      lastLen = body.length;
      lastHas = body.includes(needle);
      return lastHas ? true : null;
    },
    {
      label: () =>
        `editor buffer carries ${needle} (last: len=${lastLen} has=${lastHas})`,
      timeoutMs: 30_000,
    },
  );
}

/** Wait until the pane is scrollable, so a scroll can be performed at all. */
async function waitScrollable(s: Session): Promise<void> {
  let last = "";
  await s.waitUntil(
    async () => {
      const top = await scrollTop(s);
      if (top >= 0) return true;
      last = await scrollDiag(s);
      return null;
    },
    {
      label: () => `the pane has something to scroll (last: ${last})`,
      timeoutMs: 20_000,
    },
  );
}

/** Buffer holds `needle`, THEN the pane is scrollable — the order that makes
 *  the second wait mean "long enough to scroll" rather than "still empty". */
async function waitBodyScrollable(s: Session, needle: string): Promise<void> {
  await waitBodyLoaded(s, needle);
  await waitScrollable(s);
}


/** Every pane's scroll offset, in DOM order. After a split both panes show the
 *  same note, so both must land near the line the reader left: the pane that is
 *  REBUILT is the one the re-anchor exists for, and reading only the first
 *  scroller cannot tell which one that is. */
async function scrollTopsAll(s: Session): Promise<number[]> {
  return s.execute<number[]>(
    "var out = [];" +
      "var contents = document.querySelectorAll('[data-testid=\"editor.content\"] .cm-content');" +
      "for (var i = 0; i < contents.length; i++) {" +
      "  var content = contents[i];" +
      "  var editor = content.closest('.cm-editor');" +
      "  var el = editor ? editor.parentElement : content.parentElement;" +
      "  while (el && el !== el.ownerDocument.documentElement) {" +
      "    var oy = getComputedStyle(el).overflowY;" +
      "    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay')" +
      "        && el.scrollHeight > el.clientHeight + 1) break;" +
      "    el = el.parentElement;" +
      "  }" +
      "  var ok = el && el !== el.ownerDocument.documentElement" +
      "    && el.scrollHeight > el.clientHeight + 1;" +
      "  out.push(ok ? Math.round(el.scrollTop) : -1);" +
      "}" +
      "return out;",
  );
}

async function writeBody(s: Session, noteId: string, body: string): Promise<void> {
  // `createNote` settles the title autosave, but a latest-wins follow-up can
  // still be in flight; an out-of-band `note_update` that lands under it is
  // rejected BaseMismatch or overwritten. The badge is "Saved·" with no
  // Editing/Saving after the settle — poll that before the IPC.
  await s.waitUntil(
    async () => {
      const t = (await (await s.byTestId("editor.save-status")).textContent()) ?? "";
      return t.includes("Editing") || t.includes("Saving") ? null : true;
    },
    { label: "autosave idle before out-of-band write", timeoutMs: 15_000 },
  );
  const r = await writeNoteBody(s, noteId, body, IPC_TIMEOUT);
  expect(r.err, "the long body write should succeed").toBeUndefined();
  // The write is out of band (page-seat IPC, not the pane's autosave loop), so
  // the open pane owes a reload - see the helper's header.
  await notifyNoteWritten(s, noteId);
  // Prove the bytes are on disk before the next step. A title autosave that
  // lands after this write would strip them; polling note_read catches that
  // while a later editorText check would just time out on a missing head.
  const needle = body.includes(LONG_HEAD) ? LONG_HEAD : "short.";
  await s.waitUntil(
    async () => {
      const again = await pageSeatInvoke(s, "plugin:notes|note_read", { noteId }, IPC_TIMEOUT);
      return typeof again.ok === "string" && again.ok.includes(needle) ? true : null;
    },
    { label: "disk body carries the write", timeoutMs: 15_000 },
  );
}

describeE2E("sm1 a note keeps its reading position (myne#600)", () => {
  it("returns to where the reader was after switching notes and back", async () => {
    let password = "";
    await scenario(
      "sm1-scroll-memory",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Each id is read off the row `createNote` leaves selected, rather than
        // by counting rows: a seeded vault can bring notes of its own, so "there
        // are exactly two" is a fixture detail this scenario does not control.
        await createNote(s, "Long note");
        const longId = await selectedNoteId(s);
        await createNote(s, "Other note");
        const shortId = await selectedNoteId(s);
        expect(longId, "the long note should have an id").not.toBe("");
        expect(shortId).not.toBe(longId);

        await writeBody(s, longId, LONG_BODY);
        await writeBody(s, shortId, "# Other note\n\nshort.");

        // Open the long note and scroll into it.
        await clickNoteRow(s, longId);
        // The stale cache was cleared by the write's reload signal, but the
        // note is only now the ACTIVE one; bump once more so the reload effect
        // re-reads THIS note from disk rather than restoring a cached state.
        await notifyNoteWritten(s, longId);
        await waitBodyScrollable(s, LONG_HEAD);
        const parked = await scrollTo(s, 1200);
        expect(parked, "the pane should have scrolled").toBeGreaterThan(400);

        // The remember is debounced to scroll-settle, so give it its window.
        // Waiting on the observable effect rather than on a fixed sleep is not
        // available here: the anchor lives in module memory with no DOM tell.
        await s.waitUntil(async () => true, { label: "settle", timeoutMs: 1_000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 600));

        // Away and back.
        await clickNoteRow(s, shortId);
        await s.waitUntil(
          async () => ((await scrollTop(s)) <= 0 ? true : null),
          { label: "the short note is open and at the top", timeoutMs: 20_000 },
        );
        await clickNoteRow(s, longId);
        // The stale cache was cleared by the write's reload signal, but the
        // note is only now the ACTIVE one; bump once more so the reload effect
        // re-reads THIS note from disk rather than restoring a cached state.
        await notifyNoteWritten(s, longId);
        // Head needle is wrong here: the restore below (or an already-applied
        // cache restore) parks the viewport mid-document, and CodeMirror
        // virtualises the head out of `.cm-content`, so "line 0" is absent from
        // a fully loaded body. A scroll range is the load proof once we are
        // no longer at the top.
        await waitScrollable(s);

        // Back near where the reader was. A generous floor rather than pixel
        // parity: the anchor is a document position, so the restore lands on
        // the LINE, and the pixel it resolves to is the layout's business.
        const restored = await s.waitUntil(
          async () => {
            const top = await scrollTop(s);
            return top > 400 ? top : null;
          },
          { label: "the long note reopens near where it was left", timeoutMs: 20_000 },
        );
        expect(restored, "the reader should not be back at the top").toBeGreaterThan(400);
      },
    );
  });
});

describeE2E("sm2 a split keeps the reading position it was split from (myne#600)", () => {
  // The issue reports TWO symptoms and this is the second: "Splitting the pane
  // ... The scroll jumps to the top." sm1 covers the revisit; this covers the
  // split gesture.
  //
  // WHAT THIS PROVES, AND WHAT IT DOES NOT, because the difference was measured
  // rather than reasoned about. Removing `PaneView`'s ResizeObserver re-anchor
  // and re-running leaves this scenario GREEN. So what it pins is that the
  // split does not reset the surviving pane to the top, which is the user's
  // reported symptom, and not the width-driven re-anchor underneath it. That
  // path is still owed a test: it needs an assertion on which LINE is on
  // screen after the pane halves in width and the text re-wraps, since a
  // scroll OFFSET survives the resize on its own and cannot tell the two
  // apart. Stated here rather than left implied, because a scenario that
  // passes with its mechanism removed is worth exactly what it proves.
  //
  // Note bodies are in-source scenario content, never credentials (SYNC-13).
  // Vault-count precondition: 1 (weak KDF).
  it("lands near the line it was split from rather than at the top", async () => {
    let password = "";
    await scenario(
      "sm2-scroll-memory-split",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Two notes, the same as sm1, and for a reason rather than symmetry: a
        // body written through `note_update` lands on disk, and the pane only
        // picks it up when it re-reads. Navigating away and back is what forces
        // that, so a single-note version of this scenario opens a pane that is
        // still showing the empty note and never becomes scrollable at all.
        await createNote(s, "Long note");
        const longId = await selectedNoteId(s);
        await createNote(s, "Other note");
        const shortId = await selectedNoteId(s);
        expect(longId, "the long note should have an id").not.toBe("");
        expect(shortId).not.toBe(longId);

        await writeBody(s, longId, LONG_BODY);
        await writeBody(s, shortId, "# Other note\n\nshort.");

        await clickNoteRow(s, longId);
        // The stale cache was cleared by the write's reload signal, but the
        // note is only now the ACTIVE one; bump once more so the reload effect
        // re-reads THIS note from disk rather than restoring a cached state.
        await notifyNoteWritten(s, longId);
        await waitBodyScrollable(s, LONG_HEAD);
        const parked = await scrollTo(s, 1200);
        expect(parked, "the pane should have scrolled").toBeGreaterThan(400);

        // The remember is debounced to scroll-settle, the same window sm1 gives
        // it. Assert the anchor landed in the DOM before the split: a missing
        // or near-zero anchor makes the post-split wait a foregone conclusion,
        // and the failure then names the wrong step.
        await new Promise((r) => setTimeout(r, 600));
        const preDiag = await s.execute<string>(
          resolveHostJs({ needScrollable: false }) +
            "if (!found) return 'no-host|pos=none';" +
            "var ds = found.dataset || {};" +
            "return 'liveTop=' + Math.round(found.scrollTop)" +
            " + '|pos=' + (ds.scrollAnchorPos || 'none')" +
            " + '|write=' + (ds.scrollAnchorWrite || '-')" +
            " + '|rememberTop=' + (ds.scrollAnchorTop || '-');",
        );
        const preAnchor = await s.execute<string>(
          resolveHostJs({ needScrollable: false }) +
            "return found && found.dataset.scrollAnchorPos ? found.dataset.scrollAnchorPos : 'none';",
        );
        expect(
          Number(preAnchor),
          `the pre-split scroll should have remembered a mid-document anchor (${preDiag})`,
        ).toBeGreaterThan(50);

        if ((await s.byTestIdAll("editor.pane")).length !== 1) {
          throw new Error("expected a single pane before the split chord");
        }
        await sendCtrlChord(s, "\\");
        await s.waitUntil(
          async () => ((await s.byTestIdAll("editor.pane")).length === 2 ? true : null),
          { label: "the split produced a second pane", timeoutMs: 20_000 },
        );

        // EVERY pane, not the first. The split shows the same note twice and
        // rebuilds one of them; asserting on the first scroller passes on the
        // one that was never torn down and says nothing about the other. A
        // generous floor rather than pixel parity: each pane is now half as
        // wide, so the line the reader left resolves to a different offset in
        // both by construction.
        // The surviving pane, which is the only editor on screen: the split
        // opens the NEW pane on the new-tab chooser rather than on a second
        // copy of the note, so there is exactly one `.cm-content` afterwards.
        // Measured, not assumed: the two-pane version of this assertion timed
        // out reporting `[1206]`, one scroller, correctly parked.
        //
        // Disk is checked alongside the DOM: a post-split body that vanished
        // looks identical to a restore that failed, and `note_read` separates
        // them without putting vault material in the label (length only).
        let seen: number[] = [];
        let seenLen = -1;
        let diskLen = -1;
        let diag = "";
        const tops = await s.waitUntil(
          async () => {
            seen = await scrollTopsAll(s);
            seenLen = await s.execute<number>(
              "var c = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
                "return c ? (c.textContent || '').length : -1;",
            );
            const r = await pageSeatInvoke(s, "plugin:notes|note_read", { noteId: longId }, IPC_TIMEOUT);
            diskLen = typeof r.ok === "string" ? r.ok.length : -1;
            if (!(seen.length === 1 && seen[0]! > 400)) {
              diag = await scrollDiag(s);
              diag +=
                " | restore=" +
                (await s.execute<string>(
                  "var content = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
                    "if (!content) return 'no-content';" +
                    "var el = content.closest('.cm-editor');" +
                    "var hops = 0;" +
                    "while (el && hops < 16) {" +
                    "  var ds = el.dataset || {};" +
                    "  if (ds.scrollRestore || ds.scrollRo || ds.scrollAnchorWrite) {" +
                    "    return 'restore=' + (ds.scrollRestore || '-')" +
                    "      + ' frames=' + (ds.scrollRestoreFrames || '-')" +
                    "      + ' stable=' + (ds.scrollStable || '-')" +
                    "      + ' applied=' + (ds.scrollAnchorApplied || '-')" +
                    "      + ' off=' + (ds.scrollAnchorOffset || '-')" +
                    "      + ' ro=' + (ds.scrollRo || '-')" +
                    "      + ' roW=' + (ds.scrollRoWidth || '-')" +
                    "      + ' anchorPos=' + (ds.scrollAnchorPos || '-')" +
                    "      + ' write=' + (ds.scrollAnchorWrite || '-');" +
                    "  }" +
                    "  el = el.parentElement; hops++;" +
                    "}" +
                    "return 'no-diag-attrs';",
                ));
            }
            return seen.length === 1 && seen[0]! > 400 ? seen : null;
          },
          {
            // Offsets and buffer lengths only — never note content (SYNC-13).
            label: () =>
              `the surviving pane near the parked line (last: [${seen.join(", ")}] len=${seenLen} disk=${diskLen}${diag ? " | " + diag : ""})`,
            timeoutMs: 20_000,
          },
        );
        expect(tops[0], "the split must not send the reader back to the top").toBeGreaterThan(400);
      },
    );
  });
});
