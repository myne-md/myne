// Editor scroll slack past the last line (#375).
//
//   ss1  A note long enough to scroll can be scrolled PAST its last line: with the
//        pane bottomed out, the last line sits well clear of the bottom edge
//        instead of flush against it.
//
// Verified as a discriminator, not assumed to be one: built with the extension
// removed, this scenario fails with `expected 36 to be greater than or equal to
// 120` — 36px being all the pre-fix layout leaves below the last line.
//
// What is NOT asserted here (and why):
//   - How much slack a viewport earns, and which element is treated as the
//     scroller, are pure functions unit-tested in tests/editor/scroll-slack.test.ts.
//     E2E pins the end-to-end effect on the production binary, not the arithmetic.
//   - "Clicking the slack lands the caret on the last line" needs a real pointer
//     click at measured coordinates inside CodeMirror's content padding; it is a
//     manual check on the release runbook rather than a driver scenario.
//
// The pane scroller carries no testid (it is a layout div in PaneView), so it is
// resolved the way production resolves it: the nearest scrolling ancestor of
// `.cm-content`. Note bodies are in-source scenario content, never credentials
// (SYNC-13).
//
// Vault-count precondition: 1 (weak KDF generator fixture — legal: unlock reads
// params from vault.meta).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import { type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

// Enough lines that the note scrolls in any window this suite runs in. The tail
// marker is what tells the measurement below that CodeMirror has actually
// rendered the END of the document — see `measureTail`.
const TAIL_MARKER = "ssend";
/** First-line marker proving the body reached the buffer after a remount.
 *  Visible at scrollTop=0; the tail is not (virtualised viewport). */
const HEAD_MARKER = "sstop";
const BODY = [
  "# Long note sstop",
  ...Array.from({ length: 200 }, (_, i) => `line ${i}`),
  `last line ${TAIL_MARKER}`,
].join("\n");

// The smallest gap that proves slack exists. Measured on the pre-fix binary the
// gap settles at 36px (32px of pane-scroller bottom padding + 4px of content
// padding); the fix reserves 60% of the pane height, capped at 480 — ~430px on
// this harness. 120 sits far from both, so neither a layout tweak nor a window
// size makes this ambiguous.
const MIN_GAP_PX = 120;

interface TailMeasure {
  /** px from the bottom of the last rendered line to the scroller's bottom edge. */
  readonly gap: number;
  /** Text of the last RENDERED line — not necessarily the document's last. */
  readonly tail: string;
}

/** Production `resolveScrollHost` walk: start OUTSIDE `.cm-editor`, first
 *  scrolling `overflow-y` that can actually move. Binds `found` (element|null);
 *  must not `return` a DOM node (WebDriver would hand the caller an object).
 *  Matches `editor/src/scroll-slack.ts` (not `.cm-scroller` — the editor grows
 *  inside an outer bounded scroller on every Myne client). */
const RESOLVE_SCROLLABLE_JS =
  "var found = null;" +
  "var content = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
  "if (content) {" +
  "  var editor = content.closest('.cm-editor');" +
  "  var el = editor ? editor.parentElement : content.parentElement;" +
  "  while (el && el !== el.ownerDocument.documentElement) {" +
  "    var oy = getComputedStyle(el).overflowY;" +
  "    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay')" +
  "        && el.scrollHeight > el.clientHeight + 1) { found = el; break; }" +
  "    el = el.parentElement;" +
  "  }" +
  "}";

/** DOM truth when measureTail returns null: ancestor chain + buffer size.
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

/**
 * Resolve the scrolling ancestor of the editor content the way production does,
 * scroll it to the very bottom, and measure the gap below the last rendered line.
 * `null` while the layout has nothing to say yet (no content, nothing scrolls, no
 * lines).
 *
 * The `tail` field is load-bearing. CodeMirror's viewport is virtualised, so for
 * the first few hundred ms after the note opens the last RENDERED line is one from
 * the middle of the document, sitting a whole scroll-height above the fold — which
 * reads as a huge gap. An earlier version of this scenario asserted on the first
 * measurement and so passed against a build with the fix REMOVED. The caller waits
 * for this to carry the document's real tail before believing the number.
 */
async function measureTail(s: Session): Promise<TailMeasure | null> {
  const raw = await s.execute<string>(
    RESOLVE_SCROLLABLE_JS +
      "if (!found || !content) return '';" +
      "found.scrollTop = found.scrollHeight;" +
      "found.dispatchEvent(new Event('scroll'));" +
      "var lines = content.querySelectorAll('.cm-line');" +
      "if (lines.length === 0) return '';" +
      "var last = lines[lines.length - 1];" +
      "return JSON.stringify({" +
      "  gap: Math.round(found.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom)," +
      "  tail: last.textContent || ''" +
      "});",
  );
  return raw === "" ? null : (JSON.parse(raw) as TailMeasure);
}

/** Scroll to the bottom and wait until the DOCUMENT's last line is the last one
 *  rendered, then return that settled measurement. */
async function settledTail(s: Session): Promise<TailMeasure> {
  let last = "";
  return s.waitUntil(
    async () => {
      const m = await measureTail(s);
      if (m !== null && m.tail.includes(TAIL_MARKER)) return m;
      last = m === null ? await scrollDiag(s) : `tail=${m.tail.slice(0, 40)} gap=${m.gap}`;
      return null;
    },
    {
      label: () => `the document's last line is rendered at max scroll (last: ${last})`,
      timeoutMs: 20_000,
    },
  );
}

describeE2E("ss1 the last line can be scrolled clear of the bottom edge (#375)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a bottomed-out long note leaves slack below its last line", async () => {
    let password = "";
    await scenario(
      "ss1-scroll-slack",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // A 200-line body via page-seat IPC rather than typeIntoEditor: the driver
        // drops keystrokes over that many chars. Same pattern as wd1.
        await createNote(s, "Long");
        const row = await s.waitForElement(
          '[data-testid="notes.row"][aria-selected="true"]',
        );
        const noteId = (await row.attribute("data-note-id")) ?? "";
        // `createNote` waits for the title badge, but a latest-wins follow-up can
        // still be in flight; `note_update` under it is rejected or overwritten
        // and the post-refresh tail never appears.
        await s.waitUntil(
          async () => {
            const t = (await (await s.byTestId("editor.save-status")).textContent()) ?? "";
            return t.includes("Editing") || t.includes("Saving") ? null : true;
          },
          { label: "autosave idle before out-of-band write", timeoutMs: 15_000 },
        );
        const cur = await pageSeatInvoke(s, "plugin:notes|note_read", { noteId }, IPC_TIMEOUT);
        const base = typeof cur.ok === "string" ? cur.ok : "";
        const up = await pageSeatInvoke(
          s,
          "plugin:notes|note_update",
          { noteId, plaintext: `${base}\n${BODY}` },
          IPC_TIMEOUT,
        );
        expect(up.err, "note_update should succeed").toBeUndefined();
        // Prove the bytes are on disk BEFORE the reload. A title autosave that
        // lands after this write would strip them; polling here catches that
        // while a post-refresh settledTail would just time out on a missing tail.
        await s.waitUntil(
          async () => {
            const again = await pageSeatInvoke(s, "plugin:notes|note_read", { noteId }, IPC_TIMEOUT);
            return typeof again.ok === "string" && again.ok.includes(TAIL_MARKER) ? true : null;
          },
          { label: "disk body carries the tail marker", timeoutMs: 15_000 },
        );

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
          { label: "the long note is open", timeoutMs: 20_000 },
        );

        // Disk is not the pane. Refresh remounts; until the load effect finishes
        // the disk read the buffer is still empty, every measure returns null,
        // and `settledTail` burns its whole budget on an editor that never
        // received the body. Poll for the HEAD marker first: CodeMirror
        // virtualises, so at scrollTop=0 the document's last line is not in
        // `.cm-content` textContent until something scrolls it into the
        // viewport — waiting on TAIL_MARKER here would time out on a fully
        // loaded note. `settledTail` then scrolls and waits for the real tail.
        await s.waitUntil(
          async () => {
            const body = await s.execute<string>(
              "var c = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
                "return c ? (c.textContent || '') : '';",
            );
            return body.includes(HEAD_MARKER) ? true : null;
          },
          { label: "editor buffer carries the head marker after refresh", timeoutMs: 30_000 },
        );

        // Settle first, then measure AGAIN and assert on that second reading: the
        // first one is taken the instant the tail appears, and only a value that
        // survives a re-measure is the layout's answer rather than a frame of it.
        await settledTail(s);
        const settled = await settledTail(s);
        expect(
          settled.gap,
          `slack below "${settled.tail}" at max scroll`,
        ).toBeGreaterThanOrEqual(MIN_GAP_PX);
      },
    );
  });
});
