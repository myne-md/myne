// Multi-cursor / multiple selections (multi-cursor / MYND-306, task 3;
// stories 1/2/3/4/6/7).
//
// AUTHORED ON A NON-HARNESS HOST (macOS) — pending green-3x verification on the
// Linux tauri-driver container (the e2e DoD; `./scripts/e2e-local.sh`). It CANNOT
// run here; it is authored to the harness contract for the Linux runner.
//
// Drives multi-cursor through the production binary, keyboard-only (the
// deterministic path under tauri-driver — the W3C Actions API sidesteps the
// invisible-U+E007 hazard, MEMORY e2e note). The Linux container accelerator is
// Control (the canonical `Mod`).
//
// What is asserted:
//   - Mod-Alt-ArrowDown (addCursorBelow, free from the installed defaultKeymap)
//     adds a vertical cursor; typing lands the SAME edit at every cursor
//     (story 2/4); the selection count is observable via the
//     `data-selection-count` attribute the selectionCountObserver writes on the
//     editor DOM (story 7, no new chrome).
//   - Mod-d (selectNextOccurrence) extends the selection to the next occurrence
//     of a selected word (story 3).
//   - Escape collapses back to a single cursor (story 6).
//
// What is NOT re-driven here (and why):
//   - The facet/lockstep/collapse state transitions + the drawSelection mount +
//     the Mod-d binding + the selection-count attribute are unit-tested
//     (tests/editor/multi-cursor.test.ts, tests/editor/keymap.test.ts).
//   - Alt-click add-cursor (CM6 native mouseSelectionStyle) is a mouse path; the
//     keyboard add-cursor exercises the same multi-selection machinery and is
//     deterministic under the driver, so the mouse gesture is not re-driven.
//
// Vault-count precondition: 1 (weak KDF generator fixture — legal: unlock reads
// params from vault.meta). Note bodies are in-source scenario content, never
// credentials (SYNC-13).

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
import type { Session } from "./support/webdriver";

// W3C Actions API key code points (mirrors the escapes used across the suite,
// e.g. search-palette.e2e.ts CONTROL/ESCAPE, table-editing.e2e.ts ENTER).
const SHIFT = "\uE008";
const CONTROL = "\uE009";
const ALT = "\uE00A";
const ESCAPE = "\uE00C";
const HOME = "\uE011";
const ARROW_RIGHT = "\uE014";
const ARROW_UP = String.fromCharCode(0xe013);
const ARROW_DOWN = "\uE015";

const CM_CONTENT = '[data-testid="editor.content"] .cm-content';
// selectionCountObserver writes `data-selection-count` onto the editor's outer
// DOM node (`.cm-editor` === CM6's `view.dom`), nested under the testid host.
const CM_EDITOR = '[data-testid="editor.content"] .cm-editor';

/** Read the live multi-cursor selection-range count from the editor DOM. */
async function selectionCount(s: Session): Promise<number> {
  const editor = await s.waitForElement(CM_EDITOR);
  const raw = await editor.attribute("data-selection-count");
  return raw === null ? NaN : Number(raw);
}

/** Wait until the observable selection count equals `want`. */
async function waitForSelectionCount(s: Session, want: number): Promise<void> {
  await s.waitUntil(
    async () => ((await selectionCount(s)) === want ? true : null),
    { label: `selection count === ${want}`, timeoutMs: 10_000 },
  );
}

/** Press one chord (modifiers held around `key`) via the W3C Actions API —
 *  keys down in order, then up in reverse. No `sendKeys` for chords. */
async function pressChord(s: Session, modifiers: string[], key: string): Promise<void> {
  const downs = [...modifiers, key].map((value) => ({ type: "keyDown", value }));
  const ups = [...modifiers, key].reverse().map((value) => ({ type: "keyUp", value }));
  await s.send("POST", "/actions", {
    actions: [{ type: "key", id: "kbd", actions: [...downs, ...ups] }],
  });
}

/** Tap a single key (no modifiers) via the Actions API. */
async function tapKey(s: Session, key: string): Promise<void> {
  await s.send("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "kbd",
        actions: [
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
        ],
      },
    ],
  });
}

describeE2E("mc1 vertical add-cursor types in lockstep + Escape collapses (MYND-306)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("Mod-Alt-Down adds a cursor below; typing lands at every cursor; Escape collapses to one", async () => {
    let password = "";
    await scenario(
      "mc1-vertical-add-cursor",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Multi Cursor");

        // Three short lines; the leading dot column gives Mod-Alt-Down a place
        // to stack cursors. The `mctail` markers pin the note for editorText.
        await typeIntoEditor(s, ".aaa mctaila\n.bbb mctailb\n.ccc mctailc");
        await waitForSaved(s);

        await s.waitForElement(CM_CONTENT);
        // The caret sits at the end of the typed body (line ".ccc"). Notes carry
        // editable YAML frontmatter (title/updated) ABOVE the body, so Ctrl+Home
        // would stack cursors in the frontmatter — step UP within the body to its
        // first line (".aaa") instead. typeIntoEditor leaves focus in the editor,
        // so no click is needed (a click would re-place the caret arbitrarily).
        await pressChord(s, [], ARROW_UP);
        await pressChord(s, [], ARROW_UP);
        await pressChord(s, [], HOME);
        await waitForSelectionCount(s, 1);

        // Two cursors below → cursors on all three lines (count 3).
        await pressChord(s, [CONTROL, ALT], ARROW_DOWN);
        await pressChord(s, [CONTROL, ALT], ARROW_DOWN);
        await waitForSelectionCount(s, 3);

        // Type a marker at all three cursors in lockstep (story 4): each line
        // gains the SAME leading edit. Lowercase "z": WebKitWebDriver's Send Keys
        // does NOT apply the shift modifier, so an uppercase char arrives
        // lowercased — assert the char the driver actually types.
        await tapKey(s, "z");
        await s.waitUntil(
          async () => {
            const text = await editorText(s);
            return text.includes("z.aaa") && text.includes("z.bbb") && text.includes("z.ccc")
              ? true
              : null;
          },
          { label: "lockstep edit landed on all three lines", timeoutMs: 10_000 },
        );

        // Escape collapses the multi-selection back to a single cursor (story 6).
        // Escape is LAYERED: typing the lockstep marker can leave a word/auto-
        // complete tooltip open at the cursors, and CM6's closeCompletion claims
        // the first Escape to dismiss it (higher precedence than the collapse
        // command) — so press Escape until the selection actually collapses
        // (a no-op once it's a single range: collapseMultiSelection returns false
        // and the key falls through harmlessly).
        await s.waitUntil(
          async () => {
            if ((await selectionCount(s)) === 1) return true;
            await tapKey(s, ESCAPE);
            return null;
          },
          { label: "Escape collapses the multi-selection to one", timeoutMs: 10_000 },
        );
      },
    );
  });
});

describeE2E("mc2 Mod-d extends to the next occurrence (MYND-306)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("selecting a word then Mod-d adds the next occurrence to the selection", async () => {
    let password = "";
    await scenario(
      "mc2-mod-d-next-occurrence",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Mod D Note");

        // Three occurrences of "widget" on one line → Mod-d can extend twice.
        await typeIntoEditor(s, "widget widget widget mctaild");
        await waitForSaved(s);

        await s.waitForElement(CM_CONTENT);
        // The body is one line ("widget …") and the caret is at its end. Use Home
        // (line-relative) — NOT Ctrl+Home, which lands in the note's frontmatter
        // above the body — to reach the body line start, then select the first
        // word "widget" (6 chars) via Shift+ArrowRight x6. The selection must be
        // exactly "widget" for Mod-d to find its next runs (typeIntoEditor removed
        // its probe char, so the body line really starts with "widget").
        await pressChord(s, [], HOME);
        await waitForSelectionCount(s, 1);
        for (let i = 0; i < 6; i++) {
          await pressChord(s, [SHIFT], ARROW_RIGHT);
        }
        await waitForSelectionCount(s, 1);

        // Mod-d extends to the second occurrence (count 2), then the third (3).
        await pressChord(s, [CONTROL], "d");
        await waitForSelectionCount(s, 2);
        await pressChord(s, [CONTROL], "d");
        await waitForSelectionCount(s, 3);

        // Escape collapses back to one (story 6).
        await tapKey(s, ESCAPE);
        await waitForSelectionCount(s, 1);
      },
    );
  });
});
