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
  pageSeatInvoke,
  selectedNoteId,
  unlockToEditor,
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
 *  line on screen identifies itself. */
const LONG_BODY = [
  "# Long note",
  ...Array.from({ length: 250 }, (_, i) => `line ${i}`),
].join("\n");

/** The pane's scroll offset, or -1 when nothing scrolls yet. */
async function scrollTop(s: Session): Promise<number> {
  return s.execute<number>(
    "var content = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
      "if (!content) return -1;" +
      "var host = content.parentElement;" +
      "while (host) {" +
      "  var oy = getComputedStyle(host).overflowY;" +
      "  if ((oy === 'auto' || oy === 'scroll') && host.scrollHeight > host.clientHeight + 1) break;" +
      "  host = host.parentElement;" +
      "}" +
      "return host ? Math.round(host.scrollTop) : -1;",
  );
}

/** Scroll the pane to `top` and report where it actually landed. */
async function scrollTo(s: Session, top: number): Promise<number> {
  return s.execute<number>(
    "var content = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
      "if (!content) return -1;" +
      "var host = content.parentElement;" +
      "while (host) {" +
      "  var oy = getComputedStyle(host).overflowY;" +
      "  if ((oy === 'auto' || oy === 'scroll') && host.scrollHeight > host.clientHeight + 1) break;" +
      "  host = host.parentElement;" +
      "}" +
      "if (!host) return -1;" +
      `host.scrollTop = ${top};` +
      "host.dispatchEvent(new Event('scroll'));" +
      "return Math.round(host.scrollTop);",
  );
}

/** Wait until the pane is scrollable, so a scroll can be performed at all. */
async function waitScrollable(s: Session): Promise<void> {
  await s.waitUntil(async () => ((await scrollTop(s)) >= 0 ? true : null), {
    label: "the pane has something to scroll",
    timeoutMs: 20_000,
  });
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
      "  var host = contents[i].parentElement;" +
      "  while (host) {" +
      "    var oy = getComputedStyle(host).overflowY;" +
      "    if ((oy === 'auto' || oy === 'scroll') && host.scrollHeight > host.clientHeight + 1) break;" +
      "    host = host.parentElement;" +
      "  }" +
      "  out.push(host ? Math.round(host.scrollTop) : -1);" +
      "}" +
      "return out;",
  );
}

async function writeBody(s: Session, noteId: string, body: string): Promise<void> {
  const r = await pageSeatInvoke(
    s,
    "plugin:notes|note_update",
    { noteId, plaintext: body },
    IPC_TIMEOUT,
  );
  expect(r.err, "note_update should accept the long body").toBeUndefined();
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
        await waitScrollable(s);
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
        await waitScrollable(s);

        // Back near where the reader was. A generous floor rather than pixel
        // parity: the anchor is a document position, so the restore lands on the
        // LINE, and the pixel it resolves to is the layout's business.
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
        await waitScrollable(s);
        const parked = await scrollTo(s, 1200);
        expect(parked, "the pane should have scrolled").toBeGreaterThan(400);

        // The remember is debounced to scroll-settle, the same window sm1 gives
        // it. Nothing in the DOM reports the anchor, so there is no observable
        // effect to wait on instead.
        await new Promise((r) => setTimeout(r, 600));

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
        let seen: number[] = [];
        const tops = await s.waitUntil(
          async () => {
            seen = await scrollTopsAll(s);
            return seen.length === 1 && seen[0]! > 400 ? seen : null;
          },
          {
            // The label carries the last reading, so a timeout says what the
            // offset actually was rather than only that the wait ran out.
            // Offsets are layout numbers, never note content (SYNC-13).
            label: () => `the surviving pane near the parked line (last: [${seen.join(", ")}])`,
            timeoutMs: 20_000,
          },
        );
        expect(tops[0], "the split must not send the reader back to the top").toBeGreaterThan(400);
      },
    );
  });
});
