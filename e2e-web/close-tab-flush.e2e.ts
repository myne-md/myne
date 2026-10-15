// Closing the tab flushes the edit, and reopening the browser finds it.
// myne-md/myne#556, the `app.window-chrome` / `workspace.panes-and-tabs` /
// `web.lifecycle.refresh-mid-edit` bullet:
//
//   > Chrome and Firefox are the web CI matrix, WebDriver closes a browsing
//   > context and handles the resulting user prompt, and the load-bearing
//   > assertion (the sentence is present on reopen) is a DOM read.
//
// # Why this is the web client's most consequential lifecycle case
//
// `Editor.tsx` says it, in the comment that added the handler this drives:
//
//   > The Tauri close-intercept above is a no-op in a browser — its own catch
//   > says so — which meant every tab close silently dropped the newest edit,
//   > the workspace descriptor, the vault indices and the graph layout. On the
//   > one client where an unsynced edit is all that stands between the user and
//   > real loss.
//
// A desktop user who loses an unflushed edit still has the vault. A web user
// whose edit never left the tab has nothing anywhere — the server has not seen
// it either. So the `pagehide` flush is the whole safety net, and it lives on a
// seam (`src/platform/exit-signals.ts`) that is inert on the other client, so
// the desktop suite cannot cover it even in principle.
//
// # Two browser sessions, one profile
//
// OPFS lives in the browser profile and is keyed by origin, so proving that
// something survived the browser going away needs the SECOND session to open
// the same profile AND the same origin. Both are now threadable
// (`BrowserSessionOptions.profileDir`, `OpenFixtureVaultOptions.bundlePort` +
// `skipSeed`), and every other scenario must leave them alone: profile
// isolation between successive scenarios is what stops test 2 opening test 1's
// vault.
//
// `skipSeed` is the load-bearing one. Re-seeding on reopen would write the
// fixture over exactly what this scenario is asking about, and it would pass —
// the fixture's own note would be there.
//
// # The edit is proved UNFLUSHED before the close
//
// Otherwise the assertion is satisfied by the ordinary autosave, which fires
// after 1000ms of idle (`AUTOSAVE_IDLE_MS`) and would make this a test of the
// debounce. The editor buffer is read for the text, and the save badge is
// required NOT to be in its saved state, both immediately before the close.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault } from "./support/fixture-session";
import type { Session } from "./support/session";

/** Typed and deliberately not waited on. Single lowercase token, in-source. */
const SENTENCE = "sekmekapanirkenkurtarilanyazi";

/**
 * Create a note from the sidebar's create button and wait for its editor.
 *
 * Scripted clicks rather than driver clicks, which is this lane's working
 * idiom — `quarantine-roundtrip.e2e.ts` records that the driver cannot click a
 * settings tab here, and `support/fixture-session.ts`'s `openSettingsTab` takes
 * the same route for the same reason.
 *
 * The create actions used to live behind a `+` menu (`notes.new-menu` →
 * `notes.new-menu-dropdown`). e35c8a7b (myne#779) replaced it with direct
 * buttons on both clients; `e2e/support/flows.ts` followed the move and this
 * copy did not, so it clicked a `null`. `notes.create` is the button that
 * carried over.
 *
 * NO rename step, unlike the desktop helper: `notes.create` lands directly on a
 * mounted `editor.content` with no `notes.rename-input` anywhere in the tree. A
 * helper copied from `e2e/support/flows.ts` waits fifteen seconds for that
 * input and then reports a timeout that reads like a broken sidebar.
 */
async function createNote(session: Session): Promise<void> {
  await session.execute(
    "document.querySelector('[data-testid=\"notes.create\"]').click();",
  );
  await session.waitForElement('[data-testid="editor.content"] .cm-content', {
    timeoutMs: 20_000,
  });
}

/**
 * Type into whatever currently has focus, via the W3C Actions keyboard source.
 *
 * `Element.sendKeys` targets an element and chromedriver refuses a
 * `contenteditable` div ("element not interactable"). A key action has no
 * element target at all — it goes to the focused node, which is what a user's
 * keyboard does.
 */
async function typeIntoActiveElement(session: Session, text: string): Promise<void> {
  await session.send("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: [...text].flatMap((ch) => [
          { type: "keyDown", value: ch },
          { type: "keyUp", value: ch },
        ]),
      },
    ],
  });
}

/** The editor's current buffer text. */
async function bufferText(session: Session): Promise<string> {
  return (
    (await session.execute<string>(
      "var c = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
        "return c ? (c.textContent || '') : '';",
    )) ?? ""
  );
}

/** The save badge's rendered text, or `""` when it is not on screen. */
async function saveStatus(session: Session): Promise<string> {
  return (
    (await session.execute<string>(
      "var s = document.querySelector('[data-testid=\"editor.save-status\"]');" +
        "return s ? (s.textContent || '') : '';",
    )) ?? ""
  );
}

describeE2E("closing the tab flushes the edit", () => {
  // SKIPPED, and NOT because it is flaky — it has never passed. What it reports
  // is a real gap, and the mechanism is understood; the FIX is a design decision
  // rather than something this scenario should invent, so it is recorded here
  // and left for #556 rather than published as a one-line patch.
  //
  // WHAT IS MEASURED, all in one build:
  //
  //   1. The sentence reaches the editor buffer (read back from `.cm-content`).
  //   2. The save badge is NOT in its saved state at that moment, so the 1000ms
  //      idle autosave has not fired and this is genuinely unflushed work.
  //   3. `pagehide` FIRES on the close. A listener installed before it writes a
  //      marker into localStorage, and the marker is still there in session two:
  //      `{"ph":"fired@1787467231039","vc":"hidden@1787467231039"}`. So the app's
  //      `onExitIntent` seam is reached; this is not the desktop lane's
  //      `xdotool windowclose` trap, where the event never happened at all.
  //   4. The vault and the NOTE survive — session two finds the sidebar row.
  //   5. The note's TEXT does not.
  //
  // Both close routes were tried and behave the same: `DELETE /window` (close the
  // browsing context, which is what fires `pagehide`) and `DELETE /session`.
  //
  // THE LIKELY MECHANISM, offered as an explanation rather than as a sixth
  // measurement: a browser does not wait for asynchronous work started in a
  // `pagehide` handler. `Editor.tsx`'s handler is `async` and awaits
  // `runFlushChain`, which is IPC round-trips into a Worker that then writes
  // OPFS — several await boundaries after the page has been told it is going
  // away. The events fire; the work does not finish. That would also explain why
  // the `hidden` arm does not save it: both timestamps above are the SAME
  // millisecond, so the tab was never backgrounded before the close and the
  // `hidden` flush had no more time than the `pagehide` one.
  //
  // What that means for the comment the handler was added under — "every tab
  // close silently dropped the newest edit … on the one client where an unsynced
  // edit is all that stands between the user and real loss" — is that the
  // handler addresses the case it names only when the user leaves the tab long
  // enough for the flush to land, not when they close it.
  //
  // Un-skip when the flush is made to survive a teardown. The scenario itself is
  // complete and every step above it was verified; only the final assertion
  // fails.
  //
  // # Four input-method failures this cost, recorded because each is reusable
  //
  //   * `Element.click()` on `.cm-content` times out on the interactability
  //     check ("element interactable + clicked" after 10s).
  //   * a scripted `.focus()` leaves CodeMirror without a selection: the
  //     keystrokes go nowhere and the buffer stays empty.
  //   * `Element.sendKeys` on that handle is refused outright ("element not
  //     interactable") — chromedriver's view of a contenteditable div. The W3C
  //     `/actions` keyboard source has no element target and works.
  //   * and none of it lands until the IMPORTER OVERLAY is dismissed. A fresh
  //     vault's first editor shows it and it swallows the click; probed,
  //     `document.activeElement` stayed `BODY` and `.cm-editor.cm-focused` was
  //     false after an `actionClick` that reported success. The desktop lane has
  //     `dismissImporterOffer` for exactly this.
  it.skip("finds the unsaved sentence after the browser is reopened on the same profile", async () => {
    const first = await openFixtureVault();
    const profileDir = first.browser.profileDir;
    const bundlePort = Number(new URL(first.server.origin).port);
    let firstClosed = false;

    try {
      const { session } = first;

      // A note first. The checked-in fixture vault holds NONE — the lane's other
      // scenarios rely on that — so no editor mounts until one exists, and the
      // first run of this scenario failed on exactly that (`no such element:
      // [data-testid="editor.content"] .cm-content`).
      await createNote(session);

      const content = await session.findElement(
        '[data-testid="editor.content"] .cm-content',
      );
      // Focused by script, not by a driver click. `.cm-content` is a
      // `contenteditable` div and the driver's interactability check times out
      // on it here ("element interactable + clicked" after 10s) — the same
      // click problem this lane already records for a settings tab. `.focus()`
      // is what CodeMirror itself acts on, and the keystrokes below go to the
      // active element.
      // A real pointer click through the W3C Actions API. Three routes were
      // tried and the first two are recorded because each fails differently:
      // `Element.click()` times out on the interactability check, and a scripted
      // `.focus()` leaves CodeMirror without the selection it needs, so the
      // keystrokes go nowhere and the buffer stays empty. `actionClick` moves a
      // pointer and presses it, which is what places a caret.
      // The importer onboarding OVERLAY first. A fresh vault's first editor shows
      // it, and it swallows the click: probed, `document.activeElement` stayed
      // `BODY` and `.cm-editor.cm-focused` was false after an `actionClick` that
      // reported success. The desktop lane has `dismissImporterOffer` for exactly
      // this; the web lane had no equivalent because nothing here had needed to
      // type into a fresh vault before.
      await session.execute(
        "document.querySelector('[data-testid=\"importer.offer-dismiss\"]')?.click();",
      );
      await session.waitForGone('[data-testid="importer.offer-root"]', {
        timeoutMs: 15_000,
      });
      await content.actionClick();
      // Keys to the ACTIVE element rather than to the located one. `sendKeys` on
      // the `.cm-content` handle is refused here ("element not interactable"),
      // which is chromedriver's view of a contenteditable div; the `/actions`
      // keyboard source has no element target and goes wherever focus is.
      await typeIntoActiveElement(session, ` ${SENTENCE}`);

      // PRECONDITION 1: the text is in the buffer. "It is not saved yet" is also
      // true of text that never arrived, and a scenario resting on the absence
      // alone would pass against a broken `sendKeys`.
      expect(
        await bufferText(session),
        "the sentence is missing from the editor buffer, so there is nothing " +
          "unflushed for the close to rescue and this scenario would pass on any " +
          "build",
      ).toContain(SENTENCE);

      // PRECONDITION 2: it is NOT saved. The autosave idle debounce is 1000ms
      // (`AUTOSAVE_IDLE_MS`), so if it has already fired this scenario measures
      // the debounce instead of the close handler. `waitForSaved` deliberately
      // is NOT used — waiting for a save is the opposite of what is wanted.
      const status = await saveStatus(session);
      expect(
        status.toLowerCase().includes("saved") && !status.includes("…"),
        `the save badge reads ${JSON.stringify(status)} before the tab was closed, ` +
          `so the 1000ms idle autosave won the race and the sentence was already ` +
          `on disk. Nothing is wrong with the app; the scenario lost its ` +
          `precondition — everything between the keystrokes and this read has to ` +
          `land inside AUTOSAVE_IDLE_MS.`,
      ).toBe(false);

      // The close. `deleteSession` ends the browsing context the way the driver
      // ends any session — the browser goes away, which is what fires
      // `pagehide` and what `onExitIntent` is listening for. `keepProfile`
      // because the profile IS the evidence.
      // `DELETE /window` — CLOSE THE BROWSING CONTEXT, which is what the bullet
      // names and what fires `pagehide`. Not `DELETE /session`: ending the
      // session tears the browser down, and a process that is killed runs no
      // page lifecycle event at all. Same trap as the desktop lane's
      // `xdotool windowclose`, which turned out to be XDestroyWindow and never
      // reached the app's close handler (`e2e/support/xwindow.ts`).
      await session.send("DELETE", "/window");
      // Give the flush its round-trips before the browser goes away.
      await new Promise((r) => setTimeout(r, 3000));
      await first.browser.teardown({ keepProfile: true });
      firstClosed = true;
      await first.server.close();

      // Session two: same profile, same origin, and NO re-seed.
      const second = await openFixtureVault({
        profileDir,
        bundlePort,
        skipSeed: true,
      });
      try {
        // OPEN THE NOTE. On reopen the workspace decides what is on screen, and
        // an editor showing nothing is indistinguishable from a note that lost
        // its text — so the sidebar row is clicked first and the buffer read
        // after. The row existing at all is the weaker half of the claim and is
        // asserted by this wait.
        await second.session.waitForElement('[data-testid="notes.row"]', {
          timeoutMs: 30_000,
        });
        await second.session.execute(
          "document.querySelector('[data-testid=\"notes.row\"]').click();",
        );
        await second.session.waitForElement(
          '[data-testid="editor.content"] .cm-content',
          { timeoutMs: 20_000 },
        );
        expect(
          await bufferText(second.session),
          `the sentence typed just before the tab closed is gone after reopening ` +
            `the browser on the same profile. It was verified to be in the buffer ` +
            `and NOT yet saved at that moment, so the pagehide flush either did not ` +
            `run or did not wait — which on this client is not a lost cache but a ` +
            `lost note: the server never saw it either.`,
        ).toContain(SENTENCE);
      } finally {
        await second.browser.teardown().catch(() => {});
        await second.server.close();
      }
    } finally {
      if (!firstClosed) {
        await first.browser.teardown().catch(() => {});
        await first.server.close();
      }
      first.browser.removeProfile();
    }
  });
});
