// Back/forward note-navigation suite (MYND-260).
//
// Pins the browser-style history chrome that sits next to the left sidebar
// toggle: opening notes builds a per-pane trail, the back/forward buttons
// step through it (re-opening a note that has since left the tab strip), and
// each button greys out (disabled) when there is no history that direction.
// Navigation is proven by the note BODY that re-appears, round-tripped
// through the real AEAD read on each re-activation — not by tab labels.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { type Session } from "./support/webdriver";

/** Wait until the live editor document shows `marker` (post re-activation
 *  the active note's body re-loads async via noteRead). */
async function waitForBody(s: Session, marker: string): Promise<void> {
  await s.waitUntil(async () => (await editorText(s)).includes(marker) || null, {
    label: `editor body shows "${marker}"`,
    timeoutMs: 10_000,
  });
}

/** Assert a nav button's disabled state via its `data-disabled` mirror. */
async function expectNavDisabled(
  s: Session,
  dir: "back" | "forward",
  disabled: boolean,
): Promise<void> {
  await s.waitUntil(
    async () =>
      (await (await s.byTestId(`editor.nav-${dir}`)).attribute(
        "data-disabled",
      )) === (disabled ? "true" : "false") || null,
    { label: `nav-${dir} data-disabled=${disabled}` },
  );
}

describeE2E("nav1 back/forward steps through opened notes (MYND-260)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("steps back to earlier notes and forward again; ends greyed-out at edges", async () => {
    const M_ONE = "navigation marker bir";
    const M_TWO = "navigation marker iki";
    const M_THREE = "navigation marker uc";
    let password = "";
    await scenario(
      "nav1-back-forward",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Browse three notes in turn; each open reuses the active slot, so the
        // earlier notes leave the strip — back must re-open them.
        await createNote(s, "Note One");
        await typeIntoEditor(s, M_ONE);
        await waitForSaved(s);
        await createNote(s, "Note Two");
        await typeIntoEditor(s, M_TWO);
        await waitForSaved(s);
        await createNote(s, "Note Three");
        await typeIntoEditor(s, M_THREE);
        await waitForSaved(s);

        // At the newest note: forward is a dead end, back is live.
        await expectNavDisabled(s, "forward", true);
        await expectNavDisabled(s, "back", false);

        // Back → Two → One.
        await (await s.byTestId("editor.nav-back")).click();
        await waitForBody(s, M_TWO);
        await (await s.byTestId("editor.nav-back")).click();
        await waitForBody(s, M_ONE);

        // At the oldest note: back is now the dead end, forward is live.
        await expectNavDisabled(s, "back", true);
        await expectNavDisabled(s, "forward", false);

        // Forward → Two → Three re-walks the trail.
        await (await s.byTestId("editor.nav-forward")).click();
        await waitForBody(s, M_TWO);
        await (await s.byTestId("editor.nav-forward")).click();
        await waitForBody(s, M_THREE);
        await expectNavDisabled(s, "forward", true);
      },
    );
  });
});
