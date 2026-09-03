// esp1 — the typography specimen shows what a note will actually look like.
// myne-md/myne#555, the `settings.panel.editor` bullet:
//
//   > assert the specimen's computed font-family, size, weight and line-height
//   > are identical to the live editor's for the same setting, on whatever font
//   > set the host has. That catches a specimen that lies about the note
//   > regardless of which fallback resolved.
//
// # What the specimen is promising
//
// Settings → Editor shows a live sample beside the typography controls, and
// `EditorPanel.tsx` states the contract in its own comment: the sample reads
// the SAME `--editor-*` custom properties the real editor reads, "so the
// specimen cannot show something a note will not". A user picks their reading
// size by looking at it and never opens a note to check.
//
// So the failure is a specimen that drifts from the editor — a hardcoded
// `fontSize` that stops tracking the token, a stacking context where one of the
// two resolves the custom property against a different element, a rule that
// applies to `.cm-line` and not to the sample or the other way round. Nothing
// errors. The user picks a size that looks right and gets a different one.
//
// # Why the assertion is EQUALITY rather than a pinned value
//
// Which font actually resolves depends on the host's font set, and the
// container's is not a developer's Mac. Asserting "the specimen renders Inter
// at 16px" would be a fact about the container. Asserting "the specimen and the
// editor resolve to the SAME thing" is the property the promise is made of, and
// it holds on every machine, which is what the bullet's closing clause means by
// "regardless of which fallback resolved".
//
// # The setting is CHANGED, because agreeing once is cheap
//
// Two elements can agree at the default and diverge everywhere else — a
// specimen with the default baked in as a literal passes a single-reading test
// perfectly. So the size is moved to a non-default preset and both are read
// again: they have to agree, and the value has to have MOVED. The second half
// is what stops a specimen that agrees by both being frozen.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  openSettings,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import type { Session } from "./support/webdriver";

/** The four typographic facts the bullet names, as the engine computed them. */
type Typography = {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
};

/** Read them off the first element matching `selector`. */
async function typographyOf(s: Session, selector: string): Promise<Typography | null> {
  return await s.execute<Typography | null>(
    "var el = document.querySelector(arguments[0]);" +
      "if (!el) return null;" +
      "var cs = getComputedStyle(el);" +
      "return {" +
      "  fontFamily: cs.fontFamily," +
      "  fontSize: cs.fontSize," +
      "  fontWeight: cs.fontWeight," +
      "  lineHeight: cs.lineHeight" +
      "};",
    [selector],
  );
}

// The live note text, and the specimen's body paragraph. The specimen's
// paragraph carries no testid of its own, so it is reached through the
// preview's — adding one would be fine, but the structural query is stable and
// this scenario is about computed style rather than about the markup.
const EDITOR_LINE = '[data-testid="editor.content"] .cm-line';
const SPECIMEN_BODY = '[data-testid="settings.editor-preview"] p';

describeE2E("esp1 the typography specimen matches the editor (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("agrees on family, size, weight and line-height, and keeps agreeing after a change", async () => {
    let seeded: SeededVault;
    await scenario(
      "esp1-editor-specimen-parity",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // A note with a body, so `.cm-line` exists and is the real thing rather
        // than an empty document's placeholder line.
        await createNote(s, "Tipografi ornegi");
        await typeIntoEditor(s, "Bu satir gercek bir notun govdesi.");
        await waitForSaved(s);

        const before = await typographyOf(s, EDITOR_LINE);
        expect(before, "no editor line to measure").not.toBeNull();

        await openSettings(s, "editor");
        await s.byTestId("settings.editor-preview");

        const specimen = await typographyOf(s, SPECIMEN_BODY);
        expect(specimen, "the specimen rendered no body paragraph to measure").not.toBeNull();

        // The editor is behind the modal but still mounted, so it can be
        // re-read here rather than trusting the value taken before Settings
        // opened — a layout the modal changed would otherwise go unnoticed.
        const live = await typographyOf(s, EDITOR_LINE);
        expect(live, "the editor unmounted while Settings was open").not.toBeNull();

        for (const key of ["fontFamily", "fontSize", "fontWeight", "lineHeight"] as const) {
          expect(
            specimen![key],
            `the Settings specimen resolves ${key} to "${specimen![key]}" while a real ` +
              `note resolves it to "${live![key]}". The specimen is what a user reads ` +
              `to choose their reading size — one that disagrees with the note is ` +
              `showing them a document they will never see.`,
          ).toBe(live![key]);
        }

        // Move the setting off its default. `md` is the default, so `xl` is a
        // value neither element can be frozen at.
        await (await s.byTestId("settings.editor-text-size-xl")).click();
        await s.waitUntil(
          async () => {
            const now = await typographyOf(s, SPECIMEN_BODY);
            return now && now.fontSize !== specimen!.fontSize ? now : null;
          },
          { label: "the specimen followed the text-size change", timeoutMs: 10_000 },
        );

        const specimenAfter = await typographyOf(s, SPECIMEN_BODY);
        const liveAfter = await typographyOf(s, EDITOR_LINE);

        // It moved…
        expect(
          specimenAfter!.fontSize,
          "the specimen's size did not change when the size setting did, so it is " +
            "showing a fixed sample rather than a preview",
        ).not.toBe(specimen!.fontSize);
        expect(
          liveAfter!.fontSize,
          "the note's size did not change when the size setting did — the setting " +
            "reaches the specimen and not the editor, which is the disagreement " +
            "inverted",
        ).not.toBe(live!.fontSize);

        // …and they still agree, on every one of the four.
        for (const key of ["fontFamily", "fontSize", "fontWeight", "lineHeight"] as const) {
          expect(
            specimenAfter![key],
            `after moving the text size to xl the specimen resolves ${key} to ` +
              `"${specimenAfter![key]}" and a real note resolves it to ` +
              `"${liveAfter![key]}". They agreed at the default and diverge once the ` +
              `setting moves, which is a specimen with the default baked in.`,
          ).toBe(liveAfter![key]);
        }
      },
    );
  });
});
