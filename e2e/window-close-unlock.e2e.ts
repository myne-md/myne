// wc2: the window closes from the LOCK screen, after a vault has been open.
// myne-md/myne#945 item 05, owner screenshot `05-carpi-kapatmiyor.png`.
//
// # The failure this prevents
//
// The title-bar X did nothing at all on the lock screen: no window movement, no
// exit, no error. Tauri calls `prevent_close()` on the native close control as
// soon as ANY JavaScript listener exists for `tauri://close-requested`
// (`tauri-2.12.1/src/manager/window.rs`), so the window becomes unclosable and
// the app has to be killed. The listener that did this belonged to `Editor.tsx`,
// and the shape of the bug is the point: the LOCK SCREEN registers nothing of
// its own, so whether it could be closed depended on whether the previous
// screen's listener had already been torn down. `Editor.tsx`'s registration is
// asynchronous, and its own comment records the leak it can leave behind when
// the component unmounts (lock -> Unlock screen) before that await returns: the
// listener then attaches AFTER cleanup ran and is never removed.
//
// The fix moves the listener to `App` (one per process, `src/lib/close-request.ts`)
// and turns screens into guards, so closability stops depending on a mount race.
//
// # The fixture has to pass THROUGH the editor, and that was measured
//
// The first version of this scenario seeded a vault and closed on the lock
// screen of a FRESH LAUNCH. It passed with the fix removed, which makes it a
// vacuous test and not a regression test: on a fresh launch no listener was ever
// registered, so there was nothing left to wedge the window and the broken build
// closed normally. The defective state needs a listener that outlived its
// screen, which only happens after an editor has mounted.
//
// So the walk is: unlock (the editor mounts and registers), lock from the
// editor's own lock control (the editor unmounts, leaving whatever it failed to
// remove), assert the editor is gone and the password field is up, and only then
// send `WM_DELETE_WINDOW`. Verified by injection rather than by reasoning: with
// `App`'s interceptor removed and the editor's leak restored, this scenario goes
// red on `waitForExit`; with the fix in place it is green three runs running.
//
// # What a red here means
//
// `waitForExit` has a bounded budget and the bug is a window that never exits, so
// the failure is a timeout on the app still being alive after being asked to
// leave. That is the user's symptom, reproduced. The inverse (a scenario that
// closed the window with `teardown`, or SIGTERM'd the app) would pass on the
// broken build, which is why the close goes through `closeAppWindow` and not
// through the harness's own shutdown.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOfferIfPresent, unlockToEditor } from "./support/flows";
import { appPid, closeAppWindow, waitForAppProcessGone } from "./support/xwindow";

describeE2E("wc2 the window closes from the lock screen (myne-md/myne#945)", () => {
  it("exits on WM_DELETE_WINDOW after the vault was locked from the editor", async () => {
    let password = "";
    // Vault-count precondition: 1 (weak KDF).
    await scenario(
      "wc2-unlock-close",
      {
        seed: (dir) => {
          password = seedVault(dir, {}).password;
        },
      },
      async (app) => {
        const s = app.session;

        // Reach the editor first. Without this the scenario cannot fail the way
        // the lock screen did (see the header): the listener it leaves behind
        // only exists once an editor has mounted.
        await unlockToEditor(s, password);
        await dismissImporterOfferIfPresent(s);
        await s.waitForElement('[data-testid="editor.root"]');

        // Lock from the editor's own affordance, so the unmount is the app's
        // normal path and not a harness teardown.
        await (await s.byTestId("editor.lock-cta")).click();

        // Mount the lock screen. Same test-id pair `unlockToEditor` waits on, so
        // a vault with a quick-unlock PIN (the PIN owns the screen, the password
        // form sits behind a reveal) does not hang this wait. This suite seeds a
        // bare vault, so the password field is the one that appears.
        await s.waitForElement('[data-testid="unlock.password-input"]');

        // THE PRECONDITION THAT MAKES THIS A DIFFERENT SCENARIO. `editor.root`
        // is wc1's subject; if it is still mounted here the close is being served
        // by the editor's guard and this file says nothing about the lock screen.
        expect(
          await s.byTestIdAll("editor.root"),
          "the editor is still mounted after locking, so this scenario is measuring " +
            "the editor's close path and cannot fail the way the lock screen did",
        ).toHaveLength(0);

        // The pid that owns the window IS the thing being asked to leave, so it
        // is read before the close: after it, there is no window to ask.
        const pid = appPid(app.driverPid);
        expect(pid, "the app window has no _NET_WM_PID, so its exit cannot be measured").not.toBeNull();

        // The real thing: WM_DELETE_WINDOW to the toplevel, exactly what a
        // title-bar X sends. Not `teardown` and not a signal: both kill the app,
        // which is the opposite of asking it to leave.
        closeAppWindow(app.driverPid);

        // Under the defect this never resolves: the window ignored the request,
        // so the process stays up for the full budget. The budget is generous
        // because the flush chain is allowed to take seconds, and the assertion
        // is on the RESULT: `waitForExit` used to stand in here and it polls the
        // driver's port, which the driver keeps answering after its window is
        // gone, so it reported the same thing for a close that happened and one
        // that did not (measured, see the header).
        expect(
          await waitForAppProcessGone(pid!),
          "the app process never exited after WM_DELETE_WINDOW was sent to it",
        ).toBe(true);
      },
    );
  });
});
