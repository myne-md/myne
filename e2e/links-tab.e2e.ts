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
