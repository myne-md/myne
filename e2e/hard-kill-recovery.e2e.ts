// hk1 — what survives a crash. myne-md/myne#555, the `app.crash-recovery` and
// `workspace.saved-layouts` bullets:
//
//   > `killTree(proc,"SIGKILL")` over the process group already exists; with
//   > `keepDataDir` plus a seed that copies the kept `appDataDir`, "the named
//   > workspace is still listed" is a plain assertion after a genuine hard kill.
//
//   > typed, flushed, SIGKILL, relaunch, the sentence is there — a real crash
//   > test at a fixed post-flush delay.
//
// # Why "just quit the app" is not this test
//
// Every other scenario ends through `teardown`, which sends SIGTERM and lets
// the app run whatever it runs on the way out. That path can persist things a
// crash never would, so a scenario built on it cannot tell "we wrote this
// during the session" from "we wrote this while shutting down" — and the
// difference is the entire subject. A laptop losing power, an OOM kill, a
// forced quit: none of them run shutdown code.
//
// So this uses `hardKill()` (added to the harness for exactly this): SIGKILL to
// the whole process group, no `deleteSession`, no `CloseRequested`, no chance to
// flush. Anything still on disk afterwards was written while the app was
// running.
//
// # Two things are checked, because different machinery persists them
//
//  * the NOTE BODY — the editor's autosave loop, into a per-note `MY01` blob;
//  * the WORKSPACE DESCRIPTOR — `vault.workspace` (`MYW1`), a different file
//    written by a different path at a different time.
//
// A crash that lost either would be data loss, and the two fail separately.
//
// # What is deliberately NOT asserted
//
// Nothing about unflushed input. Text typed and not yet saved is *expected* to
// be gone after a kill, and asserting otherwise would be claiming a guarantee
// the app does not make and should not (the alternative is a synchronous write
// per keystroke). The scenario waits for the save to land before killing, so
// what it measures is: the app said it saved, and it had.
//
// Vault-count precondition: 1 (weak KDF generator fixture), in each launch.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  ipcOk,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { cpSync } from "node:fs";

// A single lowercase-alnum token, per the needle-design rule in
// `support/plaintext-scan.ts`: tokenizer-survivable, and unmistakable in a
// failure message.
const SENTENCE = "kazadansonrahayattakalanucumle";
// The marker inside the opaque workspace descriptor. The payload is
// frontend-driven and the backend never interprets it, so any shape round-trips
// — what matters is that the BYTES come back.
const LAYOUT_MARKER = "kazaduzenimarkeri";

describeE2E("hk1 a hard kill loses nothing that was saved (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF), in each of the two launches.
  it("keeps a saved note body and the workspace descriptor across SIGKILL", async () => {
    let password = "";
    let killedAppDataDir = "";
    let noteId = "";

    // ---- Launch 1: write, save, then die without warning -------------------
    await scenario(
      "hk1-crash",
      {
        // Without this the harness deletes the tree on teardown and the crash
        // has destroyed its own evidence.
        keepDataDir: true,
        seed: (dir) => void (password = seedVault(dir, {}).password),
      },
      async (app) => {
        const s = app.session;
        killedAppDataDir = app.appDataDir;

        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        const before = new Set((await ipcOk(s, "plugin:notes|note_list")) as string[]);
        await createNote(s, "Kaza testi");
        await typeIntoEditor(s, ` ${SENTENCE}`);
        // WAITED for, not slept past. What is being measured is durability
        // after the app said it had saved; a fixed delay would make this a race
        // and its failures unreadable.
        await waitForSaved(s);

        // `createNote` returns void, so the id is the one `note_list` gained.
        const after = (await ipcOk(s, "plugin:notes|note_list")) as string[];
        const fresh = after.filter((id) => !before.has(id));
        expect(fresh.length, `expected exactly one new note, got ${fresh.length}`).toBe(1);
        noteId = fresh[0]!;

        // A workspace descriptor, persisted by different machinery than the
        // note. `workspace_write` is the same call the pane tree makes.
        await ipcOk(s, "plugin:workspace|workspace_write", {
          descriptor: JSON.stringify({ e2e: LAYOUT_MARKER }),
        });

        // …and now the power goes out.
        await app.hardKill();
      },
    );

    expect(killedAppDataDir, "launch 1 never reported its data directory").not.toBe("");
    expect(noteId, "launch 1 never identified its note").not.toBe("");

    // ---- Launch 2: a cold start on the tree the crash left behind ----------
    await scenario(
      "hk1-recover",
      {
        // `dir` is launch 2's empty appDataDir; lay the crashed tree into it.
        // The app resolves every path from app_data_dir at runtime, so moving
        // the tree to a new absolute home is transparent — the same relocation
        // `qu2` relies on.
        seed: (dir) => cpSync(killedAppDataDir, dir, { recursive: true }),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        // The tolerant variant, and the reason is the scenario's own subject:
        // the importer offer is a FRESH-vault first-editor overlay, and this
        // vault already has a note in it — the one written before the crash. A
        // hard `dismissImporterOffer` here waits its full budget for an overlay
        // that is correctly absent, which is what the first run of this
        // scenario did.
        await dismissImporterOfferIfPresent(s);

        // 1. The note is listed at all. A vault that failed to open would have
        //    failed at `unlockToEditor`, so this is specifically "the note
        //    survived", not "the vault did".
        const ids = (await ipcOk(s, "plugin:notes|note_list")) as string[];
        expect(
          ids,
          `the note created before the crash is gone from the vault. It had been ` +
            `SAVED — the editor reported the write landed — so this is data loss ` +
            `rather than an unflushed buffer.`,
        ).toContain(noteId);

        // 2. Its body is intact, read through the real note-read path.
        const body = (await ipcOk(s, "plugin:notes|note_read", { noteId })) as unknown;
        expect(
          typeof body === "string" && body.includes(SENTENCE),
          `the pre-crash note is listed but reopened without the sentence that had ` +
            `been saved into it. That is the worse of the two failures: the user ` +
            `sees their note, opens it, and the words are missing.`,
        ).toBe(true);

        // 3. The workspace descriptor, written by a different path into a
        //    different blob family (`MYW1`), so this fails independently.
        const descriptor = (await ipcOk(s, "plugin:workspace|workspace_read")) as unknown;
        expect(
          typeof descriptor === "string" && descriptor.includes(LAYOUT_MARKER),
          `the workspace descriptor saved before the crash did not come back ` +
            `(read: ${JSON.stringify(descriptor)}). The user's pane layout is gone ` +
            `even though the notes survived — a separate loss, from a separate ` +
            `write path.`,
        ).toBe(true);
      },
    );
  });
});
