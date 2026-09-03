// Links tab suite (right-panel tabs, MYND-604 task 1) — the Backlinks tab
// grows a second, outgoing section and becomes a two-section Links tab. The
// tab ID stays `backlinks` (persisted in every user's tab order/hidden-tab
// list); only the label and body change.
//
//   lt1 — open a note with links in both directions: the incoming section
//     shows the note linking IN, the outgoing section shows the note it
//     links OUT to, each with the correct count; clicking a row in either
//     section navigates to that note (both existing `editor.backlink-row`
//     and new `editor.outgoing-link-row` testids resolve); a direction with
//     no links renders its explicit empty state, not a blank area; and a
//     right-panel tab reorder touching `backlinks` (the rp2 pattern) SURVIVES
//     a lock → unlock round-trip, proving the tab-order persistence contract
//     this change must not silently reset.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident). Note
// bodies/titles are in-source scenario content, not credentials (SYNC-13).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  ipcOk,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  editorText,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

/** The `data-note-id` of the currently-selected sidebar row (the note
 *  `createNote` just created and left selected) — mirrors search-palette.e2e.ts. */
async function selectedNoteId(s: Session): Promise<string> {
  const row = await s.waitForElement('[data-testid="notes.row"][aria-current="true"]');
  const id = await row.attribute("data-note-id");
  if (id === null || id === "") {
    throw new Error("selected notes.row carried no data-note-id");
  }
  return id;
}

/** Open a note via its sidebar row and wait for its body to land. */
async function openNoteById(s: Session, noteId: string, expectTail: string): Promise<void> {
  await (
    await s.waitForElement(testIdSelector("notes.row", { "data-note-id": noteId }))
  ).click();
  await s.waitUntil(async () => ((await editorText(s)).includes(expectTail) ? true : null), {
    label: `note ${noteId} opened`,
  });
}

/** Click the right-panel Links (`backlinks`-id) tab. */
async function clickLinksTab(s: Session): Promise<void> {
  await (
    await s.waitForElement(
      testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": "backlinks" }),
    )
  ).click();
}

/** The right-panel tab ids in current DOM (display) order — rp2's helper. */
async function tabIds(s: Session): Promise<string[]> {
  const els = await s.byTestIdAll("editor.right-panel-tab");
  const ids = await Promise.all(els.map((e) => e.attribute("data-panel-tab-id")));
  return ids.filter((id): id is string => id !== null);
}

/** Right-click a right-panel tab, then invoke "Move left"/"Move right" — rp2's helper. */
async function moveTab(s: Session, tabId: string, dir: "left" | "right"): Promise<void> {
  await (
    await s.waitForElement(testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": tabId }))
  ).rightClick();
  await (
    await s.waitForElement(
      testIdSelector("notes.context-menu-item", {
        "data-item-id": dir === "left" ? "move-left" : "move-right",
      }),
    )
  ).click();
}

describeE2E("lt1 links tab — incoming + outgoing sections (MYND-604)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("renders both directions with correct counts, opens either on click, shows an empty-state per direction, and the tab order survives lock→unlock", async () => {
    // C is the target of A's one outgoing link (and has none of its own —
    // the outgoing-empty-state note). B links to A (and has no incoming
    // links itself — the incoming-empty-state note).
    const C_TAIL = "ctaillt9k3m";
    const A_TAIL = "ataillt5x8p";
    const B_TAIL = "btaillt2w7q";
    let password = "";
    await scenario(
      "lt1-links-tab",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await createNote(s, "Note C");
        await typeIntoEditor(s, ` ${C_TAIL}`);
        await waitForSaved(s);
        const cId = await selectedNoteId(s);

        await createNote(s, "Note A");
        await typeIntoEditor(s, ` [[Note C]] ${A_TAIL}`);
        await waitForSaved(s);
        const aId = await selectedNoteId(s);

        await createNote(s, "Note B");
        await typeIntoEditor(s, ` [[Note A]] ${B_TAIL}`);
        await waitForSaved(s);
        const bId = await selectedNoteId(s);

        // Open A (creation leaves B selected) and activate the Links tab.
        await openNoteById(s, aId, A_TAIL);
        await clickLinksTab(s);

        // Incoming: exactly B. Outgoing: exactly C. Both sections render
        // with the right membership (== the right count, one row each).
        const incoming = await s.waitUntil(
          async () => {
            const rows = await s.byTestIdAll("editor.backlink-row");
            return rows.length === 1 ? rows : null;
          },
          { label: "A's incoming section shows exactly one row" },
        );
        expect(await incoming[0].attribute("data-source-id")).toBe(bId);

        const outgoing = await s.waitUntil(
          async () => {
            const rows = await s.byTestIdAll("editor.outgoing-link-row");
            return rows.length === 1 ? rows : null;
          },
          { label: "A's outgoing section shows exactly one row" },
        );
        expect(await outgoing[0].attribute("data-target-id")).toBe(cId);

        // Click the outgoing row → navigates to C.
        await outgoing[0].click();
        await s.waitUntil(async () => ((await editorText(s)).includes(C_TAIL) ? true : null), {
          label: "clicking the outgoing row navigated to Note C",
        });

        // C has no outgoing links of its own — the outgoing empty state
        // renders (not a blank area), while its incoming section (from A)
        // still shows one row.
        await clickLinksTab(s);
        await s.waitForGone(testIdSelector("editor.outgoing-link-row"));
        await s.byTestId("editor.backlink-row");

        // Back to A, then click the incoming row → navigates to B.
        await openNoteById(s, aId, A_TAIL);
        await clickLinksTab(s);
        const incomingAgain = await s.waitUntil(
          async () => {
            const rows = await s.byTestIdAll("editor.backlink-row");
            return rows.length === 1 ? rows : null;
          },
          { label: "A's incoming section is back to one row" },
        );
        await incomingAgain[0].click();
        await s.waitUntil(async () => ((await editorText(s)).includes(B_TAIL) ? true : null), {
          label: "clicking the incoming row navigated to Note B",
        });

        // B has no incoming links of its own — the incoming empty state
        // renders, while its outgoing section (to A) still shows one row.
        await clickLinksTab(s);
        await s.waitForGone(testIdSelector("editor.backlink-row"));
        await s.byTestId("editor.outgoing-link-row");

        // Tab-order persistence: the `backlinks` id is unchanged by this
        // feature, so the existing reorder → lock → unlock contract (rp2)
        // must still hold with the two-section body behind it.
        const before = await tabIds(s);
        expect(before.indexOf("backlinks")).toBeLessThan(before.indexOf("unlinked"));
        await moveTab(s, "backlinks", "right");
        await s.waitUntil(
          async () => {
            const o = await tabIds(s);
            return o.indexOf("backlinks") > o.indexOf("unlinked") ? true : null;
          },
          { label: "backlinks moves past unlinked after move-right" },
        );

        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        await dismissImporterOfferIfPresent(s);
        await s.byTestId("editor.right-panel-tabs");
        const after = await tabIds(s);
        expect(after.indexOf("backlinks")).toBeGreaterThan(after.indexOf("unlinked"));

        // The tab (and its two sections) still resolve post-restart.
        await openNoteById(s, aId, A_TAIL);
        await clickLinksTab(s);
        await s.byTestId("editor.backlink-row");
        await s.byTestId("editor.outgoing-link-row");
      },
    );
  });
});

// lt2 — myne-md/myne#555's `links.backlinks-and-mentions` bullet:
//
//   > `MENTION_DF_MIN_CORPUS` is 20, not 2000, so ~25 seeded notes engage the
//   > df ceiling; `passesMentionFloor` is pure and already unit-tested, and
//   > settle time is a measured wait.
//
// # What was actually missing
//
// The pure half IS covered — `tests/notes/unlinkedMentions.test.ts` pins the
// word-boundary rule, the df ceiling, the ≤2-character suppression and the
// corpus minimum, boundary included. What nothing covered is the surface: on a
// real vault, does the section reach a settled answer, and is that answer the
// filtered one rather than every note containing the word?
//
// It could not be covered, because `UnlinkedMentionsSection.tsx` carried **no
// testid at all** — the whole surface was invisible to this lane. The testid
// pass landed with this scenario (`src/CLAUDE.md`: production code may gain
// `data-testid` / `data-*` observability attributes, and a flow without them is
// invisible to E2E).
//
// # Why the corpus size is the point
//
// Below `MENTION_DF_MIN_CORPUS` the df clause is SKIPPED entirely, so a small
// vault is not blinded by a word that happens to be common in it. That means a
// scenario seeding three notes proves nothing about the ceiling: it exercises
// the small-corpus arm. Twenty-five notes cross the line, so the suppression is
// live and its effect is observable.
//
// # What this scenario can and cannot reach
//
// Measured, by injecting each layer's defect and watching what happened:
//
//  * **The floor is reachable.** Making `passesMentionFloor` refuse empties the
//    section, and the row-count assertion below names it.
//  * **The word-boundary verify is NOT reachable from here**, and that is a
//    fact about the architecture rather than a gap to paper over. Deleting
//    `foldedTitleMatches` from `verifyMentionCandidates` left this scenario
//    green, because the BM25 candidate recall has already narrowed the set to
//    notes carrying the title as a token — the verify is a second filter with
//    nothing left to remove on a corpus like this one. A decoy note carrying
//    the title only as a substring would not help either: a different token is
//    a different token, so recall never returns it.
//
//    That layer stays where it is already covered, in
//    `tests/notes/unlinkedMentions.test.ts` ("does NOT match a substring —
//    word boundary ('Index' ⊄ 'reindex')"), which drives the matcher directly
//    and does not have a recall stage in front of it.
//
// # `data-busy` is what makes the settle honest
//
// "No mentions" and "still searching" render as different sentences and would
// otherwise both read as "no rows". A wait keyed on the row count alone can
// therefore pass the instant the tab opens, before the search has run — the
// classic vacuous green. The wait below is keyed on `data-busy` first.
describeE2E("lt2 unlinked mentions settle, and the df ceiling engages (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("reaches a settled answer on a corpus past MENTION_DF_MIN_CORPUS", async () => {
    // A distinctive title, and a word common enough across the corpus that the
    // df ceiling has something to suppress.
    const RARE_TITLE = "Zephyrion";
    const COMMON = "meeting";
    let password = "";
    await scenario(
      "lt2-unlinked-mentions-corpus",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // The corpus. `passesMentionFloor` takes the note COUNT as its corpus
        // measure, so the filler notes need no bodies at all — creating them is
        // enough to cross MENTION_DF_MIN_CORPUS. That matters for more than
        // tidiness: typing and saving twenty-two bodies took this scenario past
        // its own 180 s budget on the first run, and none of it was doing any
        // work the assertion depends on.
        for (let i = 0; i < 21; i += 1) {
          await createNote(s, `Filler ${i}`);
        }
        // The three that actually mention the target's title, as plain text.
        for (let i = 0; i < 3; i += 1) {
          await createNote(s, `Mentions ${i}`);
          await typeIntoEditor(s, ` a note about ${RARE_TITLE} and the ${COMMON}`);
          await waitForSaved(s);
        }

        // The note the section is ABOUT: its title is the rare word, so the
        // three notes above mention it without linking it.
        await createNote(s, RARE_TITLE);
        await typeIntoEditor(s, " the target");
        await waitForSaved(s);
        const targetId = await selectedNoteId(s);

        await openNoteById(s, targetId, "the target");

        // The unlinked mentions are their OWN right-panel tab (`unlinked`), not
        // a section of the backlinks tab — `clickLinksTab` opens the wrong one
        // and the section never mounts. rp2 already names both ids.
        await (
          await s.waitForElement(
            testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": "unlinked" }),
          )
        ).click();

        // Settle on `data-busy`, not on the row count: an empty list and an
        // unfinished search are the same DOM by row count, so a count-keyed
        // wait would pass before the search ran.
        const section = await s.waitForElement(
          testIdSelector("editor.unlinked-mentions"),
          { timeoutMs: 20_000 },
        );
        await s.waitUntil(
          async () => ((await section.attribute("data-busy")) === "false" ? true : null),
          { label: "the unlinked-mentions search settled", timeoutMs: 30_000 },
        );

        // The corpus really is past the minimum, so the df clause is live
        // rather than skipped.
        //
        // Counted through `note_list` rather than by counting `notes.row`
        // elements, and that is a correction rather than a preference: the
        // sidebar is VIRTUALISED, so a first draft counting rendered rows saw
        // 14 of 25 and failed a scenario whose seeding was fine. A rendered-row
        // count answers "how many rows fit on screen", which is not a fact
        // about the vault.
        const ids = (await ipcOk(s, "plugin:notes|note_list")) as string[];
        expect(
          ids.length,
          `the vault holds ${ids.length} notes; below MENTION_DF_MIN_CORPUS ` +
            `(20) the df clause is skipped entirely and this scenario would be ` +
            `exercising the small-vault arm instead`,
        ).toBeGreaterThanOrEqual(20);

        // The answer is the FILTERED one. Three notes mention the rare title;
        // twenty-two more carry only the common word and must not appear.
        const rows = await s.byTestIdAll("editor.unlinked-mention-row");
        expect(
          rows.length,
          `the section listed ${rows.length} mentions. Three notes mention the ` +
            `title; the other twenty-two share only a high-df word, so listing ` +
            `them would mean the ceiling never engaged.`,
        ).toBe(3);
        expect(await section.attribute("data-count")).toBe("3");

        // Every listed row is one of the three, identified by note id rather
        // than by title text.
        for (const row of rows) {
          const id = await row.attribute("data-note-id");
          expect(id, "a mention row carries no note id").toBeTruthy();
          expect(id).not.toBe(targetId);
        }
      },
    );
  });
});
