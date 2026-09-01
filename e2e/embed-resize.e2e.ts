// er1: drag-to-resize on a block image embed (myne-md/myne#604).
//
// The third of the three symptoms #604 reported was "there is no way to drag it
// smaller". The handles ship with their `data-testid` pass, and this is the
// scenario half of that obligation: a real vault, a real imported PNG that
// really decodes in WebKit, the real widget, and a drag that has to land a `w=`
// segment in the note's own bytes.
//
// # The drag is dispatched, not performed by the driver
//
// `Session` exposes no W3C Actions endpoint, so there is no native pointer here.
// The drag is three synthetic `pointer*` events from page script. That is not
// the same as a hand on a trackpad and this scenario does not claim it is: what
// it does exercise is every layer below the OS, which is where the behaviour
// lives. `appendResizeHandles` listens for `pointerdown` on the handle and for
// `pointermove` / `pointerup` on `window`, so synthetic events at real
// coordinates run the real state machine, the real clamp, and the real
// `updateEmbedLayout` write through the real capability ACL.
//
// What it therefore cannot catch: a handle that is unhittable because something
// paints over it, and the `:hover` reveal. Those are the pointer facts, and
// `e2e/CLAUDE.md`'s own rule about not claiming more than the inputs prove is
// why they are named here rather than glossed.
//
// # Why the corner grip rather than the edge bar
//
// The corner is the one that writes BOTH dimensions, so it is the one where a
// regression can be silent in half: an edge-bar drag that lost its height arm
// would look identical. The edge bar's width path is the same code.
//
// Vault-count precondition: 1 (weak KDF). The fixture image is in-source
// scenario content, not credentials (SYNC-13).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  pageSeatInvoke,
  seedEmbedIntoNote,
  unlockToEditor,
  waitForInlineImage,
} from "./support/flows";
import { REPO_ROOT } from "./support/session";
import type { Session } from "./support/webdriver";

const FILENAME = "diagram.png";
const IPC_TIMEOUT = 60_000;

function fixturePng(): number[] {
  return Array.from(
    readFileSync(join(REPO_ROOT, "core", "tests", "fixtures", "ocr-sample.png")),
  );
}

async function importImage(s: Session): Promise<string> {
  const r = await pageSeatInvoke(
    s,
    "plugin:attachments|attachment_import",
    { source: { kind: "bytes", bytes: fixturePng(), filename: FILENAME } },
    IPC_TIMEOUT,
  );
  expect(r.err, "attachment_import should accept the .png file").toBeUndefined();
  return (r.ok as { id: string }).id;
}

/** The note the scenario is editing, read back from disk rather than from the
 *  editor: the point of the drag is that it wrote BYTES, and the buffer would
 *  show the same thing whether or not they were persisted. */
async function noteBody(s: Session, noteId: string): Promise<string> {
  const r = await pageSeatInvoke(s, "plugin:notes|note_read", { noteId }, IPC_TIMEOUT);
  return typeof r.ok === "string" ? r.ok : "";
}

async function activeNoteRowId(s: Session): Promise<string> {
  const row = await s.waitForElement('[data-testid="notes.row"][aria-current="true"]');
  return (await row.attribute("data-note-id")) ?? "";
}

/** Whether the embed is drawn as a BLOCK: its frame is outside every `.cm-line`.
 *  The handles exist only on that form, so this is the precondition rather than
 *  a separate assertion. */
async function isBlockEmbed(s: Session): Promise<boolean> {
  return s.execute<boolean>(
    `const i = document.querySelector('[data-testid="attachment-image"]');
     const f = i && i.closest('.cm-attachment-frame');
     return !!f && f.closest('.cm-line') === null;`,
  );
}

/** Drag the corner grip by `dx`,`dy` and report the width the image ended at.
 *  Returns -1 when the grip is not in the document. */
async function dragCorner(s: Session, dx: number, dy: number): Promise<number> {
  return s.execute<number>(
    `const h = document.querySelector('[data-testid="attachment-image.resize-se"]');
     if (h === null) return -1;
     const r = h.getBoundingClientRect();
     const x = Math.round(r.left + r.width / 2);
     const y = Math.round(r.top + r.height / 2);
     const at = (cx, cy) => ({ bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 });
     h.dispatchEvent(new PointerEvent('pointerdown', at(x, y)));
     window.dispatchEvent(new PointerEvent('pointermove', at(x + ${dx}, y + ${dy})));
     window.dispatchEvent(new PointerEvent('pointerup', at(x + ${dx}, y + ${dy})));
     const img = document.querySelector('[data-testid="attachment-image"]');
     return img ? Math.round(img.getBoundingClientRect().width) : -1;`,
  );
}

describeE2E("er1 drag-to-resize writes a width into the note (myne#604)", () => {
  it("drags the corner grip and lands `w=` in the note's own bytes, once", async () => {
    let password = "";
    await scenario(
      "er1-embed-resize",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        const attachmentId = await importImage(s);
        await createNote(s, "Diagram note");
        // On its own line, which is the form the renderer draws as a block and
        // the only form that carries handles.
        await seedEmbedIntoNote(s, `![[att:${attachmentId}|${FILENAME}]]`);
        await waitForInlineImage(s, attachmentId);

        const noteId = await activeNoteRowId(s);
        expect(noteId, "the active note row should carry an id").not.toBe("");

        // Precondition, asserted rather than assumed: an embed alone on its line
        // is a block, and only a block has handles.
        expect(await isBlockEmbed(s), "the embed should be drawn as a block").toBe(true);

        const before = await noteBody(s, noteId);
        expect(before, "the seeded embed carries no width yet").not.toMatch(/\|w=\d+/);

        const startWidth = await s.execute<number>(
          `const i = document.querySelector('[data-testid="attachment-image"]');
           return i ? Math.round(i.getBoundingClientRect().width) : -1;`,
        );
        expect(startWidth, "the image should be laid out").toBeGreaterThan(0);

        // Drag the corner inward. Negative dx narrows; dy is what the corner
        // adds over the edge bar.
        const after = await dragCorner(s, -80, -40);
        expect(after, "the corner grip should exist on a block embed").toBeGreaterThan(0);
        expect(after, "the drag should have narrowed the image").toBeLessThan(startWidth);

        // The release wrote the document. Both segments, because the corner is
        // the two-dimension gesture and a height arm that silently did nothing
        // would look identical from the width alone.
        await s.waitUntil(
          async () => (/\|w=\d+/.test(await noteBody(s, noteId)) ? true : null),
          { label: "the drag writes a width into the note", timeoutMs: 20_000 },
        );
        const body = await noteBody(s, noteId);
        expect(body, "the corner grip writes a height too").toMatch(/h=\d+/);

        // ONE write, not one per frame: the drag moves CSS and touches the
        // document only on release, which is what makes a drag one undo step.
        expect(body.match(/\|w=\d+/g) ?? []).toHaveLength(1);

        // And the note is otherwise untouched: the embed's own span is the only
        // thing that changed.
        expect(body.split("\n").length).toBe(before.split("\n").length);
      },
    );
  });
});
