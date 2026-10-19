// Right-panel-tabs active-tab suite (single-active selection + Outline). The
// right panel shows exactly ONE active tab body at a time; switching tabs is a
// click, the choice persists per-vault in vault.prefs (`right_panel_active_tab`),
// and the Outline tab lists the open note's headings (clicking one scrolls the
// editor to it via the same anchor machinery a `[[#heading]]` chip uses):
//
//   rp3 — Backlinks is the default-active tab; clicking Outline makes it the
//         sole active tab and shows the note's headings; clicking a heading row
//         is a no-crash navigation; the active tab SURVIVES a lock → unlock
//         round-trip (disk-persisted, not transient).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  editorText,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

const CM_CONTENT = testIdSelector("editor.content") + " .cm-content";
// WebDriver's Enter key — `\n` is unreliable across drivers; U+E007 is the
// W3C "Enter" code point the harness uses elsewhere for newlines.
const ENTER = "\uE007";

/** Type a two-heading markdown doc into the editor. Avoids `typeIntoEditor`
 *  because its `landed` check looks for the literal payload (newlines + Enter)
 *  in `textContent`, which CM does not carry; here we lead with a probe char,
 *  press Enter so the headings land at line starts (valid ATX), and verify by
 *  the heading TEXT (newline-free, so it survives `textContent`). */
async function typeOutlineDoc(session: Session): Promise<void> {
  const cm = await session.waitForElement(CM_CONTENT);
  await cm.click();
  // Establish the keystroke pipeline with a sacrificial probe (it lands on
  // line 1; the headings follow on their own lines).
  await session.waitUntil(
    async () => {
      await cm.sendKeys("q");
      return (await editorText(session)).includes("q") || null;
    },
    { label: "keystroke pipeline established", timeoutMs: 10_000 },
  );
  await cm.sendKeys(`${ENTER}# OutlineAlphaHeadingZZ${ENTER}## OutlineBetaHeadingYY`);
  await session.waitUntil(
    async () => {
      const t = await editorText(session);
      return t.includes("OutlineAlphaHeadingZZ") && t.includes("OutlineBetaHeadingYY") ? true : null;
    },
    { label: "outline headings typed", timeoutMs: 10_000 },
  );
}

/** The id of the currently-active right-panel tab, or null if none. */
async function activeTabId(session: Session): Promise<string | null> {
  const els = await session.byTestIdAll("editor.right-panel-tab");
  for (const e of els) {
    if ((await e.attribute("data-active")) === "true") {
      return await e.attribute("data-panel-tab-id");
    }
  }
  return null;
}

/** Click the right-panel tab `tabId`. */
async function clickTab(session: Session, tabId: string): Promise<void> {
  await (
    await session.waitForElement(
      testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": tabId }),
    )
  ).click();
}

describeE2E("rp3 right-panel single-active tab + Outline (right-panel tabs)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("switches to the Outline tab (sole active), lists headings, and the active tab survives lock→unlock", async () => {
    let password = "";
    await scenario(
      "rp3-right-panel-active-tab",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "rp3notealfa7k2m9qx4w8e5rj0aa");

        // Two markdown headings (probe + Enter so each "#" starts a line).
        await typeOutlineDoc(s);
        await waitForSaved(s);

        // Default-active tab is Backlinks (the first canonical tab).
        await s.byTestId("editor.right-panel-tabs");
        expect(await activeTabId(s)).toBe("backlinks");

        // Switch to Outline → it becomes the SOLE active tab.
        await clickTab(s, "outline");
        await s.waitUntil(
          async () => ((await activeTabId(s)) === "outline" ? true : null),
          { label: "outline becomes the active tab" },
        );

        // Outline lists the open note's headings (≥ the two we typed — a note
        // title rendered as an H1 would add one more, which is fine).
        const rows = await s.waitUntil(
          async () => {
            const r = await s.byTestIdAll("editor.outline-row");
            return r.length >= 2 ? r : null;
          },
          { label: "outline shows the typed headings" },
        );
        const texts = await Promise.all(rows.map((r) => r.textContent()));
        expect(texts.join("\n")).toContain("OutlineAlphaHeadingZZ");
        expect(texts.join("\n")).toContain("OutlineBetaHeadingYY");

        // Clicking a heading row scrolls the editor to it (the wikilink-anchor
        // bridge) — assert it does not crash and the doc is intact afterwards.
        await rows[1].click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("OutlineBetaHeadingYY") ? true : null),
          { label: "heading click kept the document intact" },
        );

        // Persistence: lock → unlock mounts a fresh editor that reads
        // right_panel_active_tab from disk; Outline stays the active tab.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        await dismissImporterOfferIfPresent(s);
        await s.byTestId("editor.right-panel-tabs");
        await s.waitUntil(
          async () => ((await activeTabId(s)) === "outline" ? true : null),
          { label: "outline is still the active tab after lock→unlock" },
        );
      },
    );
  });
});
