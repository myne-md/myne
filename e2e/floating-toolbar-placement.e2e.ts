// ftp1 — the floating toolbar stays on screen and off the selection, wherever
// the selection is. myne-md/myne#555, the
// `settings.block.toolbar-customize` / `editor.formatting-toolbar` bullet:
//
//   > select at the first line, the last visible line and a right-edge line;
//   > "flips or clamps fully on screen, never covering the selection" is a
//   > `getBoundingClientRect` comparison against the pane rect and the
//   > selection rect.
//
// # The walk this retires
//
// Select text at the top of the pane, at the bottom, and at the right edge, and
// look at whether the toolbar is cut off or sitting on top of what you just
// selected. Three positions, judged by eye, on a surface that only appears while
// a selection exists — so the tester has to hold the selection and look at the
// same time.
//
// # The two failures, and why the second one is the one that gets shipped
//
// **Off screen** is obvious the moment it happens: half the controls are gone.
// It is also the one a developer notices, because they select in the middle of
// their own pane.
//
// **Covering the selection** is the one that survives to a release. The toolbar
// is anchored to the selection, so the natural implementation puts it directly
// above — and directly above is exactly where the text is when the selection is
// on the first visible line. The user selects a word, the toolbar appears over
// it, and formatting becomes a guess about what is underneath.
//
// # What is measured, and a correction to the bullet
//
// The toolbar's rect against two others: the WINDOW's (containment) and the
// selection's (no intersection). Both are `getBoundingClientRect`, which is what
// makes this mechanical rather than visual.
//
// The bullet says "against the pane rect". That is the wrong container, and
// asserting it fails on correct behaviour — measured: at a selection near the
// pane's right margin the toolbar spans 609..943 while the pane spans 284..796,
// and the window is 1100 wide. The toolbar is mounted on `document.body`, so the
// pane is not its clipping context and it has no reason to stay inside one;
// what the user needs is what the bullet's own phrase says, "fully on screen".
//
// The pane rect is still measured and still quoted in every failure message,
// because "the toolbar left the pane" is useful context for someone reading a
// containment failure. It is context, not the bound.
//
// The selection rect comes from the DOM Selection API rather than from the line
// element: a selection is a range, and on a wrapped line the range's box is not
// the line's box. Using the line would make the no-overlap assertion loose
// exactly where wrapping makes it interesting.
//
// # Selecting at three positions without a drag
//
// Double-click selects a word — the precedent `toolbar-customize.e2e.ts` sets,
// and the reason it sets it: an HTML5 drag through CodeMirror is the flakiest
// input this suite has. So the note is written with a long word at a known
// place on each of three lines, and the position is chosen by WHICH LINE is
// double-clicked rather than by dragging within one.
//
// The bullet's RIGHT-EDGE case is not here, and the reason is the same
// constraint: `doubleClick()` targets an element's centre and takes no offset,
// so selecting at a known horizontal position needs either a drag (the flakiest
// input this suite has, which is why the double-click precedent exists at all)
// or a hand-built pointer sequence with an offset. The horizontal clamp is still
// exercised — the toolbar is centred on the selection and the pane is off-centre
// in the window, so it runs past the pane on every probe — but this file does
// not claim to have selected AT the right margin, and a scenario that needs to
// should build the offset double-click rather than assume this one did.
//
// # What is NOT here, and why
//
// The high-DPR arm (`GDK_SCALE=2`) the bullet names. `LaunchOptions.env` can
// deliver it now, but device-pixel ratio does not move a CSS-pixel rect: every
// assertion below is in CSS pixels and would read identically. What DPR could
// change is sub-pixel rounding at the clamp boundary, which is a different and
// much narrower claim than "flips or clamps fully on screen", and it deserves
// its own scenario rather than a second launch inside this one.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import { type Session } from "./support/webdriver";

/** The floating toolbar mounts on `document.body` as `.cm-toolbar` — a
 *  CodeMirror-plugin surface with no testid of its own, the `.cm-content`
 *  selector-exception class `toolbar-customize.e2e.ts` already relies on and
 *  names in its own header.
 *
 *  An earlier version of this file anchored on `toolbar.highlight` instead, to
 *  stay inside the testid rule. That control is CUSTOMIZABLE — the same
 *  scenario toggles it off and asserts its absence — so anchoring on it made
 *  this scenario depend on a user preference, and it timed out waiting for a
 *  control the default layout does not have to render. */
const FLOATING_TOOLBAR = ".cm-toolbar";

/**
 * Filler that makes a probe line span the pane's full width, out of SHORT
 * words rather than one long run.
 *
 * Both halves matter. Full width, because `doubleClick()` targets an element's
 * CENTRE and a line whose text stops short has its centre in empty space, where
 * a double-click selects nothing (measured: `{"collapsed":true,"selText":""}`).
 * Short words, because a 160-character run is ONE word: it wraps, the selection
 * spans several visual rows, and its bounding box then contains the toolbar by
 * construction — which failed the no-overlap assertion at 56..120 against a
 * toolbar at 60..98, on correct behaviour.
 */
const WIDE_LINE = "dolgu kelime satir genis ".repeat(8);

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

interface Placement {
  readonly toolbar: Box;
  /** The editor pane. Kept for context in failure messages; NOT the container
   *  the toolbar is clamped to — see the header. */
  readonly pane: Box;
  /** What "fully on screen" actually means here. */
  readonly viewport: Box;
  readonly selection: Box | null;
}

/**
 * Measure the toolbar, the pane it must stay inside, and the selection it must
 * not cover.
 *
 * `null` while any of the three is missing, so the caller can poll: the toolbar
 * is re-created on every selection change and a read can land between renders.
 */
async function readPlacement(s: Session): Promise<Placement | null> {
  const raw = await s.execute<string>(
    "var bar = document.querySelector('.cm-toolbar');" +
      "var content = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
      "if (!bar || !content) return '';" +
      // The pane the toolbar must stay inside: the nearest scrolling ancestor of
      // the content, which is what `scroll-slack.ts` resolves for the same
      // reason — `.cm-scroller` does not scroll in any Myne client.
      "var OK = { auto: 1, scroll: 1, overlay: 1 };" +
      "var pane = null;" +
      "for (var el = content.parentElement; el && el !== document.documentElement; el = el.parentElement) {" +
      "  if (OK[getComputedStyle(el).overflowY]) { pane = el; break; }" +
      "}" +
      "if (!pane) return '';" +
      // The SELECTION's own box, not the line's: a selection is a range, and on
      // a wrapped line the range's box is not the line's.
      "var sel = window.getSelection();" +
      "var selRect = null;" +
      "if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {" +
      "  var r = sel.getRangeAt(0).getBoundingClientRect();" +
      "  if (r.width > 0 && r.height > 0) selRect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };" +
      "}" +
      "function box(el) {" +
      "  var r = el.getBoundingClientRect();" +
      "  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };" +
      "}" +
      "return JSON.stringify({" +
      "  toolbar: box(bar), pane: box(pane), selection: selRect," +
      "  viewport: { left: 0, top: 0, right: document.documentElement.clientWidth," +
      "              bottom: document.documentElement.clientHeight }" +
      "});",
  );
  return raw ? (JSON.parse(raw) as Placement) : null;
}

/** Double-click the line at `index` until the toolbar is up and measurable. */
async function selectOnLine(s: Session, index: number): Promise<Placement> {
  return await s.waitUntil(
    async () => {
      const lines = await s.findElements(
        '[data-testid="editor.content"] .cm-content .cm-line',
      );
      if (lines.length <= index) return null;
      // Re-selecting per iteration is load-bearing, for the reason
      // `toolbar-customize.e2e.ts` gives: each double-click re-renders the
      // toolbar, so a read that lands mid-render fails the iteration rather
      // than the scenario.
      // Scrolled into view first. The driver's pointer move is refused with
      // `move target out of bounds` for an element whose centre is outside the
      // viewport, and the probe lines are deliberately spread across a document
      // taller than the pane.
      await lines[index]!.scrollIntoView();
      await lines[index]!.doubleClick();
      try {
        await s.waitForElement(FLOATING_TOOLBAR, { timeoutMs: 2_000 });
      } catch {
        return null;
      }
      const p = await readPlacement(s);
      return p !== null && p.selection !== null ? p : null;
    },
    {
      label: `the floating toolbar and a non-collapsed selection on line ${index}`,
      timeoutMs: 30_000,
    },
  );
}

function overlaps(a: Placement["toolbar"], b: NonNullable<Placement["selection"]>): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describeE2E("ftp1 the floating toolbar stays on screen and off the selection (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  // SKIPPED. The scenario is complete and its measurements are real — three of
  // them corrected the bullet and one corrected itself — but the FIRST-LINE
  // probe never reliably produces a selection, and I stopped rather than keep
  // guessing at the input method.
  //
  // WHAT WORKS, verified in the container: the note is written and reopened, the
  // toolbar surfaces, the selection is measurable, and the containment and
  // no-overlap assertions both run and both produce numbers.
  //
  // WHAT DOES NOT: `doubleClick()` on line 0 leaves the selection collapsed
  // often enough that the 30s retry loop expires. Four input problems were found
  // and fixed on the way there, and the fifth is unresolved:
  //
  //   1. The pane keeps a STALE BUFFER after an out-of-band `note_update`
  //      (`src/AGENTS.md` states it; `PaneView` re-reads only when
  //      `contentReloadNonce` changes). Without a refresh-and-reopen the editor
  //      still showed the EMPTY note, so every line was blank and every
  //      double-click selected nothing. Fixed.
  //   2. `doubleClick()` targets an element CENTRE, and a line whose text stops
  //      short of the pane width has its centre in empty space. Fixed by making
  //      every probe line span the full width.
  //   3. …but filling it with ONE long run makes a single word that WRAPS, so
  //      the selection spans several visual rows and its bounding box contains
  //      the toolbar by construction — the no-overlap assertion then fails on
  //      correct behaviour (measured: selection 56..120, toolbar 60..98). Fixed
  //      by filling with short words.
  //   4. A pointer move to an element outside the viewport is refused with
  //      `move target out of bounds`. Fixed with `scrollIntoView()`.
  //   5. UNRESOLVED: with all four fixed, line 0 still does not reliably select.
  //
  // TWO CORRECTIONS TO THE BULLET, both measured and both worth keeping:
  //
  //   * "against the pane rect" is the wrong container. The toolbar is mounted
  //     on `document.body`, so the pane is not its clipping context: at a
  //     selection near the pane's right margin it spans 609..943 while the pane
  //     spans 284..796, in an 1100px window. Asserting pane containment fails on
  //     correct behaviour. What the user needs is the bullet's own other phrase,
  //     "fully on screen" — the viewport, which is what this file asserts.
  //   * the RIGHT-EDGE probe cannot be built from `doubleClick()` at all, since
  //     it takes no offset. It needs a hand-built pointer sequence or a drag.
  //
  // Un-skip by making the selection reliable — most likely a pointer sequence
  // with an explicit offset into the line's text, which would also give the
  // right-edge probe the bullet asks for.
  it.skip("clamps inside the window and never covers the selection, at three positions", async () => {
    let seeded: SeededVault;
    await scenario(
      "ftp1-toolbar-placement",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        await createNote(s, "ftp1note");

        // Written through the real note_update IPC rather than typed. The
        // subject is PLACEMENT, and `e2e/AGENTS.md` records what typing a long
        // body through the driver costs: dropped keystrokes over a few hundred
        // characters, and a body that is not what the scenario meant to write.
        const row = await s.waitForElement('[data-testid="notes.row"][aria-current="true"]');
        const noteId = (await row.attribute("data-note-id")) ?? "";
        expect(noteId, "the created note has no id to write into").not.toBe("");

        // Three probe lines and enough filler between them that the third is
        // near the bottom of the pane rather than in the middle of it.
        // Every probe line is LONG, and that is not decoration. `doubleClick()`
        // targets an element's CENTRE, and a line whose text stops short of the
        // pane width has its centre in empty space after the text — where a
        // double-click selects nothing. Measured: with short probe lines the
        // page reported `{"collapsed":true,"selText":""}` and the toolbar never
        // appeared, so the scenario timed out looking like a broken toolbar.
        const body = [
          `${WIDE_LINE} birinci`,
          ...Array.from({ length: 30 }, (_, i) => `dolgu ${i}`),
          `${WIDE_LINE} ortada`,
          ...Array.from({ length: 30 }, (_, i) => `dolgu ${i + 30}`),
          `${WIDE_LINE} sonuncu`,
        ].join("\n");
        const wrote = await pageSeatInvoke(
          s,
          "plugin:notes|note_update",
          { noteId, plaintext: body },
          15_000,
        );
        expect(wrote.err, "note_update should succeed").toBeUndefined();

        // REFRESH AND REOPEN. A backend write made outside the pane's autosave
        // loop leaves that pane holding its stale buffer — `src/AGENTS.md` states
        // it, and `PaneView` re-reads only when `contentReloadNonce` changes.
        // Without this the editor still shows the EMPTY note, line 0 has no text,
        // the double-click selects nothing, and the scenario times out looking
        // like a broken toolbar. Measured: the page reported
        // `{"collapsed":true,"selText":""}` on every attempt.
        //
        // Same sequence `editor-scroll-slack.e2e.ts` uses for the same reason.
        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        await s.waitUntil(
          async () => {
            const tabs = await s.findElements('[data-testid="editor.tab"][data-active="true"]');
            if (tabs.length > 0) return true;
            await s.execute<number>(
              "var e = document.querySelector('[data-testid=\"notes.row\"][data-note-id=" +
                JSON.stringify(noteId) +
                "]'); if (e) { e.click(); return 1; } return 0;",
            );
            return null;
          },
          { label: "the probe note is open after the reload", timeoutMs: 20_000 },
        );
        // Tolerant after the reload: the vault now holds a note, so the
        // fresh-vault overlay is correctly absent and the strict helper would
        // burn its budget on something that is not there.
        await dismissImporterOfferIfPresent(s);
        await s.waitForElement('[data-testid="editor.content"] .cm-content .cm-line');

        // Line 0 is the first, which is where "directly above the selection"
        // puts the toolbar off the top of the pane — and where an
        // implementation that flips instead lands it on the text.
        // The long line is index 31 (0-based, after 30 filler lines).
        // The last probe line is the final one in the document.
        const probes: ReadonlyArray<{ index: number; what: string }> = [
          { index: 0, what: "the FIRST line, where there is no room above" },
          { index: 31, what: "a line in the MIDDLE, where both directions are free" },
          { index: 62, what: "the LAST line, where there is no room below" },
        ];

        for (const probe of probes) {
          const p = await selectOnLine(s, probe.index);
          const sel = p.selection!;

          // NON-VACUITY: the toolbar has a real box. A zero-size element is
          // inside every rect and overlaps nothing.
          expect(
            p.toolbar.right - p.toolbar.left,
            `the toolbar measured zero width at ${probe.what}, so containment and ` +
              `non-overlap both hold trivially`,
          ).toBeGreaterThan(20);

          // CONTAINMENT. A toolbar half off the pane is half its controls gone,
          // and the user cannot scroll to them: it is anchored to a selection
          // that moves when they try.
          expect(
            p.toolbar.left >= p.viewport.left - 1 &&
              p.toolbar.right <= p.viewport.right + 1,
            `at ${probe.what} the toolbar spans ${Math.round(p.toolbar.left)}..` +
              `${Math.round(p.toolbar.right)} while the window spans ` +
              `${Math.round(p.viewport.left)}..${Math.round(p.viewport.right)} — it is ` +
              `not clamped horizontally. The controls past the edge are unreachable, ` +
              `and they cannot be scrolled to: the toolbar is anchored to a selection ` +
              `that moves the moment the user tries. (The pane spans ` +
              `${Math.round(p.pane.left)}..${Math.round(p.pane.right)}, which is ` +
              `context, not the bound — see the header.)`,
          ).toBe(true);
          expect(
            p.toolbar.top >= p.viewport.top - 1 &&
              p.toolbar.bottom <= p.viewport.bottom + 1,
            `at ${probe.what} the toolbar spans ${Math.round(p.toolbar.top)}..` +
              `${Math.round(p.toolbar.bottom)} vertically while the window spans ` +
              `${Math.round(p.viewport.top)}..${Math.round(p.viewport.bottom)} — it did ` +
              `not flip to the other side of the selection when there was no room.`,
          ).toBe(true);

          // NO OVERLAP. The failure that survives to a release: the toolbar is
          // anchored to the selection, so the natural implementation puts it
          // directly above — which is where the text is on the first line.
          expect(
            overlaps(p.toolbar, sel),
            `at ${probe.what} the toolbar covers the selection it is acting on ` +
              `(toolbar ${Math.round(p.toolbar.top)}..${Math.round(p.toolbar.bottom)}, ` +
              `selection ${Math.round(sel.top)}..${Math.round(sel.bottom)}). ` +
              `Formatting then becomes a guess about what is underneath, and the ` +
              `user cannot move the toolbar without losing the selection.`,
          ).toBe(false);
        }
      },
    );
  });
});
