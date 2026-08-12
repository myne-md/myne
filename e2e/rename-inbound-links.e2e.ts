// Renaming a note rewrites `[[Old Title]]` inside every note that links to it
// (test-audit #17).
//
// ril1 — a note the user never opened has its BYTES rewritten by a rename
//        performed on a different note.
//
// WHY THIS SCENARIO EXISTS. A rename is not a one-note edit: it mutates an
// unbounded set of other notes, all-or-nothing, and the user did not open any
// of them. The only coverage was `tests/notes/renameInbound.test.ts`, whose own
// header says its I/O is faked — "no Tauri, no React". It composes the pure
// planner with an injected fake, which is the right shape for the ORDERING
// hazards it pins (flush-before-read, read-after-flush) and says nothing about
// whether the composed thing writes the right bytes to the right files through
// the real IPC. No scenario in `e2e/` created a second note containing
// `[[Target]]`, renamed Target, and read the linking note back.
//
// So the property under test is deliberately end-to-end and byte-level: after
// the rename, the LINKING note's stored text contains the new title and not the
// old one. A rewrite that
// silently skipped a note, or wrote a broken link, would leave the user with a
// dangling reference in a file they never touched — the failure mode that makes
// this an all-or-nothing batch in the first place. Whether the rewritten link
// still RESOLVES is `wikilink-deep-links.e2e.ts`'s property, established by
// following a link rather than by reading a marker; this scenario stops at the
// bytes and says so where the assertion would have gone.
//
// Vault-count precondition: 1 (weak KDF generator fixture — legal: unlock reads
// params from vault.meta). SYNC-13: titles and bodies here are in-source
// scenario constants, never credentials.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  pasteIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

/** Single lowercase-alnum tokens (the residue needle rule), so a title cannot
 *  collide with editor chrome or with the other note's words. */
const TARGET_OLD = "ril1targetalfa7k2m9qx4w";
const TARGET_NEW = "ril1targetbravo3h8z1cn5";
const LINKER = "ril1linkercharlie6b3k9wq";

/** Right-click a row and pick a context-menu item by its id. */
async function contextMenuPick(
  session: Session,
  target: { rightClick(): Promise<void> },
  itemId: string,
): Promise<void> {
  await target.rightClick();
  await (
    await session.waitForElement(
      testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
    )
  ).click();
}

/** Open a sidebar row by its title and return the editor's current text. */
async function openAndRead(session: Session, noteId: string): Promise<string> {
  await (
    await session.waitForElement(testIdSelector("notes.row", { "data-note-id": noteId }))
  ).click();
  return session.waitUntil(
    async () => {
      const text = await editorText(session);
      return text.length > 0 ? text : null;
    },
    { label: "the reopened note has a body", timeoutMs: 15_000 },
  );
}

/** The `data-note-id` of the row whose title matches, or null. */
async function rowIdByTitle(session: Session, title: string): Promise<string | null> {
  for (const row of await session.byTestIdAll("notes.row")) {
    if ((await row.textContent()).includes(title)) {
      return (await row.attribute("data-note-id")) ?? null;
    }
  }
  return null;
}

describeE2E("ril1 a rename rewrites the wikilinks inside notes the user never opened", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("rewrites [[Old]] to [[New]] in a closed linking note", async () => {
    let password = "";
    await scenario(
      "ril1-rename-inbound-links",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // The target of the link.
        await createNote(s, TARGET_OLD);

        // The note that links to it. Pasted, not typed: the payload is markdown
        // and `[[` auto-closes under the typing path, which would produce
        // `[[[[Target]]]]` and test something else entirely.
        await createNote(s, LINKER);
        await pasteIntoEditor(s, `sees [[${TARGET_OLD}]] here`);
        await waitForSaved(s);
        const linkerId = await rowIdByTitle(s, LINKER);
        expect(linkerId, "the linking note must be in the sidebar").not.toBeNull();

        // CLOSE it by opening the target instead — the point of the scenario is
        // that the rewrite reaches a note that is not on screen.
        const targetId = await rowIdByTitle(s, TARGET_OLD);
        expect(targetId, "the target note must be in the sidebar").not.toBeNull();
        await (
          await s.waitForElement(testIdSelector("notes.row", { "data-note-id": targetId! }))
        ).click();

        // Rename the target through the real row context menu.
        await contextMenuPick(
          s,
          await s.waitForElement(testIdSelector("notes.row", { "data-note-id": targetId! })),
          "rename",
        );
        await (await s.byTestId("notes.rename-input")).replaceText(`${TARGET_NEW}`);
        await s.waitForGone(testIdSelector("notes.rename-input"));
        await s.waitUntil(async () => ((await rowIdByTitle(s, TARGET_NEW)) ? true : null), {
          label: "the renamed title appears in the sidebar",
          timeoutMs: 15_000,
        });

        // The BYTES of the note nobody opened changed. Read it back through the
        // editor, which loads from disk — not from any cache this flow warmed.
        const linkerBody = await s.waitUntil(
          async () => {
            const text = await openAndRead(s, linkerId!);
            return text.includes(TARGET_NEW) ? text : null;
          },
          { label: "the closed note's link was rewritten to the new title", timeoutMs: 20_000 },
        );
        expect(
          linkerBody,
          "the OLD title must be gone — a rewrite that adds without removing leaves a dangling link",
        ).not.toContain(TARGET_OLD);

        // NOT asserted here: that the rewritten link still RESOLVES. There is no
        // resolution testid to read — `wikilink-deep-links.e2e.ts` establishes
        // resolution by clicking a link and asserting where it lands, and that
        // is where the property belongs. Asserting it here against a testid that
        // does not exist would be a check that passes because it finds nothing,
        // which is the exact failure this whole audit pass has been removing.
      },
    );
  });
});
