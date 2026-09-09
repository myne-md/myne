// wc1 — closing the window flushes what has not been saved yet.
// myne-md/myne#555, the `app.window-chrome` bullet:
//
//   > the container CAN originate the real event: `xdotool windowclose` sends
//   > `WM_DELETE_WINDOW` directly to the window (no WM required under xvfb),
//   > GTK turns it into `delete-event` and tao into `CloseRequested`, which is
//   > the exact chain `Editor.tsx` listens on. `session.ts` already supports
//   > relaunching against the same `XDG_DATA_HOME`.
//
// # The bullet's premise is wrong, and the wrong version passes
//
// `xdotool windowclose` does NOT send WM_DELETE_WINDOW. It calls
// XDestroyWindow: the server tears the window down, GTK sees a window that is
// already gone, no `delete-event` is raised, tao raises no `CloseRequested`, and
// `Editor.tsx`'s handler never runs. The app still exits — which is what makes
// it expensive, because every outward sign of a graceful close is present.
//
// Measured, not reasoned: `strings` over the image's `libxdo.so.3` contains
// neither `WM_DELETE_WINDOW` nor `WM_PROTOCOLS`, and a probe write injected into
// the close handler did not land after an `xdotool windowclose`. Switching to a
// real ClientMessage, the same probe landed and `persistWorkspace()` overwrote a
// descriptor this scenario had planted.
//
// `wmctrl -c` is the other candidate and is also wrong here: it asks the WINDOW
// MANAGER (`_NET_CLOSE_WINDOW` to the root), and under xvfb there is none.
//
// So the close goes through `support/wm-delete-window.py` — twenty lines of
// Xlib via ctypes, no window manager needed and no package the image lacks. Its
// header carries the full measurement.
//
// # The chain being exercised
//
//   WM_PROTOCOLS / WM_DELETE_WINDOW ClientMessage
//                        ->  GTK `delete-event`
//                        ->  tao `CloseRequested`
//                        ->  Editor.tsx's onCloseRequested listener
//                            (preventDefault, flushAll, persistWorkspace,
//                             persistVaultIndices, flushGraphLayoutNow, destroy)
//
// Every link is real. The listener is not called, it is REACHED — which is the
// half that has broken before: that effect registers asynchronously and its own
// comment records a leak where the listener attached after cleanup had run.
//
// `destroy()` rather than `close()` is load-bearing too, and is covered here in
// the sense that the app must actually exit: the capability ACL grants
// `core:window:allow-destroy` and deliberately not `allow-close`, so a handler
// reaching for `close()` leaves the window permanently unclosable. On Windows,
// where the title-bar X is the only quit affordance, that wedges the app.
//
// # Both halves prove the disk was STALE first
//
// This is the whole design. Each claim is "X was not on disk, then the window
// closed, then X was on disk" — never just the end state, because the end state
// is also what an ordinary autosave produces.
//
//  * **The note body.** The idle autosave debounce is 1000 ms
//    (`AUTOSAVE_IDLE_MS`, pinned by decisions.md 2026-05-15). The on-disk body
//    is read through real IPC immediately after typing and asserted to lack the
//    new sentence; the editor buffer is separately asserted to HAVE it, because
//    "not on disk" is also true of text that never got typed.
//
//  * **The workspace descriptor.** Asserted not to mention the note opened this
//    session. The only OTHER writer is a coalesced background flush that runs at
//    most once per `WORKSPACE_FLUSH_INTERVAL_MS` = FIVE MINUTES, so a scenario
//    finishing in seconds cannot be rescued by it. This half needs no timing
//    argument.
//
//    What it does NOT isolate, measured rather than assumed: removing
//    `persistWorkspace()` from the close handler does not fail it. TWO paths
//    persist the layout on a graceful exit and they are redundant on purpose —
//    the frontend's `persistWorkspace()` here, and the BACKEND's
//    `RunEvent::ExitRequested` arm in `src-tauri/src/lib.rs`, which flushes the
//    container `Editor.tsx` mirrors into a RAM staging slot on every change
//    (that arm exists because Cmd+Q fires ExitRequested and never the window's
//    `onCloseRequested`). So this half asserts the user-visible property — the
//    layout survives closing the window — rather than one implementation of it,
//    and its failure message says so.
//
//    It still discriminates the thing this scenario is about: under
//    `xdotool windowclose` NEITHER path ran and a planted descriptor survived
//    untouched, because an XDestroyWindow reaches no graceful-exit code at all.
//
// An earlier version planted a marker via `workspace_write` and asserted it
// SURVIVED. That was backwards twice over: `workspace_write` writes straight to
// disk (so it survives a SIGKILL and proves nothing about a close), and
// `persistWorkspace()` overwrites it with the app's own container — so the
// assertion passed exactly when the handler had NOT run.
//
// Both are read back after a genuine cold start on the tree the first launch
// left behind — the same relocation `hk1` and `qu2` use.
//
// Vault-count precondition: 1 (weak KDF generator fixture), in each of the two
// launches.

import { cpSync } from "node:fs";

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
import { closeAppWindow } from "./support/xwindow";

/** Saved the ordinary way, so the note exists on disk before the interesting
 *  part. Single lowercase token, tokenizer-survivable, in-source constant. */
const SAVED_SENTENCE = "pencerekapanmadanoncekiyazi";
/** Typed and NOT saved — only the close handler's flush can persist it. */
const UNSAVED_SENTENCE = "pencerekapanirkenkurtarilanyazi";

describeE2E("wc1 closing the window flushes unsaved work (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF), in each of the two launches.
  it("persists an unflushed note body and the workspace on WM_DELETE_WINDOW", async () => {
    let password = "";
    let closedAppDataDir = "";
    let noteId = "";

    // ---- Launch 1: type, do NOT wait for the save, close the window --------
    await scenario(
      "wc1-close",
      {
        // Without this the harness deletes the tree on teardown and the flush
        // has nothing left to have written to.
        keepDataDir: true,
        seed: (dir) => void (password = seedVault(dir, {}).password),
      },
      async (app) => {
        const s = app.session;
        closedAppDataDir = app.appDataDir;

        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        const before = new Set((await ipcOk(s, "plugin:notes|note_list")) as string[]);
        await createNote(s, "Kapanis testi");
        await typeIntoEditor(s, ` ${SAVED_SENTENCE}`);
        await waitForSaved(s);

        const after = (await ipcOk(s, "plugin:notes|note_list")) as string[];
        const fresh = after.filter((id) => !before.has(id));
        expect(fresh.length, `expected exactly one new note, got ${fresh.length}`).toBe(1);
        noteId = fresh[0]!;

        // WORKSPACE PRECONDITION. The note is open in a pane, so the LIVE
        // container names it — but nothing has written that container to disk:
        // opening a note only stages, and the coalesced flush is five minutes
        // away. Asserting the staleness is what makes the post-close read mean
        // "the close handler wrote this".
        const staleDescriptor = (await ipcOk(
          s,
          "plugin:workspace|workspace_read",
        )) as unknown;
        expect(
          typeof staleDescriptor !== "string" || !staleDescriptor.includes(noteId),
          `the on-disk workspace descriptor already names the note opened this ` +
            `session, so something persisted it before the close and the assertion ` +
            `after the close would hold whether or not the handler ran. Read: ` +
            `${JSON.stringify(staleDescriptor).slice(0, 200)}`,
        ).toBe(true);

        // The unflushed edit, and immediately the proof that it IS unflushed.
        await typeIntoEditor(s, ` ${UNSAVED_SENTENCE}`);
        const onDisk = (await ipcOk(s, "plugin:notes|note_read", { noteId })) as unknown;
        expect(
          typeof onDisk === "string" && !onDisk.includes(UNSAVED_SENTENCE),
          `the second sentence was already on disk before the window closed, so the ` +
            `1000ms idle autosave won the race and this scenario would measure the ` +
            `ordinary save path instead of the close handler. Nothing is wrong with ` +
            `the app; the scenario lost its precondition — the IPC round-trip above ` +
            `has to land inside AUTOSAVE_IDLE_MS.`,
        ).toBe(true);
        expect(
          typeof onDisk === "string" && onDisk.includes(SAVED_SENTENCE),
          `the FIRST sentence is not on disk either, so nothing was ever saved and ` +
            `"the second one is absent" says nothing. Read back: ` +
            `${JSON.stringify(onDisk)}`,
        ).toBe(true);

        // …and the second half of the same precondition, which is the one that
        // makes the disk read mean anything. "Not on disk" is also true of text
        // that never reached the editor at all, and a scenario resting on the
        // absence alone would pass identically against a broken `typeIntoEditor`
        // — proving that a flush cannot save what was never typed.
        const buffer = await s.execute<string>(
          "var c = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
            "return c ? (c.textContent || '') : '';",
        );
        expect(
          (buffer ?? "").includes(UNSAVED_SENTENCE),
          `the sentence is missing from the EDITOR BUFFER as well as from disk, so ` +
            `there is nothing unflushed for the close handler to rescue and this ` +
            `scenario would pass on any build. The typing did not land.`,
        ).toBe(true);

        // The real thing: WM_DELETE_WINDOW to the toplevel, exactly what a
        // title-bar X sends. Not `teardown` and not a signal — both of those
        // kill the app, which is the opposite of asking it to leave, and the
        // whole subject here is what the app does when asked.
        closeAppWindow(app.driverPid);

        // The app's EXIT is the signal that the flush finished: the handler
        // destroys the window only after flushAll + persistWorkspace +
        // persistVaultIndices + flushGraphLayoutNow have resolved. Returning
        // before this would let teardown SIGTERM the app mid-flush and then
        // measure a disk this scenario had itself truncated.
        await app.waitForExit();
      },
    );

    expect(closedAppDataDir, "launch 1 never reported its data directory").not.toBe("");
    expect(noteId, "launch 1 never identified its note").not.toBe("");

    // ---- Launch 2: cold start on the tree the close left behind ------------
    await scenario(
      "wc1-reopen",
      { seed: (dir) => cpSync(closedAppDataDir, dir, { recursive: true }) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        // Tolerant: the vault already holds a note, so the fresh-vault importer
        // overlay is correctly absent and the strict helper would wait its whole
        // budget for it.
        await dismissImporterOfferIfPresent(s);

        // The race-free half FIRST. It is the one signal that says whether the
        // close handler ran AT ALL — a different blob family (`MYW1`), a
        // different write path, and no background writer that could have done it
        // inside this scenario's lifetime. Asserting the note body first would
        // let a handler that never fired be reported as a flush bug.
        const descriptor = (await ipcOk(s, "plugin:workspace|workspace_read")) as unknown;
        expect(
          typeof descriptor === "string" && descriptor.includes(noteId),
          `the workspace the user was looking at when they closed the window did ` +
            `not survive (read: ${JSON.stringify(descriptor).slice(0, 200)}). It was ` +
            `verified stale before the close and the coalesced background flush is ` +
            `five minutes away, so a graceful exit did not happen at all: BOTH the ` +
            `frontend's persistWorkspace() and the backend's ExitRequested staged ` +
            `flush would have written this, and they are independent. If the note ` +
            `body below also fails, the close handler was never reached.`,
        ).toBe(true);

        const body = (await ipcOk(s, "plugin:notes|note_read", { noteId })) as unknown;
        expect(
          typeof body === "string" && body.includes(UNSAVED_SENTENCE),
          `the sentence typed just before the window closed is gone. It was verified ` +
            `to be unflushed at that moment and present in the editor buffer, so the ` +
            `close handler's flushAll() either did not run or did not wait — which is ` +
            `silent data loss on the most ordinary exit there is: the user clicks the X.`,
        ).toBe(true);
        expect(
          typeof body === "string" && body.includes(SAVED_SENTENCE),
          `the earlier, SAVED sentence is gone too, which is a different and worse ` +
            `failure: the close path did not merely skip the flush, it wrote over ` +
            `what was already there.`,
        ).toBe(true);
      },
    );
  });
});
