// Delete-after-save suite (myne#167). Proves that erasing characters by
// TAPPING the key — discrete press/release, the way a user erases a few
// characters — removes exactly one character per press and that none of them
// come back, including across the autosave round trip that used to restore
// them.
//
//   ds1 — TAP-DELETE ACROSS A SAVE: type a marker, let autosave settle, then tap
//         Backspace one press at a time with a settle between bursts, and assert
//         the buffer holds exactly the expected truncation after each burst —
//         then reload and assert the SAME text came off disk.
//
// What this guards: autosave echoes its stamped body back into the same `value`
// prop the editor mirrors (`useAutosave`'s `onSaved` is PaneView's buffer
// setter). If that echo is adopted from a snapshot the buffer has already moved
// past, `diffDoc` collapses the frontmatter-stamp difference and the body-tail
// difference into ONE replacement spanning the user's text — the deleted
// character reappears, and because the rewritten body then equals the
// last-saved one the buffer settles `clean`, so the loss reaches disk. The disk
// re-read at the end is the half that makes this more than a rendering check.
//
// This scenario canNOT reproduce the original race on demand: it needed an IPC
// resolution to land inside a sub-millisecond scheduler window. It pins the
// PATH instead — delete-after-save, buffer and disk agreeing — which is what
// regressed. The race itself is pinned deterministically in
// `tests/notes/useAutosave.test.ts` and `tests/editor/cmeditor-stale-echo.test.tsx`.
//
// KDF: weak generator fixtures (SYNC-9 — params are vault.meta-resident).

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  reopenNoteAfterReload,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { KEY, pressKey } from "./support/keyboard";
import type { Session } from "./support/webdriver";

// A single lowercase-alnum token, long enough to survive tokenization and
// distinct enough that a partial match cannot pass by accident.
const MARKER = "tapdeletemarker8w3qz5xk7r2n";

/** Tap Backspace `n` times as `n` DISCRETE press/release pairs — the tapping
 *  the issue is about. Deliberately not one held key: auto-repeat never lets
 *  the γ1 idle timer elapse, so a held key has no save in flight to race and
 *  would not exercise this path at all. */
async function tapBackspace(session: Session, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await pressKey(session, KEY.BACKSPACE);
  }
}

/** Wait until the editor body holds EXACTLY `expected` of the marker — no more
 *  and no fewer characters.
 *
 *  Both halves are load-bearing. Containing `expected` proves no more than the
 *  intended characters were removed; NOT containing one character more proves
 *  no fewer — which is the dropped-keypress the issue reports, and which a
 *  bare `includes(expected)` would happily pass (a shorter deletion still
 *  contains the longer prefix).
 *
 *  Polls rather than asserting once: the echo that used to corrupt the buffer
 *  arrived up to a second after the keystroke, so a single immediate read could
 *  pass before the damage landed. */
async function expectExactly(
  session: Session,
  expected: string,
  label: string,
): Promise<void> {
  // `slice` past the end returns the whole string, so there is no "one more"
  // to be absent when nothing has been deleted yet — the containment check is
  // the whole assertion in that case.
  const oneMore =
    expected.length < MARKER.length
      ? MARKER.slice(0, expected.length + 1)
      : null;
  await session.waitUntil(
    async () => {
      const body = await editorText(session);
      if (!body.includes(expected)) return null;
      return oneMore === null || !body.includes(oneMore) ? true : null;
    },
    { label, timeoutMs: 15_000 },
  );
}

describeE2E("ds1 tap-delete survives the autosave round trip (myne#167)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("removes one character per discrete press, and none come back", async () => {
    let password = "";
    await scenario(
      "ds1-tap-delete-after-save",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await createNote(s, "Silme Defteri");
        await typeIntoEditor(s, MARKER);
        // Settle the FIRST save: from here the note has a stamped `updated:` on
        // disk, so every later save produces an echo that differs from the
        // buffer in the frontmatter as well as the body — the shape that used
        // to collapse into a whole-document replacement.
        await waitForSaved(s);
        await expectExactly(s, MARKER, "marker typed and saved");

        // First burst: four discrete taps, then let autosave settle again. The
        // caret is at the end of the marker (typeIntoEditor leaves it there), so
        // this erases exactly the last four characters.
        await tapBackspace(s, 4);
        const afterFirst = MARKER.slice(0, -4);
        await expectExactly(s, afterFirst, "four taps removed four characters");
        await waitForSaved(s);
        // Re-assert AFTER the save: this is the window the echo lands in, and a
        // restored character would show up here rather than above.
        await expectExactly(s, afterFirst, "the save did not restore a character");

        // Second burst, now with a stamped body already on disk.
        await tapBackspace(s, 3);
        const afterSecond = MARKER.slice(0, -7);
        await expectExactly(s, afterSecond, "three more taps removed three more");
        await waitForSaved(s);
        await expectExactly(s, afterSecond, "the second save did not restore either");

        // The half that proves this is not merely a rendering artefact: reload
        // the WebView and re-read the note from disk. A reload has no flush
        // hook, so what comes back is exactly what autosave persisted — so a
        // character restored into the BUFFER and settled `clean` (the shape
        // that made this data loss rather than a redraw) fails here.
        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        await reopenNoteAfterReload(s);
        await expectExactly(s, afterSecond, "the truncation is what reached disk");
      },
    );
  });
});
