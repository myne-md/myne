// Vim keyboard mode suite (vim-keyboard-mode, MYND-313). The editor gains an
// optional modal layer — normal / insert / visual — behind a Settings → Editor
// toggle that is OFF by default. This pins the user-facing contract through the
// REAL app, which is where the unit tests cannot reach: the pref round-trip, the
// engine's lazy load, the mode surfacing, and the lock boundary.
//
//   vm1 — the toggle turns the editor modal and back again: with vim OFF typing
//         inserts text (today's behaviour, unchanged), with vim ON the same keys
//         are commands and the bottom bar shows the mode. The choice SURVIVES a
//         lock → unlock round-trip (it is disk-persisted in vault.prefs), and
//         turning it off restores the plain editor with no mode indicator left.
//
//   vm2 — Escape ordering, the part users feel: from insert mode a single Escape
//         returns to normal (it does NOT also collapse anything), and a second
//         Escape is inert. Guards the "one Escape, one job" design.
//
//   vm3 — the lock boundary: text yanked before a lock cannot be pasted after
//         one. The registers live in the engine's module-global state, so this
//         is the scenario that would leak note content across a lock without an
//         explicit reset.
//
//   vm4 — hiding is not disabling (#181): the toggle now lives behind Developer
//         mode, and turning that mode back off takes the CONTROL away while the
//         keymap keeps running. The inverse — a visibility switch that silently
//         reverts the editor — is the surprise the issue rejected by name, and
//         nothing but a real keystroke after the control is gone can prove it
//         did not happen.
//
// Mode is read from `data-vim-mode` on the editor root — the same attribute the
// bottom-bar indicator renders from, so asserting it also proves the indicator's
// data source is live.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  disableDeveloperModeInSettings,
  dismissImporterOffer,
  enableDeveloperMode,
  lockAndReunlock,
  openSettings,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { type Session } from "./support/webdriver";

/** WebDriver's Escape key, U+E00C. Named rather than pasted inline: the literal
 *  is INVISIBLE in source, so an inline copy is silently lost by any edit that
 *  reflows the line — a trap this repo has hit before with the Enter codepoint. */
const ESCAPE_KEY = "\uE00C";

/** The editor root's current vim mode, or `null` when vim is off (the attribute
 *  is absent entirely then). */
async function vimMode(session: Session): Promise<string | null> {
  const [el] = await session.findElements(".cm-editor");
  if (!el) return null;
  return await el.attribute("data-vim-mode");
}

/** Flip the Settings → Editor vim toggle and close the modal.
 *
 *  Developer mode first (#181): the toggle is hidden — absent from the DOM,
 *  not disabled — while the mode is off. `enableDeveloperMode` is idempotent
 *  and leaves Settings open on About, so callers that flip vim twice (vm1) get
 *  the rail click rather than a second modal open. */
async function setVimMode(session: Session, on: boolean): Promise<void> {
  await enableDeveloperMode(session);
  await (await session.byTestId("settings.tab-editor")).click();
  const toggle = await session.byTestId("settings.vim-mode");
  const checked = (await toggle.attribute("aria-checked")) === "true";
  if (checked !== on) await toggle.click();
  await session.waitUntil(
    async () => {
      const t = await session.byTestId("settings.vim-mode");
      return ((await t.attribute("aria-checked")) === String(on)) ? true : null;
    },
    { label: `vim toggle reaches ${String(on)}` },
  );
  await closeSettings(session);
}

/** Send raw keys to the focused editor (no leading probe character — unlike
 *  `typeIntoEditor`, these are meant to be interpreted as vim commands). */
async function sendEditorKeys(session: Session, keys: string): Promise<void> {
  const [content] = await session.findElements(".cm-content");
  if (!content) throw new Error("editor content not found");
  await content.sendKeys(keys);
}

describeE2E("vm1 vim mode toggles the editor modal and persists (vim-keyboard-mode)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("turns the editor modal, survives lock→unlock, and turns fully back off", async () => {
    let password = "";
    await scenario(
      "vm1-vim-mode-toggle",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditorAndNote(s, password, "vm1notealfa7k2m9qx4w8e5rj0aa");

        // Baseline: vim off — no mode attribute, and typing inserts text.
        expect(await vimMode(s)).toBe(null);
        await typeIntoEditor(s, "plain typing works");
        await waitForSaved(s);

        // Turn vim ON. The editor becomes modal without a reload.
        await setVimMode(s, true);
        await s.waitUntil(async () => ((await vimMode(s)) === "normal" ? true : null), {
          label: "editor reports normal mode after enabling vim",
        });

        // The bottom-bar indicator renders from the same source.
        await s.byTestId("editor.vim-mode");

        // Persistence: lock → unlock mounts a fresh editor that reads
        // editor_vim_mode from disk; the editor comes back modal.
        await lockAndReunlock(s, password);
        await s.waitUntil(async () => ((await vimMode(s)) === "normal" ? true : null), {
          label: "vim mode survives lock → unlock",
        });

        // Turn it back OFF → no mode attribute, no indicator, plain editor.
        await setVimMode(s, false);
        await s.waitUntil(async () => ((await vimMode(s)) === null ? true : null), {
          label: "mode attribute disappears after disabling vim",
        });
        expect((await s.byTestIdAll("editor.vim-mode")).length).toBe(0);
      },
    );
  });
});

describeE2E("vm2 Escape returns to normal mode, one job at a time (vim-keyboard-mode)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("insert → normal on one Escape, and a second Escape is inert", async () => {
    let password = "";
    await scenario(
      "vm2-vim-escape",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditorAndNote(s, password, "vm2notealfa7k2m9qx4w8e5rj0bb");
        await setVimMode(s, true);
        await s.waitUntil(async () => ((await vimMode(s)) === "normal" ? true : null), {
          label: "normal mode after enabling vim",
        });

        // `i` enters insert mode.
        await sendEditorKeys(s, "i");
        await s.waitUntil(async () => ((await vimMode(s)) === "insert" ? true : null), {
          label: "i enters insert mode",
        });

        // One Escape returns to normal.
        await sendEditorKeys(s, ESCAPE_KEY);
        await s.waitUntil(async () => ((await vimMode(s)) === "normal" ? true : null), {
          label: "Escape returns to normal mode",
        });

        // A second Escape changes nothing (and must not throw the editor into a
        // strange state).
        await sendEditorKeys(s, ESCAPE_KEY);
        expect(await vimMode(s)).toBe("normal");
      },
    );
  });
});

describeE2E("vm3 yanked text does not survive a lock (vim-keyboard-mode)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("clears the yank register on lock, so a paste after unlock adds nothing", async () => {
    let password = "";
    await scenario(
      "vm3-vim-lock-register",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditorAndNote(s, password, "vm3notealfa7k2m9qx4w8e5rj0cc");

        await typeIntoEditor(s, "confidential line");
        await waitForSaved(s);

        await setVimMode(s, true);
        await s.waitUntil(async () => ((await vimMode(s)) === "normal" ? true : null), {
          label: "normal mode after enabling vim",
        });

        // Yank the line into the unnamed register.
        await sendEditorKeys(s, "yy");

        const before = await noteText(s);

        // Lock → unlock. The reset on the lock path must have emptied the
        // register; a paste therefore adds nothing.
        await lockAndReunlock(s, password);
        await s.waitUntil(async () => ((await vimMode(s)) === "normal" ? true : null), {
          label: "vim still on after unlock",
        });

        await sendEditorKeys(s, "p");

        // Deliberately NOT `waitForSaved` here: the assertion is that NOTHING
        // changed, so there is no save to wait for and the helper simply times
        // out — which is exactly how the first run of this spec failed (66 s,
        // two retries). CodeMirror applies a paste synchronously while handling
        // the keystroke, so by the time `sendKeys` returns the document either
        // reflects it or, as asserted here, still doesn't.
        expect(await noteText(s)).toBe(before);

        // Prove the editor is still live and accepting vim input, so the
        // assertion above cannot pass merely because keystrokes stopped
        // arriving after the unlock.
        await sendEditorKeys(s, "i");
        await s.waitUntil(async () => ((await vimMode(s)) === "insert" ? true : null), {
          label: "editor still responds to vim keys after the paste attempt",
        });
      },
    );
  });
});

/** Unlock, dismiss the importer offer, and create a note — the shared opening of
 *  all three scenarios. */
async function unlockToEditorAndNote(
  session: Session,
  password: string,
  title: string,
): Promise<void> {
  await unlockToEditor(session, password);
  await dismissImporterOffer(session);
  await createNote(session, title);
}

/** The active note's visible text. */
async function noteText(session: Session): Promise<string> {
  const [content] = await session.findElements(".cm-content");
  if (!content) throw new Error("editor content not found");
  return await content.text();
}

describeE2E("vm4 hiding the vim toggle does not turn vim off (#181)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("turning Developer mode back off removes the control but leaves the editor modal", async () => {
    let password = "";
    await scenario(
      "vm4-hidden-not-disabled",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditorAndNote(s, password, "vm4notealfa7k2m9qx4w8e5rj0dd");

        await setVimMode(s, true);
        await s.waitUntil(async () => ((await vimMode(s)) === "normal" ? true : null), {
          label: "editor reports normal mode after enabling vim",
        });

        // Hide the gate again. `developer_mode` governs the CONTROL, never the
        // keymap — a visibility switch that also disabled the feature would be
        // the "surprise loss" the issue rejected.
        await openSettings(s, "about");
        await disableDeveloperModeInSettings(s);

        // The control is gone from Editor, while the section around it stays.
        await (await s.byTestId("settings.tab-editor")).click();
        await s.byTestId("settings.section.editor-editing");
        expect((await s.byTestIdAll("settings.vim-mode")).length).toBe(0);
        await closeSettings(s);

        // …and the editor is still modal. Asserted through a real keystroke as
        // well as the attribute: `l` moves the cursor in normal mode instead of
        // inserting the letter, which is the behaviour a user would notice
        // vanishing.
        await s.waitUntil(async () => ((await vimMode(s)) === "normal" ? true : null), {
          label: "editor still modal after the control was hidden",
        });
        await s.byTestId("editor.vim-mode");
        await sendEditorKeys(s, "i");
        await s.waitUntil(async () => ((await vimMode(s)) === "insert" ? true : null), {
          label: "vim still answers keystrokes with the control hidden",
        });
        await sendEditorKeys(s, ESCAPE_KEY);
        await s.waitUntil(async () => ((await vimMode(s)) === "normal" ? true : null), {
          label: "Escape returns to normal with the control hidden",
        });
      },
    );
  });
});
