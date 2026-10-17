// wc1: clicking a rendered wikilink chip opens the note (myne-md/myne#601).
//
// The reported failure was that a single click on a backlink turned the row into
// raw markup instead of opening anything, while a double click worked. The cause
// is only observable with layout: the press moves the selection onto the link,
// which lifts the chip back to its `[[…]]` source, so the pressed element is
// REMOVED from the document before the button comes up, and the browser
// synthesises no `click` at all. Measured in Chromium during the fix: `mousedown`
// on `.cm-wikilink-chip`, `mouseup` on `.cm-line`, no `click` anywhere, not even
// on `document`.
//
// `tests/editor/wikilink-chip-anchor-click.test.ts` pins the press-and-release
// contract under jsdom, which reproduces the removal but runs none of
// CodeMirror's own mouse handling. This is the layer that does.
//
// # What is NOT here, and why
//
// The other half of the rule is that a press on the RAW `[[…]]` source does NOT
// navigate: that form exists so the target can be edited, and taking the press
// would leave no way to put the caret inside a link with the mouse. It is not
// asserted here because making a link raw needs the caret on its own line, and
// the deterministic way to seed a note (append through `note_update`, below)
// puts the link at the end while the caret is at the start. Driving the caret
// there first means pressing the line, which is the gesture under test. It is
// pinned in `tests/editor/wikilink-chip-anchor-click.test.ts`, which places a
// selection directly.
//
// # The press is dispatched, not performed by the driver
//
// `Session` exposes no W3C Actions endpoint, so there is no native pointer here.
// These are synthetic `mousedown`/`mouseup` at real measured coordinates, which
// run the production handler and CodeMirror's own selection handling. What it
// therefore cannot catch is a chip that is unhittable because something paints
// over it.
//
// Note bodies and titles are in-source scenario content (SYNC-13).
// Vault-count precondition: 1 (weak KDF).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  activeNoteId,
  clickNoteRow,
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  pageSeatInvoke,
  selectedNoteId,
  unlockToEditor,
  writeNoteBody,
} from "./support/flows";
import { type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;
const TARGET_TITLE = "Target note";

/**
 * APPEND to a note, never replace it.
 *
 * `createNote` writes a title and frontmatter, and the body write takes the whole
 * plaintext, so passing a bare body drops both. That is not cosmetic here: the
 * note-set resolves `[[Target note]]` by TITLE, and a target whose frontmatter
 * has been deleted is a different note with a different name, so the link
 * resolves to nothing and no chip is ever built. Measured as "no chip, and no
 * raw `[[` either", which reads like a rendering failure and is a seeding one.
 * `seedEmbedIntoNote` reads the current body for the same reason.
 */
async function appendBody(s: Session, noteId: string, body: string): Promise<void> {
  const cur = await pageSeatInvoke(s, "plugin:notes|note_read", { noteId }, IPC_TIMEOUT);
  const base = typeof cur.ok === "string" ? cur.ok : "";
  const r = await writeNoteBody(s, noteId, `${base}\n${body}`, IPC_TIMEOUT);
  expect(r.err, "the body write should succeed").toBeUndefined();
}

/**
 * Reload so the panes read the bodies `writeBody` just wrote.
 *
 * `note_update` writes OUTSIDE the pane's autosave loop, and a pane re-reads
 * only when its reload nonce moves, which nothing here bumps. The source note is
 * the one `createNote` left open, so clicking its row re-selects a note that is
 * already open and reads nothing: the editor kept its pre-write buffer and the
 * link text was never in the DOM at all. Measured as `pressRawLink` finding no
 * line containing `[[`, which reads like a rendering problem and is not.
 * `seedEmbedIntoNote` solves the same thing the same way.
 */
async function reloadIntoEditor(s: Session): Promise<void> {
  await s.refresh();
  await s.byTestId("editor.root", { timeoutMs: 30_000 });
  // The reload brings the fresh-vault importer overlay back, and it covers the
  // editor, so every click after it would land on the overlay.
  await dismissImporterOfferIfPresent(s);
}

/** Press and release on the single rendered chip, at its own centre. Returns
 *  false when no chip is rendered. */
async function pressChip(s: Session): Promise<boolean> {
  return s.execute<boolean>(
    "var chip = document.querySelector('.cm-wikilink-chip');" +
      "if (!chip) return false;" +
      "var r = chip.getBoundingClientRect();" +
      "var x = Math.round(r.left + r.width / 2);" +
      "var y = Math.round(r.top + r.height / 2);" +
      "var at = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };" +
      "chip.dispatchEvent(new MouseEvent('mousedown', at));" +
      // The press reveals the raw source, so the release lands on whatever is
      // under the pointer now, exactly as the browser delivers it.
      "var now = document.elementFromPoint(x, y) || chip;" +
      "now.dispatchEvent(new MouseEvent('mouseup', at));" +
      "return true;",
  );
}

async function chipRendered(s: Session): Promise<boolean> {
  return s.execute<boolean>("return !!document.querySelector('.cm-wikilink-chip');");
}

describeE2E("wc1 clicking a wikilink chip opens the target (myne#601)", () => {
  it("opens the linked note on a single press of the rendered chip", async () => {
    let password = "";
    await scenario(
      "wc1-wikilink-chip-click",
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
        // by counting rows: a seeded vault can bring notes of its own.
        await createNote(s, TARGET_TITLE);
        const targetId = await selectedNoteId(s);
        await createNote(s, "Source note");
        const sourceId = await selectedNoteId(s);
        expect(targetId).not.toBe("");
        expect(sourceId).not.toBe(targetId);

        await appendBody(s, targetId, `# ${TARGET_TITLE}\n\nthe destination.`);
        await appendBody(s, sourceId, `# Source note\n\nsee [[${TARGET_TITLE}]] for more.`);
        await reloadIntoEditor(s);

        await clickNoteRow(s, sourceId);
        // The chip renders only once the note-set has resolved the title, so
        // wait for the chip itself rather than for the note.
        await s.waitUntil(async () => ((await chipRendered(s)) ? true : null), {
          label: "the wikilink renders as a chip",
          timeoutMs: 20_000,
        });

        expect(await pressChip(s), "a chip should be on screen to press").toBe(true);

        await s.waitUntil(
          async () => ((await activeNoteId(s)) === targetId ? true : null),
          { label: "the press opens the linked note", timeoutMs: 20_000 },
        );
        expect(await activeNoteId(s)).toBe(targetId);
      },
    );
  });

});
