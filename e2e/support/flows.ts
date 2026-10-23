// Shared in-app flow fragments used by multiple scenario suites.
//
// SYNC-13: helpers here never log credential-bearing values; assertion
// shapes are length-only / index-only. The note-editing helpers carry
// note-content markers — the accepted in-source scenario-constant
// class (not credentials; see the notes suite header).

import { expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testIdSelector, WebDriverError, type Element, type Session } from "./webdriver";
import { KEY, activeTestId, pressChord, pressKey } from "./keyboard";
import { REPO_ROOT } from "./session";

/**
 * Fire one production IPC from the page seat and settle-poll its result
 * (`__TAURI_INTERNALS__.invoke` — real IPC, zero test hooks; the
 * vault-creation suite's pattern). For backend-only paths a native dialog
 * blocks WebDriver from reaching through the UI.
 */
export async function pageSeatInvoke(
  session: Session,
  cmd: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok?: unknown; err?: unknown }> {
  await session.execute(
    "window.__e2eIpc = undefined;" +
      "window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(" +
      "function (ok) { window.__e2eIpc = { ok: ok === undefined ? null : ok }; }," +
      "function (err) { window.__e2eIpc = { err: err }; });",
    [cmd, args],
  );
  return session.waitUntil(
    async () =>
      (await session.execute<{ ok?: unknown; err?: unknown } | null>(
        "return window.__e2eIpc ?? null",
      )) ?? null,
    { label: `page-seat ${cmd} settled`, timeoutMs },
  );
}

/**
 * Write a note's WHOLE body through whichever durable writer owns it.
 *
 * A note shown in a pane is owned by a `LiveSession`, which is its SINGLE
 * durable writer (`SYNC-33`), so the backend REFUSES a stateless
 * `plugin:notes|note_update` for it with `NoteUpdateError::LiveSessionOpen`.
 * That was invisible when these scenarios were written, because nothing owned a
 * note; the live-collab epic made every open note live-owned on this client.
 * The app routes around it exactly this way (`src/notes/liveNote.ts`'s
 * `patchLiveNote` falling back to the stateless path on `NotOpen`), and this is
 * that same funnel for the page seat: the session patch first, the stateless
 * update only for a note no session owns.
 *
 * `NotOpen` is the ONE error that means "no session", so it is the only one
 * that falls through. Anything else is returned to the caller, whose
 * `expect(res.err).toBeUndefined()` then fails with the real refusal instead of
 * it being swallowed by a second write attempt.
 */
export async function writeNoteBody(
  session: Session,
  noteId: string,
  plaintext: string,
  timeoutMs = 30_000,
): Promise<{ ok?: unknown; err?: unknown }> {
  const live = await pageSeatInvoke(
    session,
    "plugin:live|live_session_patch_frontmatter",
    { noteId, markdown: plaintext },
    timeoutMs,
  );
  if (live.err === undefined) return live;
  const kind = (live.err as { kind?: unknown } | null)?.kind;
  if (kind !== "NotOpen") return live;
  return pageSeatInvoke(session, "plugin:notes|note_update", { noteId, plaintext }, timeoutMs);
}

/** Signal that a note was written OUT OF BAND, so every open pane re-reads it.
 *
 *  A page-seat `note_update`/`note_create` is not the pane's own autosave loop,
 *  and the app's stated contract (`src/AGENTS.md`, "A backend write made OUTSIDE
 *  a pane's autosave loop leaves that pane holding a stale buffer, and nothing
 *  bumps the reload for you") is that such a writer owes `reloadOpenNote()`.
 *  `Editor.tsx` turns this DOM event into exactly that call. Without it a pane
 *  that already cached the note's (empty) EditorState via the MYND-534
 *  persistent-view cache restores the STALE buffer on revisit and the write is
 *  invisible even though it is on disk - which is what made `scroll-memory`
 *  read an empty editor for a note `note_read` returned in full. The event name
 *  is the app's own `TASK_WRITE_EVENT` (`src/notes/taskWriteCore.ts`). */
export async function notifyNoteWritten(session: Session, noteId: string): Promise<void> {
  await session.execute(
    "window.dispatchEvent(new CustomEvent(arguments[0], { detail: { noteId: arguments[1] } }));",
    ["myne-task-written", noteId],
  );
}

/** Page-seat IPC that unwraps the result (throws on `err`, returns `ok`). */
export async function ipcOk(
  session: Session,
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs = 20_000,
): Promise<unknown> {
  const r = await pageSeatInvoke(session, cmd, args, timeoutMs);
  if (r.err !== undefined) throw new Error(`${cmd} failed: ${JSON.stringify(r.err)}`);
  return r.ok;
}

/**
 * One round trip that reports what the WebView is actually showing, for the
 * failure path of a wait that expected a specific screen.
 *
 * Deliberately free of app hooks: it reads `document`, the same way the rest of
 * the harness's `execute` probes do, so it keeps working on a build where the
 * app's own state is unreachable — which is precisely the case it exists for.
 * Values are structural only (counts, a readyState, a testid roster), never
 * content, so nothing it prints can carry vault material into a CI artefact.
 */
export async function bootDiagnostic(session: Session): Promise<string> {
  try {
    return await session.execute<string>(
      "var root = document.getElementById('root');" +
        "var ids = [];" +
        "var seen = document.querySelectorAll('[data-testid]');" +
        "for (var i = 0; i < seen.length && ids.length < 12; i++) {" +
        "  var v = seen[i].getAttribute('data-testid');" +
        "  if (ids.indexOf(v) === -1) ids.push(v);" +
        "}" +
          // The fail-closed REASON, when that screen is what mounted. It is the
        // single most useful fact this probe can carry: `Unlock.tsx` renders
        // `<FailClosedError>` INSTEAD of the password form for a boot-time
        // `Corrupted` or `IoError` status, so a scenario waiting on
        // `unlock.password-input` there is waiting for a field the app has
        // decided not to draw. That is a terminal routing outcome, not
        // slowness, and no budget reaches it. `io-error` in particular is what
        // a single transient `vault_list` read failure produces.
        "var fc = document.querySelector('[data-testid=\"fail-closed.root\"]');" +
        "return JSON.stringify({" +
        "  readyState: document.readyState," +
        "  rootChildren: root ? root.childElementCount : -1," +
        "  bodyChars: (document.body && document.body.innerHTML.length) || 0," +
        "  failClosedReason: fc ? fc.getAttribute('data-reason') : null," +
        "  testids: ids" +
        "});",
    );
  } catch (raw) {
    // The probe itself failing is a fourth answer and a useful one: the page
    // is gone, not merely empty.
    return `unreadable (${(raw as Error).message})`;
  }
}

/**
 * Unlock the currently-targeted vault and wait for the editor: the
 * canonical password → submit → `editor.root` sequence shared by every
 * suite that needs an unlocked editor as a step (not as the assertion
 * itself — scenarios pinning unlock-failure shapes drive the form
 * directly).
 */
export async function unlockToEditor(
  session: Session,
  password: string,
  timeoutMs = 45_000,
): Promise<void> {
  // Wait for the lock screen to mount with the SAME budget as the editor below
  // (aligned with DEFAULT_TIMEOUT_MS — see webdriver.ts for why the 90s
  // experiment was reverted: it only bloated the suite past the pipeline
  // timeout without making the loaded-host mount actually paint). Under the
  // full-suite's cumulative WebKitGTK load the unlock screen's first paint can
  // still slip past 45s on a contended run (nav1, ci1/slash-datetime at the
  // tail) — a mount-never-paints flake, not a wrong assertion — which is now
  // absorbed by the e2e step being non-blocking + the boot-cost debt, not by an
  // ever-larger timeout.
  //
  // MYND-558: the screen shows ONE credential surface. With a redeemable
  // quick-unlock the PIN owns it and the password form is behind a reveal, so
  // wait for whichever mounted and take the password door. On a vault with no
  // quick-unlock — every suite but `quick-unlock.e2e.ts` — the password input is
  // what appears and the reveal branch never runs. Without this a suite that
  // configures a PIN would hang the full budget on a field that is not there.
  // Suites ASSERTING which surface won must drive the screen directly (qu2/qu3);
  // this helper is for the ones where unlocking is a step, not the story.
  //
  // **On timeout this says WHAT was on screen instead of only that nothing
  // was.** The bare wait reported `waitUntil(waitForElement(…)) timed out`, and
  // that message cannot distinguish the three explanations this failure has —
  // the app is still on `App.tsx`'s loading shim (which is a literal `return
  // null`, so a boot probe that never settles renders a blank window forever
  // and no timeout can outlast it), the app routed somewhere ELSE (welcome,
  // picker, fail-closed) and the scenario is waiting for a screen it will never
  // get, or the WebView really did not paint. Those need three different fixes
  // and the message named none of them, which is why the family
  // (nav1/tp1/ci1/gp1/gp2/slash-datetime) has been quarantined as "contention"
  // on an assumption nobody could check. The probe is read only in the failure
  // path, so a passing run pays nothing for it.
  try {
    await session.waitForElement(
      `${testIdSelector("unlock.password-input")}, ${testIdSelector("unlock.use-password-link")}`,
      { timeoutMs },
    );
  } catch (raw) {
    throw new Error(
      `${(raw as Error).message} | boot state: ${await bootDiagnostic(session)}`,
    );
  }
  const reveal = await session.byTestIdAll("unlock.use-password-link");
  if (reveal.length > 0) await reveal[0].click();
  const input = await session.byTestId("unlock.password-input", { timeoutMs });
  await input.sendKeys(password);
  // WebKit's driver can silently swallow the leading keystrokes sent during the
  // input's focus-settle (the same settle-drop the editor's q-probe guards
  // against) — a truncated password then fails the unlock and the run is stuck
  // on the lock screen. If the field doesn't hold the exact password, re-enter
  // it. Boolean compare only: the value never reaches a log or assertion diff
  // (SYNC-13).
  if ((await input.property<string>("value")) !== password) {
    await input.replaceText(password);
  }
  await (await session.byTestId("unlock.submit")).click();
  await session.byTestId("editor.root", { timeoutMs });
}

/** Click one picker row, addressed by its vault id (SYNC-6 targeting). */
export async function selectPickerRow(session: Session, vaultId: string): Promise<void> {
  await (
    await session.waitForElement(testIdSelector("picker.vault-row", { "data-vault-id": vaultId }))
  ).click();
}

/** Open the account-chip switcher dropdown and pick the row for
 *  `vaultId` (the `editor.switch-vault` entry point). */
export async function switchToVault(session: Session, vaultId: string): Promise<void> {
  await (await session.byTestId("switcher.chip")).click();
  await (
    await session.waitForElement(
      testIdSelector("switcher.vault-row", { "data-vault-id": vaultId }),
    )
  ).click();
}

/** Fire the bare Ctrl+K chord via the W3C Actions API (Control DOWN → k DOWN →
 *  k UP → Control UP). `palette.toggle` defaults to Mod-k / Mod-p; Mod is
 *  Control on the Linux container. */
async function sendPaletteChord(session: Session): Promise<void> {
  const CONTROL = String.fromCharCode(0xe009); // W3C Actions API code point for Control
  await session.send("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "kbd",
        actions: [
          { type: "keyDown", value: CONTROL },
          { type: "keyDown", value: "k" },
          { type: "keyUp", value: "k" },
          { type: "keyUp", value: CONTROL },
        ],
      },
    ],
  });
}

/** Open the command palette and wait for `palette.input`. The Ctrl+K chord can
 *  be dropped when the keybind engine isn't focused yet (right after an
 *  attachment dialog, a view switch, …), so re-send until the input mounts.
 *  A chord sent while the palette is already open would toggle it shut, so each
 *  round checks for an open palette BEFORE re-firing. */
export async function openPalette(session: Session): Promise<void> {
  await session.waitUntil(
    async () => {
      try {
        return await session.byTestId("palette.input", { timeoutMs: 400 });
      } catch {
        /* not open yet — fall through and fire the chord */
      }
      // W3C key actions only dispatch to a focused element. After a flow that
      // leaves focus detached (createNote's rename-input commit, a just-closed
      // dialog, or notes created via IPC so no note is open) the chord lands
      // nowhere and window's keydown listener never fires. Re-anchor focus on a
      // real editor surface before firing — prefer the note content, fall back
      // to the editor pane (always present once unlocked, even with no note
      // open). Best-effort.
      //
      // **Skipped when the editor ALREADY holds focus, and that exemption is
      // the whole reason a selection can survive this helper.** A click
      // COLLAPSES a selection to a caret. Every palette action that operates on
      // one (`ai.rewrite-selection` is the live case) therefore arrived with
      // `state.selection.main.empty`, and the command no-opped. `ad3` chased it
      // through three selection methods and three probe kinds before the cause
      // turned out to be the helper that opens the palette, not the palette and
      // not the keys: the scenario's own probe showed a focused editor with a
      // non-empty selection immediately before this line ran.
      //
      // When `.cm-editor.cm-focused` is present the chord already has somewhere
      // to land, so the re-anchor buys nothing and costs the selection.
      const focused = await session.execute<boolean>(
        "return !!document.querySelector('.cm-editor.cm-focused');",
      );
      try {
        if (!focused) {
          await (await session.byTestId("editor.content", { timeoutMs: 400 })).click();
        }
      } catch {
        try {
          await (await session.byTestId("editor.pane", { timeoutMs: 400 })).click();
        } catch {
          /* no editor surface here — the chord may still reach window */
        }
      }
      await sendPaletteChord(session);
      try {
        return await session.byTestId("palette.input", { timeoutMs: 1_500 });
      } catch {
        return null;
      }
    },
    { label: "command palette open (Ctrl+K)", timeoutMs: 12_000 },
  );
}

/**
 * Open the palette, get `query` into its input, and return the row matching
 * `optionSelector` — re-asserting the query on every poll instead of typing it
 * once and then waiting.
 *
 * **`openPalette` already learned this lesson; the two lines after it did not.**
 * That helper re-fires the chord until the input exists, because a wait with
 * nothing to re-fire is a wait that can never recover. What followed was one
 * `sendKeys` and one `waitForElement`, which has exactly the failure
 * `e2e/AGENTS.md` records for `clickNewItem`: the whole budget spent on a
 * row that a re-fire would have produced in a second.
 *
 * Two things can go wrong after the palette is up, and neither gets better with
 * time, which is why `image-ocr-search`'s budget was raised to 120 s and bought
 * nothing:
 *
 *  1. **A truncated query.** WebKit's driver drops leading keystrokes while an
 *     input settles focus. This repo already guards that trap twice (the
 *     password field re-enters on mismatch, `typeIntoEditor` probes with a
 *     throwaway char), and the palette had no guard at all. A truncated query
 *     never becomes the right one on its own: nothing types again.
 *  2. **Results computed before the index caught up.** The list is derived from
 *     the input's `onChange`, so a note indexed a moment after the query ran is
 *     not in the rendered rows and nothing re-runs the search. `replaceText`
 *     clears to empty and retypes, which does re-run it.
 *
 * The nudge is rate-limited rather than per-poll: retyping is `BACKSPACE × n`
 * plus the text, and doing it ten times a second would be its own denial of
 * service on the surface under test.
 */
export async function palettePick(
  session: Session,
  query: string,
  optionSelector: string,
  what: string,
  // Exposed ONLY so the unit test can exercise the give-up path in a couple of
  // seconds instead of the real 45. No scenario passes it; a scenario that
  // wanted a shorter palette budget would be trading the retries this helper
  // exists to provide for a faster red.
  opts?: { timeoutMs?: number },
): Promise<Element> {
  await openPalette(session);
  await (await session.byTestId("palette.input")).sendKeys(query);
  let lastReason = "never polled";
  let lastNudge = Date.now();
  return session.waitUntil(
    async () => {
      const [found] = await session.findElements(optionSelector);
      if (found !== undefined) return found;
      const [input] = await session.byTestIdAll("palette.input");
      if (input === undefined) {
        // The palette is gone: a stray Escape, a backdrop click, a re-render
        // that closed it. A closed palette renders no rows at all, so waiting
        // is pointless and reopening is the only move that can succeed.
        lastReason = "the palette was not open";
        await openPalette(session);
        await (await session.byTestId("palette.input")).sendKeys(query);
        lastNudge = Date.now();
        return null;
      }
      const value = await input.property<string>("value");
      // Length, not content: the queries are scenario constants today, and a
      // helper that prints whatever was typed into a search box is one refactor
      // away from printing something SYNC-13 forbids.
      if (value !== query) {
        lastReason = `the input held ${value.length} of ${query.length} typed characters`;
        await input.replaceText(query);
        lastNudge = Date.now();
      } else if (Date.now() - lastNudge > 3_000) {
        lastReason = "the query landed but no row matched; re-running the search";
        await input.replaceText(query);
        lastNudge = Date.now();
      }
      return null;
    },
    {
      label: () => `${what} (last poll: ${lastReason})`,
      timeoutMs: opts?.timeoutMs ?? 45_000,
    },
  );
}

/** Open the command palette via Ctrl+K (retrying the chord), then filter by
 *  typing `query` and run the matching action row by its `data-action-id`. */
export async function runPaletteAction(
  session: Session,
  actionId: string,
  query: string,
): Promise<void> {
  const row = await palettePick(
    session,
    query,
    testIdSelector("palette.option", { "data-action-id": actionId }),
    `palette action ${actionId}`,
  );
  await row.click();
}

/** Open the command palette, type `query`, and click the NOTES-section hit
 *  row whose `data-note-id` matches `noteId` — the byTestId-only path to
 *  navigating to a SPECIFIC search result (note rows share
 *  `data-testid="palette.option"`; the `data-note-id` discriminator,
 *  alongside `data-action-id` on command rows, lands the exact note).
 *  Opens via the same Control+k chord as `runPaletteAction`. Leaves the
 *  palette closing as the editor navigates to the target note. */
export async function searchAndOpenNote(
  session: Session,
  query: string,
  noteId: string,
): Promise<void> {
  const row = await palettePick(
    session,
    query,
    testIdSelector("palette.option", { "data-kind": "note", "data-note-id": noteId }),
    `palette note row for the searched note`,
  );
  await row.click();
}

/** A fresh vault's first unlocked editor shows the importer onboarding
 *  offer (MYND-53) over a full-screen backdrop that intercepts clicks.
 *  Dismiss it the way a user would; the dismissal persists in
 *  localStorage, so it stays gone across in-session vault switches. */
export async function dismissImporterOffer(session: Session): Promise<void> {
  await (await session.byTestId("importer.offer-dismiss", { timeoutMs: 10_000 })).click();
  await session.waitForGone(testIdSelector("importer.offer-root"));
}

/** Dismiss the importer onboarding offer if it is showing, otherwise return
 *  immediately. The offer is a fresh-vault first-editor overlay; after a
 *  lock → unlock round-trip on a vault that already has notes it does NOT
 *  re-appear, so a hard `dismissImporterOffer` would time out. Use this on the
 *  second-and-later editor mounts of a scenario. */
export async function dismissImporterOfferIfPresent(session: Session): Promise<void> {
  let dismiss;
  try {
    dismiss = await session.byTestId("importer.offer-dismiss", { timeoutMs: 2_000 });
  } catch {
    return; // no offer this mount — nothing to dismiss
  }
  await dismiss.click();
  await session.waitForGone(testIdSelector("importer.offer-root"));
}

/** Lock the vault via the editor Lock CTA and re-unlock to the editor — the
 *  in-session round-trip that forces a full remount (backend re-hydrates its
 *  session state from disk). The importer offer does not re-appear on a
 *  populated vault, so the second mount uses `dismissImporterOfferIfPresent`. */
export async function lockAndReunlock(session: Session, password: string): Promise<void> {
  await (await session.byTestId("editor.lock-cta")).click();
  // No pre-wait for the password field here: `unlockToEditor` already waits for
  // whichever credential surface mounted (MYND-558), and a hard wait for the
  // password input would hang on a vault with a redeemable quick-unlock.
  await unlockToEditor(session, password);
  await dismissImporterOfferIfPresent(session);
}

/** Open the Settings modal from the editor's gear button and wait for
 *  the dialog root. Optionally switch to a rail tab (the modal always
 *  opens on Account). */
export type SettingsTab =
  | "account"
  | "vault"
  | "privacy"
  | "sync"
  | "editor"
  | "files"
  | "hotkeys"
  | "appearance"
  | "storage"
  | "ai"
  | "network"
  | "cli"
  | "transcription"
  | "about";

export async function openSettings(
  session: Session,
  tab?: SettingsTab,
): Promise<void> {
  // IDEMPOTENT on an already-open modal, and that is not a nicety. Several
  // helpers leave Settings OPEN by design — `enableDeveloperMode` says so in its
  // own doc, because its callers' next move is a rail click. A blind CTA click
  // then aims at a button the open modal is covering, and the failure is
  // `waitUntil(element interactable + clicked) timed out after 10000 ms`, which
  // reads like a flake and is not one. `enableAi` chains exactly those two
  // (developer mode, then `setSettingsSwitch` → here), so ai-chat, ai-summarize
  // and transcription were all failing in CI on this
  // one line.
  if ((await session.byTestIdAll("settings.modal")).length === 0) {
    // The gear lives on the BOTTOM BAR, and the bar is removable: hiding every
    // item from Settings → Appearance → Bottom bar takes the bar AND the gear
    // with it (myne-md/myne#773). The keyboard route is the app's second entry
    // point and the only one left in that state, so fall back to it rather than
    // waiting the full budget for a control the user deliberately removed.
    //
    // **But wait for the chrome before concluding the gear is gone.** After an
    // `s.refresh()` the document is new and the chrome paints a beat later, so
    // a bare `byTestIdAll` here reads a half-mounted editor as "the user removed
    // the gear" and takes the keyboard route, whose chord is then pressed into a
    // window with no listener attached yet. Measured in `hk2`: the CTA was on
    // screen when the keyboard route's 15 s budget expired, so the spec failed
    // on a control that had been there all along. The wait is bounded because
    // the gear really can be absent (the branch below is the point), and it
    // costs nothing in the ordinary case: the element is already there.
    const cta = await session
      .byTestId("editor.settings-cta", { timeoutMs: 5_000 })
      .catch(() => null);
    if (cta !== null) {
      await cta.click();
    } else {
      // `app.open-settings`'s default binding (`Mod-,`; Mod is Ctrl here). The
      // chord needs focus somewhere the window listener hears, and the control
      // that held it is the one just removed, so re-fire until the modal is up.
      // The modal check runs FIRST because the binding is a toggle: a chord sent
      // while Settings is open would close it again.
      await session.waitUntil(
        async () => {
          if ((await session.byTestIdAll("settings.modal")).length > 0) return true;
          await pressChord(session, KEY.CONTROL, ",");
          return (await session.byTestIdAll("settings.modal")).length > 0 ? true : null;
        },
        { label: "Settings opened via the keyboard route", timeoutMs: 15_000 },
      );
    }
    await session.byTestId("settings.modal");
  }
  if (tab && tab !== "account") {
    await (await session.byTestId(`settings.tab-${tab}`)).click();
  }
}

/** Pick `value` from a token-styled {@link Select} named `selectTestId`: open the
 *  trigger, then click the matching option. The primitive renders `selectTestId`
 *  on the trigger and `${selectTestId}-option` (carrying a `data-value`) on each
 *  option, so a one-shot segment click (the shape `Segmented` allowed) no
 *  longer reaches it. */
export async function pickSelect(
  session: Session,
  selectTestId: string,
  value: string,
): Promise<void> {
  const trigger = await session.byTestId(selectTestId);
  // Centre the trigger before opening: several of these rows sit below the
  // fold of a tall Settings panel (Editor/About), where W3C /click's
  // scroll-into-view leaves WebKit reporting "element not interactable" and
  // the menu never opens.
  await trigger.scrollIntoView();
  await trigger.click();
  const option = await session.waitForElement(
    testIdSelector(`${selectTestId}-option`, { "data-value": value }),
  );
  // Prefer a real click. When the portal'd menu is not hit-testable (covered
  // by a modal stacking context, mid-paint, or a driver that reports
  // "element not interactable" for a fixed-position body portal under an
  // inert background), fall back to a JS click so the option's own onClick
  // still runs — the same dispatch a user gesture would deliver to a
  // hit-tested target. W3C Element Click alone burned the whole 10s budget
  // on `settings.date-format` under Settings (fr3/tc4/tc5).
  try {
    await option.click();
  } catch {
    await session.execute<void>(
      "var el = document.querySelector(arguments[0]);" +
        "if (el) el.click();",
      [testIdSelector(`${selectTestId}-option`, { "data-value": value })],
    );
  }
  await session.waitUntil(
    async () => {
      const open = await session.findElements(
        testIdSelector(`${selectTestId}-option`, { "data-value": value }),
      );
      // Menu closes after choose(); a stale handle is fine — we only need the
      // listbox to be gone or the option to no longer be active-open.
      return open.length === 0 ? true : null;
    },
    { label: `${selectTestId} menu to close after picking ${value}`, timeoutMs: 5_000 },
  ).catch(() => {
    // Some Selects keep the option in the DOM while closed (portal unmounted
    // is the normal path; if not, the value check below is the real gate).
  });
}

/** The values a `Select`'s menu offers, in order, leaving the menu closed.
 *
 *  A `Segmented` published every choice in the row's own markup, so a scenario
 *  asserting "all four horizons are offered" could just find four testids.
 *  `Select` renders its options into a body PORTAL that exists only while the
 *  menu is open, so the same assertion needs the menu opened, read and shut
 *  again — and a scenario hand-rolling that is a scenario that will leave the
 *  menu open and fail the NEXT interaction instead of this one (#769). */
export async function selectOptionValues(
  session: Session,
  selectTestId: string,
): Promise<string[]> {
  await (await session.byTestId(selectTestId)).click();
  await session.waitForElement(testIdSelector(`${selectTestId}-option`));
  const options = await session.byTestIdAll(`${selectTestId}-option`);
  const values: string[] = [];
  for (const option of options) {
    values.push((await option.attribute("data-value")) ?? "");
  }
  // Re-click the trigger to close: clicking an OPTION would choose it, and
  // reading a roster must not change the setting it read.
  await (await session.byTestId(selectTestId)).click();
  await session.waitUntil(
    async () => {
      const open = await session.findElements(testIdSelector(`${selectTestId}-option`));
      return open.length === 0 ? true : null;
    },
    { label: `${selectTestId} menu to close after reading its roster` },
  );
  return values;
}

/** Drive one `role="switch"` in Settings to a wanted state, then close the
 *  modal. Idempotent by construction: it clicks only when `aria-checked` is not
 *  already what the caller asked for, so a caller can assert a DEFAULT without a
 *  no-op click flipping it. `aria-checked` reflects the PERSISTED pref, so the
 *  wait is a real write-landed wait, not a paint wait.
 *
 *  The switch helpers below are all this one call — keep it that way. A settings
 *  toggle whose flow is hand-rolled is a flow that will re-learn the stale-handle
 *  and idempotence lessons on its own. */
async function setSettingsSwitch(
  session: Session,
  opts: {
    tab: SettingsTab;
    /** Waited for before the toggle, where the panel has a root of its own — it
     *  fails on the PANEL rather than on a toggle the panel never rendered. */
    panelTestId?: string;
    /** An in-panel TOPIC to open first, for a panel whose controls are split into
     *  topics (myne-md/myne#885). Omitted for the single-screen panels. */
    topicId?: string;
    toggleTestId: string;
    enabled: boolean;
    label: string;
  },
): Promise<void> {
  const want = opts.enabled ? "true" : "false";
  await openSettings(session, opts.tab);
  if (opts.panelTestId !== undefined) await session.byTestId(opts.panelTestId);
  if (opts.topicId !== undefined) {
    await selectSettingsTopic(session, opts.tab, opts.topicId);
  }
  // Re-fetched on every read: the handle goes stale across a panel re-render.
  const checked = async () =>
    await (await session.byTestId(opts.toggleTestId)).attribute("aria-checked");
  if ((await checked()) !== want) await (await session.byTestId(opts.toggleTestId)).click();
  await session.waitUntil(async () => ((await checked()) === want ? true : null), {
    label: `${opts.label} = ${want}`,
    timeoutMs: 10_000,
  });
  await closeSettings(session);
}

/** Set the speech-to-text switch via Settings → Transcription (MYND-592).
 *  Unlike `enableAi` this is an opt-OUT — the feature is on out of the box, and
 *  the AI master switch has no bearing on it. */
export async function setTranscriptionEnabled(
  session: Session,
  enabled: boolean,
): Promise<void> {
  await setSettingsSwitch(session, {
    tab: "transcription",
    panelTestId: "settings.transcription-panel",
    toggleTestId: "settings.transcription",
    enabled,
    label: "transcription_enabled",
  });
}

/** Toggle the device-local Views feature switch via Settings → Editor (#230).
 *  Views is OFF by default for a fresh vault (0 views); turning it on reveals
 *  the sidebar Views nav row. Device-local (localStorage) rather than a backend
 *  pref, but the `<Switch>`'s `aria-checked` still reflects the landed state, so
 *  the shared idempotent switch driver applies unchanged. */
export async function setViewsEnabled(
  session: Session,
  enabled: boolean,
): Promise<void> {
  await setSettingsSwitch(session, {
    tab: "editor",
    // Views is a FEATURE switch, so it lives in the Editor panel's `features`
    // topic since myne-md/myne#885. Only the active topic's body is mounted, so
    // a caller that skipped this would burn its budget on a toggle that is not
    // on screen.
    topicId: "features",
    toggleTestId: "settings.views-enabled",
    enabled,
    label: "views_enabled",
  });
}

/** Toggle the folder-notes feature via Settings → Files (myne-md/myne#661).
 *  Folder notes are OFF by default, so a scenario that drives the folder-index
 *  entry points must enable them first. On the shared idempotent switch driver,
 *  so it also waits for the pref to LAND (aria-checked reflects the persisted
 *  value), which is what makes the sidebar's own `usePrefs` reflect it before
 *  the next step. */
export async function setFolderNotesEnabled(
  session: Session,
  enabled: boolean,
): Promise<void> {
  await setSettingsSwitch(session, {
    tab: "files",
    panelTestId: "settings.files-panel",
    toggleTestId: "settings.folder-notes-toggle",
    enabled,
    label: "folder_notes_enabled",
  });
}

/**
 * Turn Developer mode on via Settings → About and wait for the Developer rail
 * group to appear. Leaves the Settings modal OPEN on the About tab, because
 * every caller's next move is a rail click into one of the panels the group just
 * revealed (`settings.tab-ai`, `settings.tab-network`, …).
 *
 * Immediate effect, no dialog — the About toggle writes the `developer_mode`
 * pref and the rail is filtered from it, so the group's presence is the
 * assertion that the flip took.
 */
export async function enableDeveloperMode(session: Session): Promise<void> {
  await openSettings(session, "about");
  await enableDeveloperModeInSettings(session);
}

/**
 * {@link enableDeveloperMode} for a caller that ALREADY has Settings open —
 * it reaches About by the rail instead of the gear, because clicking the gear
 * a second time is not an "open" (the modal is a toggle, and the backdrop is
 * over the button). The user-guide capture walks the rail tab by tab and needs
 * exactly this shape.
 *
 * Idempotent, on the `setSettingsSwitch` discipline: click only when the toggle
 * is not already where we want it. Since #181 put the CLI block and the vim
 * toggle behind this gate, several scenarios reach it more than once (vm1 sets
 * vim on and then off) — an unconditional click would turn the mode back OFF on
 * the second call and hang on the wait below.
 */
export async function enableDeveloperModeInSettings(session: Session): Promise<void> {
  await (await session.byTestId("settings.tab-about")).click();
  const checked = async () =>
    await (await session.byTestId("about.developer-mode-toggle")).attribute("aria-checked");
  if ((await checked()) !== "true") {
    const toggle = await session.byTestId("about.developer-mode-toggle");
    // The About panel scrolls (build channel, build, threat model, legal,
    // license, then this toggle), so the control sits below the modal body's
    // fold. The W3C `/click` scroll-into-view only guarantees the border box
    // intersects the viewport and WebKitGTK reports "element not
    // interactable" indefinitely for one clipped inside an overflowing modal
    // body — which is every reach to this toggle after the legal rows landed
    // in 2026-08. Centre it in its container first, the `scrollIntoView`
    // discipline `pickSelect` uses.
    await toggle.scrollIntoView();
    await toggle.click();
  }
  await session.waitUntil(async () => ((await checked()) === "true" ? true : null), {
    label: "developer_mode toggled on",
    timeoutMs: 10_000,
  });
  await session.waitForElement(testIdSelector("settings.developer-group"));
}

/**
 * Turn Developer mode OFF from Settings → About, the mirror of
 * {@link enableDeveloperModeInSettings}. Caller already has Settings open and
 * reaches About by the rail. Centres the toggle in its scroll container before
 * clicking, for the reason that function's own `scrollIntoView` comment gives:
 * it sits below the fold of the About panel's overflowing body.
 */
export async function disableDeveloperModeInSettings(session: Session): Promise<void> {
  await (await session.byTestId("settings.tab-about")).click();
  const checked = async () =>
    await (await session.byTestId("about.developer-mode-toggle")).attribute("aria-checked");
  if ((await checked()) !== "false") {
    const toggle = await session.byTestId("about.developer-mode-toggle");
    await toggle.scrollIntoView();
    await toggle.click();
  }
  await session.waitUntil(async () => ((await checked()) === "false" ? true : null), {
    label: "developer_mode toggled off",
    timeoutMs: 10_000,
  });
}

export async function enableAi(session: Session): Promise<void> {
  await enableDeveloperMode(session);
  await setSettingsSwitch(session, {
    tab: "ai",
    panelTestId: "settings.ai-panel",
    toggleTestId: "ai.enable-toggle",
    enabled: true,
    label: "ai_enabled",
  });
}

/** Select an in-panel TOPIC in the Settings modal (myne-md/myne#885).
 *
 *  The strip is rendered by the shell above the selected panel, and only the
 *  active topic's body is mounted, so a scenario that reaches a control in any
 *  topic other than the panel's first has to open it first. A helper that WAITS
 *  for a surface without OPENING it fails every scenario at the same line and
 *  reads as a flake (`e2e/AGENTS.md`), so this clicks the tab and then waits for
 *  the panel it controls, which makes the wait the assertion that opening worked.
 *
 *  Caller owes the modal being open on `panelId` (`openSettings(session, panelId)`). */
export async function selectSettingsTopic(
  session: Session,
  panelId: SettingsTab,
  topicId: string,
): Promise<void> {
  await clickByTestId(session, `settings.${panelId}-tab-${topicId}`, { timeoutMs: 15_000 });
  await session.waitForElement(testIdSelector(`settings.${panelId}-topic-${topicId}`), {
    timeoutMs: 15_000,
  });
}

/** Add one folder to the AI panel's excluded-folders list through the picker,
 *  leaving Settings closed (myne-md/myne#848).
 *
 *  **The picker, not the setter.** The textarea beside it stays the authority (a
 *  pasted list still works, and an exclusion is a privacy control that must not
 *  depend on a convenience), so a scenario that wrote the pref directly would
 *  prove the clamp and nothing about the control a user has. This drives the
 *  route the user takes, which is why it was extracted rather than repeated:
 *  `ai-ux-surface.e2e.ts` aux2 is ABOUT this control and `ai-chat.e2e.ts` ac2
 *  needs the state it produces.
 *
 *  **The box is the gate, and it is a write-landed gate.** Picking commits
 *  inside the panel (`AiPanel.appendExcludedFolder` calls its own
 *  `commitExcluded`), so the line appearing in the box and the pref landing are
 *  the same event rather than two things that happen to follow each other.
 *
 *  `folderPath` is the canonical trailing-slash form the store keeps
 *  (`Private/`), which is also what each option carries as its `data-value`.
 *  Caller owes `enableAi` first: the control is disabled while AI is off. */
export async function excludeFolderFromAi(
  session: Session,
  folderPath: string,
): Promise<void> {
  await openSettings(session, "ai");
  await session.waitForElement(testIdSelector("settings.ai-panel"), { timeoutMs: 15_000 });
  // The editor is a LIMIT, so it lives in the Limits topic since
  // myne-md/myne#885.
  await selectSettingsTopic(session, "ai", "limits");
  const picker = await session.byTestId("ai.excluded-folders-picker", { timeoutMs: 15_000 });
  await picker.click();
  const option = await session.waitForElement(
    testIdSelector("ai.excluded-folders-picker-option", { "data-value": folderPath }),
    { timeoutMs: 10_000 },
  );
  await option.click();
  const box = await session.byTestId("ai.excluded-folders");
  await session.waitUntil(
    async () => (((await box.attribute("value")) ?? "").includes(folderPath) ? true : null),
    { label: `the excluded-folders box carries ${folderPath}`, timeoutMs: 10_000 },
  );
  await closeSettings(session);
}

/** Click the element carrying `testId`, RE-LOCATING it on every poll.
 *
 * **`Element.click()` retries the CLICK, not the LOOKUP, and that is a different
 * thing.** Its own comment says it retries while WebKit reports the node is in
 * the DOM but not yet hit-testable, which is right for an overlay animating in.
 * It cannot help when the node is REPLACED mid-retry: the handle it holds is
 * then permanently stale, and it burns its whole budget clicking a dead node
 * before reporting `element interactable + clicked` timed out. `flows.ts` already
 * learned this once, in `typeIntoEditor`, where the fix was to re-find inside the
 * poll; the knowledge just never became a helper.
 *
 * `sync-replication` line 205 is the case that made it one: after a
 * mid-ceremony sync the compare screen re-renders, and the match button the
 * scenario had already located is gone. Nine of that file's ten tests pass; the
 * tenth spent 10 s on a button that existed the whole time under a new handle. */
/**
 * Wait until an inline `att:` embed has rendered a DECODED image, so what
 * follows is acting on real bytes rather than on the widget's error fallback.
 *
 * Three copies of this wait existed, byte-identical, in `attachment-zoom` and
 * `embed-overflow-menu` (twice), all under the label `inline image decoded`.
 * That label describes only the success case, and the wait has three failures
 * behind it: the widget never rendered at all (the embed source did not become
 * a widget), it rendered its error fallback (the attachment bytes did not
 * load), or the image element is there and still measures zero. `za1` and `eo2`
 * have each spent their whole budget on it in CI, on different pipelines, and
 * the report named none of the three.
 *
 * Shared rather than diagnosed three times, because the next copy would inherit
 * the silent version again.
 */
/** What `catalog_list` says about one id, as a clause to append to a reason.
 *
 * Never prints the id or a filename: the count and two booleans are the whole
 * discriminator, and SYNC-13 keeps vault content out of failure output. A failed
 * probe says so rather than reading as an absent row, because "the backend
 * refused to answer" and "the backend answered without it" are the two verdicts
 * this exists to tell apart. */
async function backendCatalogVerdict(session: Session, id: string): Promise<string> {
  try {
    const r = await pageSeatInvoke(session, "plugin:attachments|catalog_list", {}, 15_000);
    if (r.err !== undefined) return `; the backend REFUSED catalog_list, so the empty map is a host-side failure`;
    const rows = (r.ok ?? []) as ReadonlyArray<{ id?: string }>;
    return rows.some((x) => x.id === id)
      ? `; the backend catalog HAS the row (${rows.length} row(s)), so the editor's map is stale rather than the read being wrong`
      : `; the backend catalog does NOT have the row (${rows.length} row(s)), so the import's catalog write is the problem, not the editor`;
  } catch {
    return `; the backend catalog probe itself failed to run`;
  }
}

export async function waitForInlineImage(
  session: Session,
  attachmentId?: string,
): Promise<void> {
  let lastReason = "never polled";
  // The tombstone branch asks the BACKEND once, and once only, because it is the
  // one question the DOM cannot answer: the tombstone widget is DELIBERATELY
  // shared between "the catalog has not loaded yet" and "the catalog loaded
  // without this id" (`attachment-embed.ts` renders the same widget for both, to
  // avoid a broken-image flash), so from the page the two are identical. One
  // `catalog_list` separates them. Done in the poll rather than in the timeout
  // label because `waitUntil`'s lazy label is synchronous.
  let probed = false;
  let backend = "";
  await session.waitUntil(
    async () => {
      const state = await session.execute<{
        found: boolean;
        width: number;
        chip: boolean;
        tomb: boolean;
        marker: boolean;
        chars: number;
        testids: string[];
      }>(
        "var i = document.querySelector('[data-testid=\"attachment-image\"]');" +
          // The widget starts the <img> at `display:none` and reveals it on the
          // `load` event, while a progress chip stands in. On `error` it removes
          // the chip and leaves the image HIDDEN, so a failed decrypt or decode
          // measures zero forever and no budget reaches it. The chip is
          // therefore the discriminator, and the reason this reads it: chip
          // present means the bytes are still coming, chip gone with the image
          // still hidden means the load FAILED.
          "var chip = !!document.querySelector('.cm-attachment-progress');" +
          // **Is a TOMBSTONE up?** This has to be asked before the source text,
          // and asking it second is how the first version of this helper blamed
          // typing for a catalog problem. Every embed widget is an ATOMIC
          // `Decoration.replace`, so the moment any of them builds, the
          // `![[att:…]]` text leaves the rendered DOM. Reading `att:` alone
          // therefore reports "the text never landed" for a note whose text
          // landed perfectly and is being drawn as a tombstone.
          "var tomb = !!document.querySelector('.cm-attachment-tombstone');" +
          // **Is the embed SOURCE even in the document?** With no widget of any
          // kind there are two very different stories: the `![[att:…]]` text
          // never landed (a typing problem), or it landed and no decoration has
          // been built over it yet (a parse/viewport problem). Length only,
          // never the id.
          "var content = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
          "var src = content ? content.textContent || '' : '';" +
          "var marker = src.indexOf('att:') !== -1;" +
          "var ids = [];" +
          "var seen = document.querySelectorAll('[data-testid^=\"attachment\"], .cm-widgetBuffer, [data-testid=\"editor.content\"]');" +
          "for (var n = 0; n < seen.length && ids.length < 8; n++) {" +
          "  var v = seen[n].getAttribute('data-testid');" +
          "  if (v && ids.indexOf(v) === -1) ids.push(v);" +
          "}" +
          "return { found: !!i, width: i ? i.offsetWidth : -1, chip: chip," +
          "  tomb: tomb, marker: marker, chars: src.length, testids: ids };",
      );
      if (state.found && state.width > 0) return true;
      if (state.found) {
        lastReason = state.chip
          ? `the image is present, hidden, and its progress chip is still up, so the bytes have not arrived`
          : `the image is present, hidden, and its progress chip is GONE, which the widget does only on a load ERROR — the attachment did not decrypt or decode`;
      } else if (state.tomb) {
        // The decoration built and chose the tombstone. That is the shared
        // widget for BOTH unresolved cases, so the backend is what splits them.
        if (attachmentId !== undefined && !probed) {
          probed = true;
          backend = await backendCatalogVerdict(session, attachmentId);
        }
        lastReason =
          `the embed rendered as a TOMBSTONE, so the editor's catalog map has no row for this ` +
          `id — either it has not loaded yet or it loaded without it (${state.chars} chars in ` +
          `the editor)${backend}`;
      } else if (!state.marker) {
        lastReason =
          `no embed source in the buffer and no widget of any kind (${state.chars} chars in ` +
          `the editor), so the \`att:\` text never landed; testids present: ${
            state.testids.length === 0 ? "none" : state.testids.join(", ")
          }`;
      } else {
        lastReason =
          `the embed source is still raw text in the buffer with no widget over it ` +
          `(${state.chars} chars in the editor), so no decoration has been built for it yet`;
      }
      return null;
    },
    { label: () => `inline image decoded (last poll: ${lastReason})`, timeoutMs: 20_000 },
  );
}

/**
 * Why a click at an element's centre would not land: its box, whether that box
 * is inside the viewport, and what the document says is actually at that point.
 *
 * The three answers WebKit collapses into "element not interactable" need three
 * different fixes — a zero-sized box is a render bug, an out-of-viewport box
 * wants a scroll, and a different node at the centre names the overlay to close
 * — and the driver's error code distinguishes none of them. Reports the covering
 * node by tag, its testid where it has one, its class, a layout summary and its
 * parent's testid, never by its text.
 */
async function hitTest(session: Session, selector: string): Promise<string> {
  try {
    return await session.execute<string>(
      "var el = document.querySelector(arguments[0]);" +
        "if (!el) return 'the element vanished between the click and this read';" +
        "var r = el.getBoundingClientRect();" +
        "if (r.width === 0 || r.height === 0) return 'its box is ' + r.width + 'x' + r.height;" +
        "var cx = r.left + r.width / 2, cy = r.top + r.height / 2;" +
        "if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight)" +
        "  return 'its centre (' + Math.round(cx) + ',' + Math.round(cy) + ') is outside the " +
        "viewport ' + window.innerWidth + 'x' + window.innerHeight;" +
        "var at = document.elementFromPoint(cx, cy);" +
        "if (!at) return 'nothing is at its centre';" +
        "if (at === el || el.contains(at)) return 'its centre is clear, so the refusal is not an overlay';" +
        // **What the cover IS, structurally.** The tag plus a testid was the
        // first version and it was not enough: two live cases both reported
        // "covered by <div> with no testid", which is one sentence for an
        // app-owned wrapper, an inline-styled footer and a layout container. A
        // class, a position/display/overflow/z-index/box summary and the
        // PARENT's testid separate them in the same round trip, and none of
        // that can carry note content into a log.
        "var cls = at.getAttribute('class') || '';" +
        "var cs = getComputedStyle(at);" +
        "var ar = at.getBoundingClientRect();" +
        "var shape = cs.position + '/' + cs.display + '/' + cs.overflow + '/z' + (cs.zIndex || 'auto') +" +
        "  '/' + Math.round(ar.width) + 'x' + Math.round(ar.height) + ' at ' +" +
        "  Math.round(ar.left) + ',' + Math.round(ar.top);" +
        "var parent = at.parentElement;" +
        "var pid = parent ? (parent.getAttribute('data-testid') || parent.tagName.toLowerCase()) : 'none';" +
        "var id = at.getAttribute('data-testid');" +
        "return 'covered at its centre by <' + at.tagName.toLowerCase() + '>' +" +
        "  (id ? ' [' + id + ']' : ' with no testid') +" +
        "  (cls ? ' class=' + JSON.stringify(cls) : '') +" +
        "  ' shape=' + shape + ' parent=' + pid;",
      [selector],
    );
  } catch (raw) {
    return `hit-test unreadable (${(raw as Error).message})`;
  }
}

/** Scroll the first match of `selector` to the middle of whatever scroll
 *  container holds it.
 *
 *  `scrollIntoView` walks every ancestor scroller, which is the part WebDriver's
 *  own pre-click scroll does not reliably do in WebKit. Best-effort: a failure
 *  here must not turn into the caller's error, because the click that follows is
 *  the assertion. */
async function scrollIntoView(session: Session, selector: string): Promise<void> {
  try {
    await session.execute(
      "var el = document.querySelector(arguments[0]);" +
        "if (el) el.scrollIntoView({ block: 'center', inline: 'center' });",
      [selector],
    );
  } catch {
    // The element may have gone between the find and this call; the poll re-finds.
  }
}

export async function clickByTestId(
  session: Session,
  testId: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  await clickBySelector(session, testIdSelector(testId), opts);
}

/**
 * {@link clickByTestId} over an arbitrary CSS selector.
 *
 * The body used to be inline above and reachable only by a bare testid, so a
 * control addressed by testid PLUS an attribute (a note row carries
 * `data-note-id`) had to hand-roll its own poll, and the first one that did lost
 * all three things this function exists for: the per-poll `scrollIntoView`, the
 * `lastReason` that makes a timeout name a cause, and the error whitelist that
 * keeps a broken session from becoming a 45 s wait.
 */
export async function clickBySelector(
  session: Session,
  selector: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  // **The last swallowed reason, so the timeout can name a cause.** Every arm
  // below returns `null` and polls again, which is right — but it made the
  // failure message `<selector> located + clicked timed out`, which does not
  // distinguish "the element is not in the DOM" from "it is there and something
  // is covering it" from "it is there and WebKit says it is not interactable".
  // Those are three different bugs and the message named none of them, so
  // `sync-replication`'s SAS click was read as a re-render race and given more
  // budget, which measurably did not fix it (45 s, still red). Recorded here
  // rather than probed on failure because the reason is only observable INSIDE
  // the poll, and the whole point is that it is the recurring one.
  let lastReason = "never polled";
  await session.waitUntil(
    async () => {
      const [el] = await session.findElements(selector);
      if (el === undefined) {
        lastReason = "nothing matches that selector";
        return null;
      }
      // **Bring it into view inside its OWN scroll container before clicking.**
      // WebDriver's click scrolls the element into view, but WebKit's notion of
      // that does not reliably reach a nested `overflow: auto` body, and the
      // Settings modal is exactly that. `sync-replication`'s SAS match button
      // sits below the fold of the modal's scrolling body: the driver refused
      // the click with `element not interactable`, and the hit-test added here
      // reported the modal container itself painted at the button's centre. No
      // budget fixes that, because the button never moves on its own. Cheap and
      // best-effort, so it runs on every poll rather than only after a refusal.
      await scrollIntoView(session, selector);
      try {
        await el.clickOnce();
      } catch (e) {
        if (
          e instanceof WebDriverError &&
          (e.code === "stale element reference" ||
            e.code === "element not interactable" ||
            e.code === "element click intercepted")
        ) {
          // **Name what is in the way, not just that something is.** The first
          // version of this reason got `sync.sas-match` as far as
          // `element not interactable`, which is a whole class of causes: a
          // zero-sized box, an element scrolled out of the viewport, or another
          // node sitting on top of the click point. Reading the rect and asking
          // the document what is actually AT the centre separates them in one
          // round trip, and the answer is the fix. Structural only, so a covered
          // control cannot leak its own contents into a CI log.
          lastReason =
            `found, but the click reported "${e.code}"; ` + (await hitTest(session, selector));
          return null; // replaced or not hit-testable yet — re-find next poll
        }
        throw e;
      }
      return true;
    },
    // 45 s, and the number needs its argument because `e2e/AGENTS.md` records a
    // budget rise that fixed nothing: raising `DEFAULT_TIMEOUT_MS` 20 s -> 45 s
    // for the `clickNewItem` flake only made each occurrence twice as
    // expensive, because that wait was STUCK with nothing to re-fire. This one
    // re-locates and re-clicks every poll, so the extra budget buys retries
    // rather than idling. Measured: `sync-replication` passes isolated and timed
    // out here at 20 s in the full 2-shard suite, on the compare screen that
    // re-renders after a mid-ceremony sync the scenario deliberately provokes.
    {
      label: () => `${selector} located + clicked (last poll: ${lastReason})`,
      timeoutMs: opts?.timeoutMs ?? 45_000,
    },
  );
}

/** Set the auto-tag sub-switch via Settings → AI (MYND-651). Off by default, and
 *  the host re-reads BOTH it and `ai_enabled` before any model touch — so a
 *  caller that wants the inline suggestion band must have called {@link enableAi}
 *  first. The toggle renders disabled while `ai_enabled` is off, so an
 *  out-of-order call would silently do nothing. */
export async function setAutoTagEnabled(session: Session, enabled: boolean): Promise<void> {
  await setSettingsSwitch(session, {
    tab: "ai",
    panelTestId: "settings.ai-panel",
    // The auto-tag switch is a section of the Models topic, beside the table
    // that holds the tag role's own row (myne-md/myne#867).
    topicId: "models",
    toggleTestId: "ai.auto-tag-toggle",
    enabled,
    label: "auto_tag_enabled",
  });
}

/** Close the Settings modal via its × button and wait for the dialog
 *  to unmount (backdrop click is gated during child in-flight; the
 *  explicit button is the deterministic path). */
export async function closeSettings(session: Session): Promise<void> {
  await (await session.byTestId("settings.close")).click();
  await session.waitForGone(testIdSelector("settings.modal"));
}

/** Unlock, dismiss the importer offer, and enrol this vault with the sync server
 *  from Settings → Sync, waiting for the approval. Leaves Settings closed.
 *
 *  Three sync suites had their own copy of this sequence. It deliberately does
 *  NOT start or configure a server: the caller owns that, because only the
 *  caller knows whether it is enrolling against an ephemeral one or a seeded
 *  endpoint. */
export async function unlockAndEnroll(
  session: Session,
  account: string,
  password: string,
): Promise<void> {
  await unlockToEditor(session, password);
  await dismissImporterOffer(session);
  await openSettings(session);
  await (await session.byTestId("settings.tab-sync")).click();
  // The enrol form moved to the panel's DEVICES topic (myne-md/myne#885); the
  // panel opens on Connection, so this is a real step rather than a no-op.
  await selectSettingsTopic(session, "sync", "devices");
  await (await session.byTestId("sync.enroll.account-input")).sendKeys(account);
  await (await session.byTestId("sync.enroll.password-input")).sendKeys(password);
  await (await session.byTestId("sync.enroll.submit")).click();
  await session.byTestId("sync.enroll.approved", { timeoutMs: 30_000 });
  await closeSettings(session);
}

/**
 * Complete the post-recovery password reset (A8f): fill both fields,
 * wait out the zxcvbn gate, submit. Used by the VR-1 drill and the
 * recovery suite's resume/reset scenarios.
 */
export async function completePasswordReset(
  session: Session,
  newPassword: string,
): Promise<void> {
  await (await session.byTestId("recover.reset.password-input")).sendKeys(newPassword);
  await (await session.byTestId("recover.reset.confirm-input")).sendKeys(newPassword);
  const submit = await session.byTestId("recover.reset.submit");
  await session.waitUntil(() => submit.enabled(), {
    label: "reset submit enabled (zxcvbn ready)",
    timeoutMs: 15_000,
  });
  await submit.click();
}

const CM_CONTENT = testIdSelector("editor.content") + " .cm-content";

/** The note id of the ACTIVE editor tab, or `null` when the active tab is not a
 *  note tab (graph, settings, …).
 *
 *  THE ASSERTION THIS EXISTS FOR. "Is note X open?" reads like a question
 *  `editorText()` can answer — `expect(await editorText(s)).toContain(title)` —
 *  and it cannot, ever. A note's title lives in its managed frontmatter, and
 *  CM6's live preview REPLACES that block with the properties widget
 *  (`editor/src/decorations/frontmatter.ts`), whose title is an `<input>`
 *  VALUE. `textContent()` does not read input values, so the whole document
 *  text of a freshly-created note is the widget's own chrome —
 *  `"Properties≡+ Add property"` — with the title nowhere in it. The assertion
 *  is not flaky and does not depend on timing: it is unsatisfiable, and it
 *  fails by timeout, which reads exactly like a slow app.
 *
 *  The tab strip is the observable that actually carries the answer:
 *  `data-tab-id="note:<id>"` on `[data-active="true"]` (Saved Views #4). */
export async function activeNoteId(session: Session): Promise<string | null> {
  const [tab] = await session.findElements(testIdSelector("editor.tab", { "data-active": "true" }));
  if (!tab) return null;
  const raw = (await tab.attribute("data-tab-id")) ?? "";
  return raw.startsWith("note:") ? raw.slice("note:".length) : null;
}

/** Click a control and wait for what it reveals, RE-CLICKING when a click missed.
 *
 *  THE BUG THIS EXISTS FOR. `await (await s.byTestId(trigger)).click()` followed
 *  by `await s.byTestId(revealed)` looks correct and is the single most common
 *  shape in this suite, but it stakes the whole scenario on ONE click landing.
 *  When that click misses — it arrives before the trigger is wired, or races the
 *  outside-click handler that closes what it just opened — nothing re-clicks, so
 *  the wait burns its full `DEFAULT_TIMEOUT_MS` and throws.
 *
 *  It is not rare and it is not contention. Measured on an IDLE machine, one
 *  warm container, `--retry=0`: the sidebar `+` menu missed in 4 of 21 runs
 *  (~19 %), and the Views builder in 1 of 10. Both were invisible because
 *  `retry: 2` rescued the next attempt, so the suite reported green and the
 *  flake rate read as zero.
 *
 *  This is the THIRD place the repo has met this bug and the first time the fix
 *  is shared: `reopenNoteAfterReload` below re-clicks a note row for exactly
 *  this reason, and `cards-cover-picker.e2e.ts` grew a private 3-attempt loop
 *  around `views.new-button`. Prefer this helper over a fourth local copy.
 *
 *  SAFETY — the caller owns this. The loop never clicks a trigger whose target
 *  is already visible (the presence check runs FIRST, before any click), and it
 *  gives each attempt its own short window before judging it to have missed, so
 *  a slow-but-successful open is not clicked a second time. That makes a plain
 *  toggle survivable: the worst case is one wasted open/close before the next
 *  pass reopens it.
 *
 *  What it must NOT be pointed at is a trigger that COMMITS something, where a
 *  second click means a second write rather than a second attempt.
 *  `views.new-button` is safe for the reason `cards-cover-picker.e2e.ts` already
 *  wrote down: it only OPENS the builder, and the view is committed by
 *  `view-filter.save`.
 */
export async function clickUntilVisible(
  session: Session,
  triggerTestId: string,
  revealedTestId: string,
): Promise<void> {
  await clickUntilTrue(session, testIdSelector(triggerTestId), {
    done: async () => (await session.byTestIdAll(revealedTestId)).length > 0,
    label: `${triggerTestId} reveals ${revealedTestId}`,
    what: "clickUntilVisible",
    trigger: `[${triggerTestId}]`,
    outcome: `[${revealedTestId}]`,
  });
}

/**
 * The engine under `clickUntilVisible`, addressing the trigger by SELECTOR and
 * the outcome by an arbitrary predicate.
 *
 * Split out because the testid-pair form cannot express two real cases. A
 * control whose two states share one testid and differ only by attribute
 * (`editor.sidebar-toggle` carries `data-side` and `data-collapsed`) has no
 * second testid to wait for, and an outcome that is a property rather than an
 * element (a value changed, a count moved) has none either. Both were being
 * answered with a private re-click loop in the calling spec, which is how the
 * per-attempt window below kept getting dropped.
 *
 * That window is the load-bearing part, and `clickUntilVisible`'s own header
 * says why: the poll fires every 100 ms, so re-firing before the first click's
 * effect has committed clicks a TOGGLE straight back and the loop oscillates.
 * Each attempt gets 2 s of its own before it is judged to have missed.
 *
 * Same caller obligation as `clickUntilVisible`: never point this at a trigger
 * that COMMITS, where a second click is a second write rather than a retry.
 */
export async function clickUntilTrue(
  session: Session,
  triggerSelector: string,
  opts: {
    done: () => Promise<boolean>;
    label: string;
    /** Helper name for the failure message. */
    what?: string;
    /** How to name the trigger and the outcome in the failure message. */
    trigger?: string;
    outcome?: string;
    /** Omit for the harness default, `clickUntilVisible`'s standing budget. */
    timeoutMs?: number;
  },
): Promise<void> {
  // Which half went missing is the whole diagnosis, and a label naming only the
  // pair loses it: "the trigger never rendered" (a missing precondition — see
  // the five Views specs that never enabled `settings.views-enabled`) and "the
  // trigger is there but its click keeps missing" (the flake this exists for)
  // are different bugs with different fixes. Track it and say which.
  let everSawTrigger = false;
  try {
    await session.waitUntil(
      async () => {
        if (await opts.done()) return true;
        const [trigger] = await session.findElements(triggerSelector);
        if (trigger === undefined) return null;
        everSawTrigger = true;
        await trigger.click();
        for (let i = 0; i < 20; i++) {
          if (await opts.done()) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return null;
      },
      opts.timeoutMs === undefined
        ? { label: opts.label }
        : { label: opts.label, timeoutMs: opts.timeoutMs },
    );
  } catch (e) {
    const trigger = opts.trigger ?? triggerSelector;
    const outcome = opts.outcome ?? opts.label;
    const why = everSawTrigger
      ? `${trigger} rendered and was clicked, but ${outcome} never appeared`
      : `${trigger} NEVER RENDERED. Nothing was ever clicked, so this is a missing precondition rather than a flaky click (e.g. a feature still behind its setting).`;
    throw new Error(`${opts.what ?? "clickUntilTrue"}: ${why}\n${(e as Error).message}`);
  }
}

/**
 * A left-ribbon button, addressed by the registry command it runs.
 *
 * The rail renders every pinned command under one testid
 * (`editor.ribbon.button`) and distinguishes them by `data-command-id`, so a
 * scenario cannot reach a specific button through `byTestId` at all. Both
 * attributes are product markup (`LeftRibbon.tsx`), not test-only hooks.
 */
export function ribbonSelector(commandId: string): string {
  return `[data-testid="editor.ribbon.button"][data-command-id="${commandId}"]`;
}

/**
 * Click a ribbon button until the surface it opens is on screen.
 *
 * `clickUntilVisible`'s ribbon twin, and it exists because the sidebar footer
 * entries these scenarios used to click (`notes.trash-open`,
 * `notes.archive-open`, the Views nav row) are gone \u2014 the rail is the entry
 * point now (myne-md/myne#762). The re-click discipline is the same and matters
 * for the same reason: a first click can land before the rail is wired.
 */
export async function clickRibbonUntilVisible(
  session: Session,
  commandId: string,
  revealedTestId: string,
): Promise<void> {
  await clickUntilTrue(session, ribbonSelector(commandId), {
    done: async () => (await session.byTestIdAll(revealedTestId)).length > 0,
    label: `ribbon ${commandId} reveals ${revealedTestId}`,
    what: "clickRibbonUntilVisible",
    trigger: `ribbon[${commandId}]`,
    outcome: `[${revealedTestId}]`,
  });
}

/** Open the sidebar's "+" menu and click one of its entries.
 *
 *  #230 folded the separate new-note and new-folder buttons into a single `+`
 *  menu, so those entries render only while it is open — the testids still
 *  exist, they are simply not on screen by default. Every helper that used to
 *  click one directly has to open the menu first. Clicking `+` while the menu is
 *  already open would toggle it shut, so this checks before firing.
 *
 *  ONE CLICK IS NOT ENOUGH, and trusting it was the single largest source of
 *  E2E flake. The old shape fired `+` once and then waited the full
 *  `DEFAULT_TIMEOUT_MS` on the dropdown; when that click did not open the menu —
 *  landing before the trigger is wired, or racing the outside-click handler that
 *  closes it — nothing ever re-clicked, so the helper burned 45 s and threw.
 *  Measured on an IDLE machine (no CI, no contention, same spec repeated in one
 *  warm container): 2 of 9 runs, ~22 %, every one of them
 *  `waitUntil(waitForElement([data-testid="notes.new-menu-dropdown"])) timed out
 *  after 45000 ms`. `retry: 2` then rescued the second attempt, so the suite
 *  reported green and the flake rate read as zero — the failure never reached a
 *  report at all. It also explains the suite's wall-clock: every occurrence adds
 *  a full budget, across ~123 spec files.
 *
 *  So: re-click until the dropdown is actually up. This is the same fix
 *  `reopenNoteAfterReload` below already applies to the same class of bug (a
 *  click that lands before its target is wired) — it simply had never been
 *  applied here. Each attempt gets its own SHORT window before being judged to
 *  have missed, because re-clicking a menu that did open would toggle it shut
 *  and turn one flake into an oscillation. */
/**
 * Click one of the sidebar's create actions.
 *
 * It used to open a `+` dropdown first and retry the item click — the dropdown
 * closed BEFORE each action ran, which made a retry provably safe. myne#7xx
 * replaced that dropdown with three direct icon buttons (new drawing, new
 * folder, new note), so there is no menu, no open step, and no retry window:
 * a click either lands or the element was not there.
 *
 * Kept as a named helper rather than inlined at 13 call sites, because the
 * create actions are exactly the kind of control that moves — they have been
 * loose buttons, then a menu, and now buttons again — and one helper is the
 * thing that made the LAST move a one-file change.
 */
export async function clickNewItem(session: Session, testId: string): Promise<void> {
  const el = await session.byTestId(testId, { timeoutMs: 10_000 });
  await el.click();
}

// ── sidebar note rows ────────────────────────────────────────────────────────
//
// Lifted out of `workspace-state.e2e.ts` when a second suite needed to build a
// split (myne-md/myne#520's cover scenario). Copying them would have been the
// third copy of the context-menu rationale below, which is the part that has to
// stay true rather than the three lines of driving.

/** The sidebar rows' note-ids, in DOM order, once exactly `expected` exist. */
export async function noteRowIds(
  session: Session,
  expected: number,
): Promise<string[]> {
  const rows = await session.waitUntil(
    async () => {
      const found = await session.byTestIdAll("notes.row");
      return found.length === expected ? found : null;
    },
    { label: `${expected} note rows`, timeoutMs: 15_000 },
  );
  return Promise.all(rows.map(async (r) => (await r.attribute("data-note-id")) ?? ""));
}

/** The id of the active note tab. The sidebar virtualizes its rows, so the
 *  selected row can be absent from the DOM when it is outside the scroll window.
 *  The editor tab remains mounted and carries the same note id. */
export async function selectedNoteId(session: Session): Promise<string> {
  const tab = await session.waitForElement(testIdSelector("editor.tab", { "data-active": "true" }));
  const tabId = (await tab.attribute("data-tab-id")) ?? "";
  if (!tabId.startsWith("note:") || tabId.length === "note:".length) {
    throw new Error("selectedNoteId: the active editor tab is not a note tab");
  }
  return tabId.slice("note:".length);
}

/** One sidebar row, by note id. */
/**
 * Right-click the first match of `selector`, re-finding it on every poll.
 *
 * `Element.rightClick` already retries a not-yet-hit-testable element, and like
 * `Element.click` it cannot answer a node that has been REPLACED: the handle is
 * stale on every poll and the wait can only time out. Same fix as
 * {@link clickBySelector}, and it is here rather than left for later because
 * `rowMenuPick` sits one line below the click that was fixed and drives the same
 * re-rendering sidebar list.
 */
export async function rightClickBySelector(session: Session, selector: string): Promise<void> {
  let lastReason = "never polled";
  await session.waitUntil(
    async () => {
      const [el] = await session.findElements(selector);
      if (el === undefined) {
        lastReason = "nothing matches that selector";
        return null;
      }
      await scrollIntoView(session, selector);
      try {
        await el.rightClick();
        return true;
      } catch (e) {
        if (
          e instanceof WebDriverError &&
          (e.code === "stale element reference" ||
            e.code === "element not interactable" ||
            e.code === "element click intercepted")
        ) {
          lastReason =
            `found, but the right-click reported "${e.code}"; ` +
            (await hitTest(session, selector));
          return null;
        }
        throw e;
      }
    },
    { label: () => `${selector} located + right-clicked (last poll: ${lastReason})` },
  );
}

/**
 * Click a note row, re-finding it on every poll.
 *
 * `(await noteRow(s, id)).click()` captures the handle ONCE and then polls the
 * click against it. `Element.click` retries a not-interactable element, which is
 * the case it was written for, but a handle whose node has been REPLACED is
 * stale on every poll and can only time out: the sidebar list re-renders on a
 * save settling, on a sync tick and on the row's own selection, so the window
 * between finding and clicking is real. Measured on `nco3`, which failed once in
 * eight runs with `[stale element reference]` after two retries, then passed
 * three consecutive times unchanged.
 *
 * A row is addressed by testid PLUS `data-note-id`, which is why this exists at
 * all rather than being a `clickByTestId` call.
 */
export async function clickNoteRow(session: Session, noteId: string): Promise<void> {
  await clickBySelector(session, testIdSelector("notes.row", { "data-note-id": noteId }));
}

/** Right-click a note row and pick a context-menu item by `data-item-id`. The
 *  new-tab / open-to-side gestures are driven through the row's REAL context menu
 *  (`open-in-new-tab` / `open-to-side`) rather than middle-click / Alt-click: the
 *  WebDriver synthetic middle-click never fires `auxclick` under WebKit, and the
 *  Alt-modifier click doesn't establish the split, both production gestures, but
 *  not driver-addressable. The context-menu items invoke the SAME workspace
 *  actions (openNewTabInFocused / openToSide). */
export async function rowMenuPick(
  session: Session,
  noteId: string,
  itemId: string,
): Promise<void> {
  await rightClickBySelector(session, testIdSelector("notes.row", { "data-note-id": noteId }));
  await (
    await session.waitForElement(
      testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
    )
  ).click();
}

/** Right-click an ELEMENT handle (a row, a folder row, a tab) and pick a
 *  context-menu item by its `data-item-id`.
 *
 *  The element-taking twin of {@link rowMenuPick}: that one addresses a note row
 *  by id and re-finds it, which is not what the folder rows, the tab strip or an
 *  already-resolved handle want. Eight suites had grown their own identical copy
 *  of this body, so it lives here now; the two coexist deliberately because the
 *  callers differ in whether they hold an id or an element. */
export async function contextMenuPick(
  session: Session,
  target: { rightClick(): Promise<void> },
  itemId: string,
): Promise<void> {
  await target.rightClick();
  await (
    await session.waitForElement(
      testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
    )
  ).click();
}

/** Create a note via the sidebar CTA and commit `title` through the note's own
 *  promoted title field (Enter). Leaves the note selected.
 *
 *  **This drove the sidebar inline-rename input until myne#653 removed it.**
 *  Creating a note no longer seeds `renamingId`, because that input takes focus
 *  away from the note and vanishes on blur, which left a freshly created note
 *  untitleable from either place: no `title:` field in the note, and a sidebar
 *  input that disappeared the moment you looked elsewhere. The name is now typed
 *  in the note, so this types there.
 *
 *  100 spec files reach this helper, so the old shape did not degrade, it
 *  blocked forever on an element that never renders. The pane focuses the field
 *  on create; this wait is what proves it did. */
/** The promoted note-title field (myne#653). Named once: `nameNewNote` locates
 *  it on every retry attempt, so a literal would be repeated three times inside
 *  one function. Mirrors `TITLE_FIELD_TESTID` in
 *  `editor/src/decorations/frontmatter.ts`, which is where it is emitted. */
const TITLE_FIELD = testIdSelector("editor.frontmatter-title");

/** Type `title` into the promoted title field of the note just created and
 *  commit it with Enter.
 *
 *  Split out because myne#653 moved naming from the sidebar into the note, and
 *  four call sites carried their own copy of the old two-line sidebar shape: the
 *  `createNoteInFolder` helpers in `folder-archive` and `folder-notes`, the two
 *  inline folder-note creates in `notes.e2e.ts`, and the capture lane. One
 *  helper means the next move costs one edit rather than five.
 *
 *  A DRAWING is deliberately not this: its body is a fenced Excalidraw scene
 *  with no title field, so it still names through the sidebar rename input and
 *  `drawing-notes.e2e.ts` is right to keep driving that. */
export async function nameNewNote(session: Session, title: string): Promise<void> {
  // Re-find on EVERY attempt, and assert the value landed. Both halves are
  // load-bearing, and the first version of this helper had neither.
  //
  // The field lives inside `PropertiesWidget`, a CodeMirror WIDGET, so its DOM
  // node is destroyed and rebuilt whenever the decoration set is recomputed,
  // which a freshly created note does several times while it settles. A handle
  // taken once and typed into a moment later is therefore stale by
  // construction rather than by bad luck: the first full-suite run of this
  // helper reported `stale element reference` out of `nameNewNote` across 21
  // spec files, and the specs that did not fail there failed one step later,
  // waiting for titles that had never been typed.
  //
  // `waitUntil` swallows `stale element reference` as a falsy poll for exactly
  // this class (see its header), so the retry is the harness's own idiom rather
  // than a new mechanism. `reopenNoteAfterReload` below says the same thing in
  // its own words: "re-queried so no stale handle".
  //
  // `replaceText` rather than `sendKeys` is what makes the retry safe: it
  // backspaces the CURRENT value first, so an attempt that typed half the title
  // before the node vanished is corrected by the next one instead of appended
  // to.
  //
  // `\uE007` is ENTER, and it commits. The input's `change` listener is what
  // writes `title:` into the note, and `change` fires on Enter or on blur, so
  // without it the caller's next action decides whether the name was ever
  // saved. The first version's own docstring said "commit it with Enter" while
  // the code sent no Enter at all.
  // What the last poll actually saw, reported in the timeout message. A wait
  // that says only "it never held X" cannot distinguish "the field is on a
  // different note", "the keys never landed" and "the value came back in a
  // different normal form", and this helper burned three container runs on
  // exactly that ambiguity.
  let seen = "<never read>";
  let fields = 0;
  await session.waitUntil(
    async () => {
      // More than one match means the wait is not looking at what it thinks it
      // is: a second pane, or a second app window (the harness reported
      // `xdotool ... matched 2 windows` in the same run). Counted rather than
      // assumed, and reported either way.
      fields = (await session.findElements(TITLE_FIELD)).length;
      const field = await session.waitForElement(TITLE_FIELD);
      // The field must be EMPTY, and this guard is the difference between
      // naming the new note and RENAMING the previous one.
      //
      // `waitForElement` returns the first match in the document, and after a
      // create the pane has not necessarily swapped yet, so the field on screen
      // can still belong to the note named a moment ago. `replaceText`
      // backspaces the current value first, so typing into it does not fail
      // loudly, it silently renames that note and leaves the new one untitled.
      // `saved-views-cards` creates three notes back to back and then looks for
      // three titles; it found fewer, with no error anywhere.
      //
      // Every note created since myne#653 carries `title: ""`, so "empty" is
      // exactly "this is the freshly created note" and needs no extra signal.
      if ((await field.property<string>("value")) !== "") return null;
      // Prefer an ATOMIC DOM-set over typing: the title field lives in a
      // CodeMirror widget that is destroyed and rebuilt several times while a
      // fresh note settles, so a keystroke stream can lose most of its
      // characters (observed: "Klasör Notu" read back as "u"). The
      // React-native-setter + `input`/`change` events are the standard
      // controlled-input path and are immune to a mid-stream widget rebuild.
      // Fall back to keystrokes only if the field is not there to set.
      const domSet = await session
        .execute<boolean>(
          "var el=document.querySelector(arguments[0]); if(!el) return false;" +
            "el.focus();" +
            "var d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');" +
            "d.set.call(el, arguments[1]);" +
            "el.dispatchEvent(new Event('input',{bubbles:true}));" +
            "return true;",
          [TITLE_FIELD, title],
        )
        .catch(() => false);
      if (domSet) {
        // Let the widget settle, then fire the commit EXPLICITLY.
        //
        // A programmatic `value` set does not raise the input's "dirty value
        // flag", so `blur()` - and therefore the widget's `change` listener that
        // writes `title:` - never fires on its own: the field reads back
        // correctly while the note keeps `title: ""` (measured: every created
        // note read back empty on disk). Fire `change` directly, after a beat so
        // the widget's cached frontmatter range is current.
        await new Promise((r) => setTimeout(r, 120));
        await session.execute(
          "var el=document.querySelector(arguments[0]); if(!el) return false;" +
            "el.dispatchEvent(new Event('change',{bubbles:true}));" +
            "el.blur();" +
            "return true;",
          [TITLE_FIELD],
        );
      } else {
        await field.replaceText(`${title}\uE007`);
      }
      // Re-find rather than reusing `field`: committing re-renders the widget,
      // so the handle that accepted the keys may already be detached.
      const settled = await session.waitForElement(TITLE_FIELD);
      seen = (await settled.property<string>("value")) ?? "<null>";
      // Case-insensitive, NFC, and the reason is measured rather than assumed.
      // Typing "Klasor Notu" into this field and reading it straight back
      // returns "klasor notu" through WebKitWebDriver, from ONE matching
      // element (the diagnostic below counts them, which is how that was
      // established rather than guessed). The keys land, the case does not
      // survive the round trip.
      //
      // So this asserts what the helper is actually responsible for: the right
      // field received the right text. Whether the note ends up TITLED
      // correctly is the calling spec's assertion to make, against the sidebar
      // or the card or the tab, and every one of them already makes it. A
      // helper that fails on a driver artefact blocks the specs from ever
      // reaching their own subject, which is what the strict form did across
      // 25 files.
      // Non-ASCII is ALSO dropped by the driver, not just case-folded: typing
      // "Klasör Notu" reads back "klasr notu" (the ö is simply absent). So the
      // comparison strips non-ASCII from BOTH sides; a title with a diacritic
      // is compared on its ASCII skeleton, which is what the driver can
      // actually deliver. The spec's own assertion against the sidebar/card/
      // tab is where the real title is checked (see the header above).
      const norm = (v: string): string =>
        v
          .normalize("NFC")
          .toLowerCase()
          .replace(/[^\x00-\x7f]/g, "");
      return norm(seen) === norm(title) || null;
    },
    {
      label: () =>
        `the new note's title field holds ${JSON.stringify(title)}; ` +
        `last read ${JSON.stringify(seen)} from ${fields} matching field(s)`,
    },
  );
}


/**
 * Create a note and name it.
 *
 * **It REUSES the focused pane's active tab** (myne-md/myne#728). Two calls
 * leave ONE tab open, not two, so a scenario that needs a second tab has to
 * ask for one: the row's own `open-in-new-tab` context item, through
 * `rowMenuPick`. Recorded here because the assumption is invisible until a
 * tab-strip assertion counts one tab and reads like a product bug.
 */
export async function createNote(session: Session, title: string): Promise<void> {
  await clickNewItem(session, "notes.create");
  await nameNewNote(session, title);
  // Best-effort: let the name reach the SIDEBAR before returning. The title is
  // committed by the frontmatter-title input and reaches the row's cache through
  // autosave (or, on a switch, through PaneView's flush-then-refresh), either of
  // which is milliseconds behind. A caller that acts immediately - a view opened
  // over "the notes" - otherwise reads the cache before the last note's title
  // lands and sees an "Untitled" card. Non-throwing: a note legitimately created
  // inside a folder has no top-level row, and that is the caller's business.
  await session
    .waitUntil(
      async () => {
        for (const row of await session.byTestIdAll("notes.row")) {
          if ((await row.textContent()).includes(title)) return true;
        }
        return null;
      },
      { label: `a sidebar row titled ${title}`, timeoutMs: 8_000 },
    )
    .catch(() => {});
  // The title commit leaves a pending autosave. An out-of-band `note_update`
  // that races it has its PaneView reload skipped (`hasPendingWork()`), so the
  // long body never reaches the buffer (scroll-memory / scroll-slack). Settle
  // the badge first. Non-throwing: a caller that never edited still returns.
  await waitForSaved(session).catch(() => {});
}

/** Create a folder from the sidebar's "New folder" action and commit `name`
 *  through the inline input, waiting for the folder row to exist.
 *
 *  The `ENTER_KEY` commit is load-bearing: without it the inline input never
 *  materialises `notes.folder-row` and the caller's next wait burns its whole
 *  budget. Five suites carried their own copy of these three lines.
 *
 *  **Name it in lowercase.** WebKitWebDriver's Send Keys drops the shift
 *  modifier, so an uppercase character arrives lowercased — a driver
 *  limitation, not a product one, and a caller that asserted the typed case
 *  would fail on a working app. */
export async function createFolder(session: Session, name: string): Promise<void> {
  await clickNewItem(session, "notes.new-folder");
  await (await session.byTestId("notes.new-folder-input")).sendKeys(`${name}${ENTER_KEY}`);
  await session.byTestId("notes.folder-row");
}

/** Confirm an open delete-confirm dialog with Enter (myne-md/myne#676,
 * myne-md/myne#683).
 *
 * ONE press, behind the precondition the dialog's own keyboard contract names:
 * the focus ring must be on the confirm button, because Enter follows the ring
 * and a press into an unfocused dialog is silently a no-op. A first press that
 * does not confirm is then a FAILURE to report, not something to paper over.
 *
 * It used to press a second time after a 5 s grace, described as "the same
 * recovery a user performs when the first press visibly does nothing". That
 * retry was hiding a real defect rather than covering a race. The dialog armed
 * itself with a 16 ms window measured from the moment its arming effect ran, and
 * a press landing inside the window was refused on a dialog whose ring was on
 * the confirm button with every other guard reading correct; the retry worked
 * only because it was no longer inside the window (`sinceMount` 14 ms, then
 * 8137 ms, in the instrumented run on #683). The window is gone: the guard now
 * compares the key event's own timestamp against the instant the dialog entered
 * the document, and both are registered in the commit that makes it visible. So
 * the ring wait below stays, because "Enter did nothing" and "Enter had nothing
 * to follow" are different failures, and the second press goes.
 *
 * Guard 4 is NOT exercised by this helper's callers, and saying so is the point:
 * `openedByKey` is false on both paths, because et1 reaches the palette row
 * through `runPaletteAction`'s click (`viaKey: false`) and nc5's keyboard
 * soft-trash renders the modal with no `openedByKey` at all. The dialog they
 * drive therefore has guard 4 released from the first frame. The commit-phase
 * registration this branch made is what keeps guard 4 intact for a real
 * key-opened dialog, and that path (the palette row activated with Enter) is
 * driven by no scenario. The jsdom test "refuses a held Enter that opened the
 * dialog" pins the rule; nothing in this lane pins the timing.
 */
export async function confirmDeleteWithEnter(session: Session): Promise<void> {
  await session.byTestId("delete-confirm.confirm");
  await waitForDeleteRing(session);
  await pressKey(session, KEY.ENTER);
  await session.waitForGone(testIdSelector("delete-confirm.confirm"));
}

/** The delete-confirm focus ring: the precondition every Enter press on the
 *  dialog needs, and the thing that distinguishes "Enter is broken" from
 *  "Enter never had a ring to follow". */
async function waitForDeleteRing(session: Session): Promise<void> {
  await session.waitUntil(
    async () => ((await activeTestId(session)) === "delete-confirm.confirm" ? true : null),
    { label: "focus ring on delete-confirm.confirm", timeoutMs: 15_000 },
  );
}

/** Re-open the FIRST sidebar note after a `refresh()` and wait until its editor
 *  body actually mounts. A WebView reload re-renders the sidebar AND remounts the
 *  editor; a single `notes.row` click can land before the row is wired (or race
 *  the editor mount) and silently NOT open the note, leaving the empty
 *  note-switcher up (no `.cm-content`) — which makes any absence-assertion (e.g.
 *  "no squiggle") pass vacuously and the next presence-assertion fail. Re-click
 *  (native DOM click, re-queried so no stale handle) until `.cm-content` is
 *  present. Generous budget for full-suite cumulative load. */
export async function reopenNoteAfterReload(session: Session): Promise<void> {
  await session.waitUntil(
    async () => {
      await session.execute(
        "var r = document.querySelector('[data-testid=\"notes.row\"]');" +
          "if (r) r.click(); return 1;",
      );
      return (await session.findElements(CM_CONTENT)).length > 0 ? true : null;
    },
    { label: "note reopened after reload", timeoutMs: 30_000 },
  );
}

/**
 * Send one key to the focused editor document, without typing a payload.
 *
 * The case this exists for: a **block widget renders only while the caret is
 * outside its lines** — the live-preview reveal rule. A scenario that types a
 * block therefore ends with the caret inside it and the block still raw, and
 * any assertion about the rendered form fails against source text. One Enter
 * after the typing moves the caret out, which is what a user does anyway.
 *
 * Pass a W3C key code (`` Enter, `` ArrowDown, …), not a literal
 * `"\n"` — WebKit's driver delivers U+000A as a character, not a keypress.
 */
export async function pressInEditor(session: Session, key: string): Promise<void> {
  const [content] = await session.findElements(CM_CONTENT);
  if (!content) throw new Error("pressInEditor: editor content not found");
  await content.sendKeys(key);
}

/** The W3C Enter key, for `pressInEditor`. */
export const ENTER_KEY = String.fromCharCode(0xe007);

/** The W3C Escape key, for `pressInEditor`. */
export const ESCAPE_KEY = String.fromCharCode(0xe00c);

/** Type into the live CodeMirror document. A plain element click does
 *  NOT focus CM under this driver (activeElement stays put); sendKeys'
 *  implicit focus does, but keys sent during that focus settle drop
 *  silently (observed as a truncated leading edge). So: probe with a
 *  sacrificial character until one actually lands — proof the key
 *  pipeline is live — then send the payload and verify it arrived.
 *  The async note-content load can ALSO reset the document mid-stream
 *  (observed: probe chars wiped + the payload's leading edge swallowed
 *  by the fresh doc), so a payload that didn't land gets ONE re-send.
 *  Callers' asserts are `includes(...)`, so stray probe chars and a
 *  leftover truncated fragment are harmless.
 *
 *  `landedText` overrides what the arrival check looks for. The default —
 *  the payload itself — assumes Live preview only HIDES syntax, so the words
 *  survive. A decoration that REPLACES a span with a different label breaks
 *  that assumption: a task field types as `[due:: 2026-08-01]` and renders as
 *  a chip reading `2026-08-01`, so the word "due" is nowhere in the DOM and
 *  the check can never pass — it re-sends, and the line ends up typed twice.
 *  Pass the part that survives rendering (usually the plain prose) instead. */
export async function typeIntoEditor(
  session: Session,
  text: string,
  opts?: { landedText?: string },
): Promise<void> {
  // Focus the editor. When a double-click CREATES+opens a note (folder index
  // note, MYND-370), the editor re-renders asynchronously and REPLACES the
  // .cm-content node — a handle located once then clicked goes genuinely stale
  // mid-open, and click()'s retry then burns its whole budget polling the dead
  // node (waitUntil only treats stale as transient when the predicate RE-QUERIES,
  // see its header). Re-locate INSIDE the poll (raw clickOnce, no nested retry)
  // so a replaced node is simply the next iteration's fresh handle.
  const content = await session.waitUntil(
    async () => {
      const [el] = await session.findElements(CM_CONTENT);
      if (!el) return null;
      try {
        await el.clickOnce();
      } catch (e) {
        if (
          e instanceof WebDriverError &&
          (e.code === "stale element reference" ||
            e.code === "element not interactable" ||
            e.code === "element click intercepted")
        ) {
          return null; // node replaced / not yet hit-testable — re-find next poll
        }
        throw e;
      }
      return el;
    },
    { label: "editor located + focused", timeoutMs: 10_000 },
  );
  await session.waitUntil(
    async () => {
      await content.sendKeys("q");
      return (await editorText(session)).includes("q") || null;
    },
    { label: "keystroke pipeline established", timeoutMs: 10_000 },
  );
  // The pipeline probe typed "q" and the caret sits right after it — delete it
  // with a SINGLE Backspace so the document starts clean for position-sensitive
  // callers (multi-cursor columns, Mod-d word selection). Far less invasive than
  // a select-all+delete (which reintroduces the focus-settle drop the probe
  // guards against and regressed notes/snapshots); a no-op-safe keystroke against
  // the just-typed char.
  await content.sendKeys(String.fromCharCode(0xe003)); // BACKSPACE removes the probe "q"
  // `editorText()` reads `.cm-content`'s textContent. Two layout artefacts make a
  // raw `includes(text)` check unreliable:
  //   1. textContent concatenates CM6's per-line `<div class="cm-line">` blocks
  //      WITHOUT a separator, so a payload's "\n" never appears in the readout.
  //   2. In Live preview, markdown MARKERS on non-cursor lines are decoration-
  //      hidden — a heading's "# ", a list's "- ", a wikilink's "[[…]]" chrome —
  //      so `# Alpha` reads back as "Alpha". A payload carrying markdown syntax
  //      therefore never `includes`-matches verbatim, and the legacy check
  //      double-TYPED the whole doc on the re-send path (observed: heading/list
  //      folding + folded-replace docs typed twice, concatenated).
  // Normalise BOTH sides to lowercase alphanumerics (drop newlines, markers,
  // whitespace, punctuation, and any auto-inserted list bullets / indent) — a
  // true "did the words land, in order" proof, robust to Live-mode decoration.
  const norm = (s: string): string => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const flat = norm(opts?.landedText ?? text);
  const landed = async () => norm(await editorText(session)).includes(flat) || null;
  // A literal "\n" in a sendKeys payload is delivered as U+000A, which WebKit's
  // driver does NOT translate into an Enter keypress — CM6 stays on one line
  // (cm-line count = 1), breaking every multi-line scenario (vertical
  // multi-cursor, heading folding, …). Send the W3C ENTER key (U+E007) for line
  // breaks so real cm-lines are created; `landed` still compares newline-free
  // (textContent omits block boundaries either way).
  const keys = text.replace(/\n/g, String.fromCharCode(0xe007));
  // Structural markdown races CM6's bracket auto-close under a fast sendKeys:
  // typing "[" inserts its closing "]"; if the caret has not settled before the
  // next character arrives, the payload's own "]" lands as a duplicate and the
  // structure the scenario is about (a task checkbox, a `[due:: …]` field, a
  // wikilink) never parses. The INPUT METHOD is the defect, not the scenario,
  // which is the class e2e/AGENTS.md records for the embed family. For a
  // single-line payload carrying brackets or non-ASCII, insert the whole string
  // in ONE DOM input event instead: CM6 sees a single insertion and never runs
  // the bracket-close keymap. Multi-line payloads keep the keystroke path (they
  // need real Enter keypresses), and plain single-line ASCII keeps it too, since
  // that is exactly what the probe above proves works.
  const structural = /[[\]{}()]/.test(text) || /[^\x00-\x7f]/.test(text);
  if (structural && !text.includes("\n")) {
    const inserted = await session
      .execute<boolean>(
        "const el = document.querySelector('.cm-content'); if (!el) return false; el.focus(); return document.execCommand('insertText', false, arguments[0]);",
        [text],
      )
      .catch(() => false);
    if (inserted) {
      try {
        await session.waitUntil(landed, {
          label: "typed text landed in the document (dom insert)",
          timeoutMs: 5_000,
        });
        return;
      } catch {
        // DOM insert did not land the payload; fall through to keystrokes.
      }
    }
  }
  await content.sendKeys(keys);
  try {
    await session.waitUntil(landed, {
      label: "typed text landed in the document",
      timeoutMs: 5_000,
    });
  } catch {
    await content.sendKeys(keys);
    await session.waitUntil(landed, {
      label: "typed text landed in the document (after re-send)",
    });
  }
}

/** Type an ATTACHMENT EMBED into the live CodeMirror document.
 *
 * Separate from {@link typeIntoEditor} for a reason that is not style. That
 * helper proves delivery by looking for the typed WORDS in the rendered DOM,
 * which works because Live preview only HIDES markdown syntax. An attachment
 * embed is the case its own doc comment warns about: every embed decoration is
 * an ATOMIC `Decoration.replace`, so the moment one builds, `![[att:…]]` leaves
 * the DOM entirely and no word of it survives. `typeIntoEditor` would therefore
 * conclude the text never landed and type the whole embed a SECOND time.
 *
 * Six near-identical private copies of a naive `typeRaw` grew up around that,
 * each carrying BOTH defects below. The four EMBED ones —
 * `embed-overflow-menu`, `attachment-zoom`, `image-ocr-search` and
 * `attachment-text-preview` — are collapsed into this helper, for the reason
 * `waitForInlineImage` was collapsed: the next copy would inherit them. The two
 * non-embed ones (`math`, `highlight-color`) stay private because their payload
 * survives rendering and so their arrival check is not this one; they got the
 * probe fix in place, with a pointer back here.
 *
 * **Defect 1: N probes, one Backspace.** The pipeline probe types `q` on EVERY
 * poll and the copies always sent exactly one Backspace. Under load the poll
 * routinely runs more than once, so the surplus `q`s stay in the document ahead
 * of the payload. Harmless for an `includes` assertion, not harmless for a
 * position-sensitive one, and it is the shape behind the recorded `slash-datetime`
 * trap where a leading `q` stops `/date` being a slash command at all. Fixed by
 * counting the probes and sending that many Backspaces.
 *
 * **Defect 2: the payload was never verified, and a weak check is barely
 * better.** `sendKeys` resolving means the driver accepted the keys, not that
 * CodeMirror applied them. Under full-suite load the leading character is
 * dropped during the focus settle, which is the exact defect the `q` probe
 * exists to absorb and does not always absorb, and `![[att:…]]` arriving as
 * `[[att:…]]` is an ORDINARY WIKILINK: `parts.isEmbed` is false, the embed
 * decoration returns without building anything, and the raw text sits there
 * forever. A permanent state no budget reaches, and what CI pipelines 653 and
 * 657 reported for `eo1`.
 *
 * The first version of this check looked for `att:`, which a payload missing its
 * leading `!` still satisfies — it passed the garbled document straight through
 * to `waitForInlineImage`, which then timed out wearing the name of an
 * attachment problem. The check is now the full `![[att:` prefix, so a dropped
 * leading character fails HERE, at the helper that caused it. Arrival is proven
 * in the one way that survives the atomic replace: that prefix is in the raw
 * source, OR an embed widget of any kind exists.
 *
 * The repair deletes what actually landed before retyping, rather than
 * appending a second attempt to a broken first. It measures the growth in the
 * rendered text and sends that many Backspaces, capped at the payload length so
 * a mis-measure can never eat into the note that was already there. */
/**
 * The deterministic PNG fixture the attachment/embed suites import: a small
 * image whose pixels OCR reads (`core/tests/fixtures/ocr-sample.png`).
 *
 * Four suites carried their own copy of this reader. Deliberately NOT exported
 * as a Buffer or a base64 blob — every caller wants `number[]` for the
 * `attachment_import` bytes source, so this is the shape it hands back.
 */
export function fixturePng(): number[] {
  return Array.from(
    readFileSync(join(REPO_ROOT, "core", "tests", "fixtures", "ocr-sample.png")),
  );
}

/**
 * Import {@link fixturePng} through the page seat's real
 * `attachment_import` IPC and return the catalog id.
 *
 * `filename` is the caller's, because each suite names the attachment the way
 * its own assertions read it back. The `expect` on `err` is the whole point of
 * sharing it: a copy that dropped it would return an id off an undefined body.
 */
export async function importFixturePng(
  session: Session,
  filename: string,
  timeoutMs = 60_000,
): Promise<string> {
  const r = await pageSeatInvoke(
    session,
    "plugin:attachments|attachment_import",
    { source: { kind: "bytes", bytes: fixturePng(), filename } },
    timeoutMs,
  );
  expect(r.err, "attachment_import should accept the .png fixture").toBeUndefined();
  return (r.ok as { id: string }).id;
}

/**
 * Put an attachment embed into a note through the real note IPC, then reopen it.
 *
 * **This replaces typing the embed, and the four rounds it took to get here are
 * the argument.** A form-C embed is `![[att:<id>|<name>]]`, and driving those
 * brackets through WebDriver races CodeMirror's bracket auto-close: typing `[`
 * inserts a closing `]`, and under full-suite load the caret update and the
 * incoming characters interleave. Both outcomes are permanent states no budget
 * reaches, and CI measured each of them on the SAME commit:
 *
 *   * pipeline 661 — the payload landed outside the auto-closed pair, giving an
 *     empty-target wikilink chip (`cm-wikilink-chip-broken`) with the rest as
 *     plain text behind it;
 *   * pipeline 664 — the payload came out unterminated, so it is not a Wikilink
 *     node at all, no decoration is ever built, and the raw text just sits there.
 *
 * Four rounds of hardening the typing helper each fixed the shape CI had just
 * shown and were overtaken by the next one, because the defect is in the input
 * method rather than in the check.
 *
 * So the embed is written the way three other scenarios in this suite already
 * write note content, for the reason `sync-replication.e2e.ts` states in one
 * line: "deterministic note_update IPC, no flaky editor typing".
 * `cards-cover-picker` and `editor-scroll-slack` do the same. It is production
 * IPC through the page seat, which `e2e/AGENTS.md` sanctions explicitly, and it
 * is NOT a test hook.
 *
 * **The write goes through `writeNoteBody`, not straight at `note_update`.** The
 * note is OPEN in a pane, so this client has a `LiveSession` on it and that
 * session is the note's single durable writer (`SYNC-33`): a stateless
 * `note_update` for it is refused with `NoteUpdateError::LiveSessionOpen`. Every
 * scenario below that seeds an OPEN note therefore failed on develop, naming a
 * write that used to work, until the funnel was introduced.
 *
 * **What this gives up, stated rather than glossed:** the scenarios no longer
 * prove that a user can type an embed. They never meant to. `eo1` is about the
 * overflow menu, `eo2` about the layout segments the menu writes, `za1` about
 * the lightbox and `tp1` about the text-preview card; in every one the embed is
 * scaffolding to get a widget on screen. Typing itself is covered by the specs
 * whose subject it is (`slash-datetime`, `math`, `highlight-color`, and
 * `typeIntoEditor`'s own callers).
 *
 * The reopen is not optional and not a settle: the editor loads the attachment
 * catalog ONCE per mount, so the note has to be re-opened after the write for
 * the embed to resolve against a catalog that contains the import.
 */
export async function seedEmbedIntoNote(
  session: Session,
  embed: string,
  timeoutMs = 30_000,
): Promise<void> {
  // The note `createNote` just made is the highlighted row, and its id is on the
  // row rather than anywhere in the editor. Same reading `editor-scroll-slack`
  // uses.
  const row = await session.waitForElement(testIdSelector("notes.row", { "aria-selected": "true" }));
  const noteId = (await row.attribute("data-note-id")) ?? "";
  if (noteId === "") throw new Error("seedEmbedIntoNote: the active note row carries no id");

  // Append rather than replace: `createNote` writes a title and frontmatter, and
  // a scenario that silently dropped them would be testing a different note.
  const cur = await pageSeatInvoke(session, "plugin:notes|note_read", { noteId }, timeoutMs);
  const base = typeof cur.ok === "string" ? cur.ok : "";
  const up = await writeNoteBody(session, noteId, `${base}\n${embed}`, timeoutMs);
  expect(up.err, "the embed write should succeed").toBeUndefined();

  await session.refresh();
  await session.byTestId("editor.root", { timeoutMs });
  // The reload re-mounts the first editor, and on a fresh vault that brings the
  // importer onboarding OVERLAY back. It covers the editor, so every click after
  // this one lands on it: measured as `attachment-image.menu` never appearing
  // after its button was "clicked". The helper owns the reload, so it owns this.
  await dismissImporterOfferIfPresent(session);
  // Re-click until the note is actually open. A single click can land before the
  // row is wired after a reload, which leaves the empty note-switcher up and
  // makes every following assertion measure nothing.
  await session.waitUntil(
    async () => {
      const tabs = await session.findElements(testIdSelector("editor.tab", { "data-active": "true" }));
      if (tabs.length > 0) return true;
      await session.execute<number>(
        "var e = document.querySelector('[data-testid=\"notes.row\"][data-note-id=" +
          JSON.stringify(noteId) +
          "]'); if (e) { e.click(); return 1; } return 0;",
      );
      return null;
    },
    { label: "the seeded note is open", timeoutMs: 20_000 },
  );
}

/** Wait until the autosave badge settles on "Saved" AFTER having seen
 *  the edit register ("Editing…"/"Saving…") — polling for "Saved" alone
 *  could match the pre-edit clean state. */
export async function waitForSaved(session: Session): Promise<void> {
  // Fail FAST and by name when the badge is not merely late but ABSENT.
  // The editor hides the save status entirely while no note tab is active
  // (`Editor.tsx`: `hideSaveStatus={ws.focusedLeaf.activeTab === null}` — with
  // nothing open the values would be meaningless). A caller that lands there
  // otherwise waits the full budget and reports
  // `waitUntil(waitForElement([data-testid="editor.save-status"])) timed out`,
  // which reads as a slow save and is really a missing precondition: there is
  // no open note to save. Distinguishing the two costs one query.
  if ((await session.byTestIdAll("editor.save-status")).length === 0) {
    const tabs = await session.findElements(testIdSelector("editor.tab", { "data-active": "true" }));
    if (tabs.length === 0) {
      throw new Error(
        "waitForSaved: no save status AND no active editor tab — the editor hides " +
          "the badge when nothing is open, so this is a missing precondition (open a " +
          "note first), not a slow autosave.",
      );
    }
  }
  // The post-edit saved state renders "Saved·<rel>" (separator + relative
  // time) — distinguishable from the pre-edit clean state's bare "Saved",
  // so this can't pass before the edit's own save actually landed.
  await session.waitUntil(
    async () =>
      (await (await session.byTestId("editor.save-status")).textContent()).includes("Saved·") ||
      null,
    { label: "autosave settled on Saved·<rel>", timeoutMs: 15_000 },
  );
}

/**
 * Wait until a banner's RENDERED text equals `expected` (full-literal equality),
 * re-reading on every poll.
 *
 * **`byTestId` resolves the moment the element is in the DOM, and WebKit's
 * `GET /text` can answer `""` for an element whose render tree has not caught
 * up.** Measured on the picker-reached unlock: the error banner is present,
 * `textContent` and `innerText` already carry the copy, and `/text` returns `""`
 * on the first read and the copy ~1.5 s later. A one-shot `banner.text()`
 * therefore fails on timing rather than on behaviour, and the failure reads
 * exactly like a missing banner (`expected '' to be 'Wrong password…'`). Polling
 * the read makes the wait the assertion: a banner that never carries the copy
 * still fails, and the element is re-found each poll so a replaced node cannot
 * leave a stale handle behind.
 */
export async function waitForBannerText(
  session: Session,
  testId: string,
  expected: string,
): Promise<void> {
  await session.waitUntil(
    async () => {
      const [el] = await session.findElements(testIdSelector(testId));
      if (el === undefined) return null;
      return (await el.text()) === expected ? true : null;
    },
    { label: `${testId} reads its full literal`, timeoutMs: 15_000 },
  );
}

/** Replace a field's value, RE-LOCATING the element if it goes stale mid-way.
 *
 *  `Element.replaceText` costs two round trips — read `value`, then send the
 *  keystrokes — and a React panel that re-renders between them (the find bar
 *  after a replace-all, for one) invalidates the handle in the gap. The spec
 *  then dies with `[stale element reference] Node with identifier 'node-…' was
 *  not found`, a message that names a GUID and nothing else. Re-locating inside
 *  the retry is the same shape `typeIntoEditor` already uses for `.cm-content`;
 *  this is that, for the byTestId fields. */
export async function replaceFieldText(
  session: Session,
  testId: string,
  text: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await (await session.byTestId(testId)).replaceText(text);
      return;
    } catch (e) {
      if (e instanceof WebDriverError && e.code === "stale element reference") {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      throw e;
    }
  }
  // Last attempt outside the catch so a persistent staleness surfaces as itself.
  await (await session.byTestId(testId)).replaceText(text);
}

/** Current CodeMirror document text (`textContent()` — the doc lives in
 *  nested .cm-line elements this driver's getText drops). Re-found per
 *  call: CM remounts across relock/reload.
 *
 *  **This is the RENDERED text, which is not always the stored text.** Every
 *  replace widget substitutes its own label for the source it covers, so a
 *  scenario asking "did the file keep its bytes" must use
 *  {@link editorSourceText} instead. That distinction cost four scenarios in
 *  myne-md/myne#609: the task chip used to print its stored value verbatim, so
 *  reading a date off the render happened to work, and the moment the chip
 *  started printing the reader's chosen format the same assertions started
 *  timing out on text that was never gone from the document. */
export async function editorText(session: Session): Promise<string> {
  return (await session.waitForElement(CM_CONTENT)).textContent();
}

/**
 * The note's SOURCE text: the document as the file holds it, read in the one
 * view mode where nothing decorates it.
 *
 * Switches the focused note tab to `source` through the production bottom-bar
 * CTA, reads, then cycles back to the mode it started in so a later assertion
 * in the same scenario sees the editor it expects.
 *
 * **Why the view mode rather than something cheaper.** Three cheaper routes
 * were tried against the running app and none of them reveals a task chip:
 * putting the caret on the chip's line (the chips render on the caret line,
 * which `tc4` demonstrates by waiting for one there), opening the find panel
 * (its reveal is scoped to chips overlapping a MATCH, so a line with no match
 * keeps its chips), and reading a `data-` attribute (there is none carrying the
 * value, and adding one would be a test hook in production DOM). Source mode is
 * the app's own answer to "show me what is actually written".
 */
export async function editorSourceText(session: Session): Promise<string> {
  const mode = async (): Promise<string> =>
    (await (await session.byTestId("editor.view-mode-cta")).attribute("data-view-mode")) ?? "";

  /** Click the CTA until `want` is current, waiting on each click to land.
   *
   *  The wait compares against the mode read immediately BEFORE that click, not
   *  against the mode this function started in. Written the second way first,
   *  where the second iteration's wait was already satisfied by the FIRST
   *  click's effect and so confirmed nothing: a click that did not register
   *  would have been read as one that did. */
  const cycleTo = async (want: string): Promise<void> => {
    // live -> reading -> source -> live, so at most two clicks reach any mode
    // from any other. Three is the bound plus one, and a fourth would mean the
    // CTA is not cycling, which the loop exit then reports as a stuck mode.
    for (let i = 0; i < 3 && (await mode()) !== want; i += 1) {
      const before = await mode();
      await (await session.byTestId("editor.view-mode-cta")).click();
      await session.waitUntil(async () => ((await mode()) !== before ? true : null), {
        label: `the view mode advanced away from ${before}`,
      });
    }
  };

  const started = await mode();
  await cycleTo("source");
  const text = await editorText(session);
  await cycleTo(started);
  return text;
}

/**
 * Insert `text` into the open note's body VERBATIM, via a synthetic paste.
 *
 * The counterpart to `typeIntoEditor`, and the right tool whenever the payload
 * is markdown rather than keystrokes: a paste is not tokenized by CM6's input
 * handlers, so brackets do not auto-close, list continuation does not fire, and
 * — the reason this exists — the pipeline probe's `"q"` never touches the
 * document. Anything whose exact bytes matter (a fixture body, a capture's
 * sample note) wants this; anything testing the typing path itself wants
 * `typeIntoEditor`.
 *
 * The caret is left at the document START so every live-preview widget renders:
 * CM6 shows the SOURCE of the block under the cursor, so a caret parked in the
 * pasted body would leave that one block un-decorated.
 *
 * Insertion goes to the document END, after the managed frontmatter — pasting at
 * the top displaces the title/updated block below line 1, which breaks title
 * parsing ("Untitled") and dumps raw frontmatter as a trailing code block.
 */
export async function pasteIntoEditor(session: Session, text: string): Promise<void> {
  const CONTROL = String.fromCharCode(0xe009);
  const END = String.fromCharCode(0xe010);
  const HOME = String.fromCharCode(0xe011);
  // Re-fetch the `.cm-content` handle right before each keystroke op: CM6
  // remounts on note-switch/focus, which staleness-invalidates a handle held
  // across awaits. On a stale throw, settle and retry once — the remount has
  // finished by then.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await (await session.waitForElement(CM_CONTENT)).click();
      await (await session.waitForElement(CM_CONTENT)).sendKeys(CONTROL + END + CONTROL);
      // `querySelector` inside the page is always fresh — no stale handle.
      await session.execute(
        "var el = document.querySelector(arguments[0]);" +
          "el.focus();" +
          "var dt = new DataTransfer();" +
          "dt.setData('text/plain', arguments[1]);" +
          "el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));",
        [CM_CONTENT, text],
      );
      await (await session.waitForElement(CM_CONTENT)).sendKeys(CONTROL + HOME + CONTROL);
      await session.waitUntil(async () => (await editorText(session)).length > 5 || null, {
        label: "pasted body landed",
        timeoutMs: 5_000,
      });
      return;
    } catch (e) {
      if (attempt === 1) throw e;
      await new Promise((r) => setTimeout(r, 800)); // CM remount settling
    }
  }
}

/**
 * Fill the 24 recovery phrase cells (in DOM order) and leave the
 * screen ready for `recover.submit`. Used by the VR-1 drill and the
 * slot-priority reload scenarios.
 */
export async function enterRecoveryPhrase(session: Session, phrase: string): Promise<void> {
  const cells = await session.waitUntil(
    async () => {
      const found = await session.byTestIdAll("recover.phrase-cell");
      return found.length === 24 ? found : null;
    },
    { label: "24 phrase cells", timeoutMs: 15_000 },
  );
  const words = phrase.split(" ");
  // Length-only compare: a toHaveLength failure would print the
  // received ARRAY (the phrase words) into CI logs — SYNC-13.
  expect(words.length).toBe(24);
  for (let i = 0; i < 24; i++) {
    await cells[i].sendKeys(words[i]);
  }
}

/**
 * Poll `sample` until `stable` CONSECUTIVE readings are identical, then return
 * the last one parsed. A reading of `null` means "not measurable yet" and resets
 * the run rather than counting toward it.
 *
 * Asserting on a FIRST reading is how a geometry or pixel scenario passes
 * against a build with the fix REMOVED. `editor-scroll-slack.e2e.ts` learned
 * that from a virtualised viewport, `graph-settings.e2e.ts` from a canvas
 * mid-repaint, `graph-tab.e2e.ts` from a sidebar width transition. Three specs
 * had grown three private copies of this loop with three different stability
 * windows and no way to compare them; this is the one they share.
 *
 * `stable` is how many readings must AGREE, not how many are taken. Two is
 * enough for a value that moves monotonically toward rest (a CSS transition);
 * raise it for a sampler that can legitimately repeat a value mid-flight.
 *
 * The parsed value is BOXED before it goes to `waitUntil`, which returns only on
 * a truthy predicate result. Unboxed, a `T` that settles at `0`, `""`, `false`
 * or `NaN` reads as "not settled yet", so the helper polls out its whole budget
 * and then reports that a value never settled when it settled immediately. Both
 * callers today parse to objects; a scroll offset resting at 0 or a count
 * resting at 0 is exactly what a generic helper gets asked for next.
 *
 * One deliberate hold-out: `graph-settings.e2e.ts`'s `waitForCanvasQuiet` keeps
 * its own copy, and says why at its definition. Its window and interval are
 * tuned against that suite's repaint timings, so folding it in here would move
 * a stability window nobody is otherwise touching.
 */
export async function settleOn<T>(
  session: Session,
  sample: () => Promise<string | null>,
  opts: { label: string; parse: (raw: string) => T; stable?: number; timeoutMs?: number },
): Promise<T> {
  const need = opts.stable ?? 2;
  let previous: string | null = null;
  let run = 0;
  const box = await session.waitUntil<{ v: T }>(
    async () => {
      const raw = await sample();
      if (raw === null) {
        previous = null;
        run = 0;
        return null;
      }
      run = raw === previous ? run + 1 : 1;
      previous = raw;
      return run >= need ? { v: opts.parse(raw) } : null;
    },
    { label: opts.label, timeoutMs: opts.timeoutMs ?? 20_000 },
  );
  return box.v;
}

/**
 * Open the whole-vault graph and return its pane.
 *
 * Through the PALETTE, not a testid: `editor.graph-button` was the BottomBar
 * launcher, and myne-md/myne#727 removed the launcher from the bottom bar
 * entirely (it is a command the left ribbon hosts on the user's own terms, and a
 * corner-pinned button was a second, uncustomizable place for it). The palette
 * is the one entry point every build has, and `graph.show` is its frozen
 * command id, so this cannot drift with a chrome decision again.
 */
export async function openGraphPane(session: Session): Promise<Element> {
  await runPaletteAction(session, "graph.show", "graph");
  return session.byTestId("editor.graph-pane", { timeoutMs: 15_000 });
}

/**
 * `openGraphPane`, then wait until the model has been built once AND the canvas
 * has mounted, which is the state every graph scenario actually needs.
 *
 * THE CANVAS WAIT IS NOT OPTIONAL, and it is not the same wait as the pane's.
 * `GraphCanvas` sits behind the app's only `React.lazy` boundary
 * (`GraphView.tsx`) and mounts a few hundred ms AFTER the pane, while the
 * Suspense fallback is still up. `data-layout-nonce` lives on the PANE, so a
 * probe gated only on it reads a DOM with no `<canvas>` in it at all.
 *
 * Four specs had written this sequence out, three of them carrying a comment
 * saying they had copied it from one of the others.
 */
export async function openSettledGraphPane(
  session: Session,
): Promise<{ pane: Element; canvas: Element }> {
  const pane = await openGraphPane(session);
  await session.waitUntil(
    async () => ((await pane.attribute("data-layout-nonce")) === "1" ? true : null),
    { label: "graph builds once", timeoutMs: 15_000 },
  );
  const canvas = await session.byTestId("editor.graph-canvas", { timeoutMs: 15_000 });
  return { pane, canvas };
}

/** The right-panel tab ids in current DOM (display) order.
 *
 *  Three suites had their own copy. The filter drops rows whose
 *  `data-panel-tab-id` is absent rather than yielding a null into the array. */
export async function tabIds(session: Session): Promise<string[]> {
  const els = await session.byTestIdAll("editor.right-panel-tab");
  const ids = await Promise.all(els.map((e) => e.attribute("data-panel-tab-id")));
  return ids.filter((id): id is string => id !== null);
}

/** The `<html>` element's inline `style` attribute, or `""` when there is none.
 *
 *  The theme suites read this to assert the palette reached the document root.
 *  Three suites had their own copy; the `catch` is deliberate — a missing
 *  `style` attribute is a legitimate state (no theme applied), not an error. */
export async function rootInlineStyle(session: Session): Promise<string> {
  const v = await (await session.findElement("html")).attribute("style").catch(() => null);
  return v ?? "";
}

/**
 * Collapse the notes sidebar, re-clicking until `data-collapsed` actually flips.
 *
 * The only way a scenario can change the editor pane's WIDTH without changing
 * the window's. The harness has no window-resize primitive, and this is the
 * stronger case anyway: it is exactly what a `window`-scoped resize listener
 * cannot hear.
 *
 * Both sidebar states share one testid and differ only by attribute, which is
 * why this goes through `clickUntilTrue` rather than `clickUntilVisible`.
 */
export async function collapseNotesSidebar(session: Session): Promise<void> {
  const selector = testIdSelector("editor.sidebar-toggle", { "data-side": "left" });
  const collapsed = async (): Promise<boolean> => {
    const [el] = await session.findElements(selector);
    return el !== undefined && (await el.attribute("data-collapsed")) === "true";
  };
  await clickUntilTrue(session, selector, {
    done: collapsed,
    label: "the notes sidebar collapses",
    what: "collapseNotesSidebar",
    trigger: "[editor.sidebar-toggle][data-side=left]",
    outcome: 'data-collapsed="true"',
  });
}

/**
 * Open the sidebar context menu's `Export…` submenu and return the row for one
 * format.
 *
 * The four formats used to be top-level rows. They moved behind one parent row
 * (myne-md/myne#611) because eight rows across two menus for four actions is
 * what the maintainer was looking at, and the leaf ids did not change, so a
 * scenario that reaches straight for `export-markdown` still COMPILES, still
 * reads correct, and simply times out. That is the failure
 * `check-e2e-menu-testids.mjs` exists to prevent for the sidebar `+` menu, and
 * its roster does not cover this menu, so this helper is the substitute: one
 * place that knows the submenu is there.
 *
 * The parent click is safe to repeat. Unlike the `+` menu, whose every item
 * COMMITS, a row carrying `children` performs no action at all: `ContextMenu`'s
 * `handleSelect` returns early for it and the click handler only records where
 * to put the submenu. So a missed click and a landed click are both recoverable
 * by clicking again, and neither can double-fire an export.
 *
 * Call it with the menu already open (after `row.rightClick()`).
 */
export async function openExportSubmenuItem(
  session: Session,
  format: "export-markdown" | "export-pdf" | "export-html" | "export-txt",
) {
  const leaf = testIdSelector("notes.context-menu-item", {
    "data-item-id": format,
  });
  await session.waitUntil(
    async () => {
      if ((await session.findElements(leaf)).length > 0) return true;
      const parent = await session.findElements(
        testIdSelector("notes.context-menu-item", { "data-item-id": "export" }),
      );
      // The menu itself may not have rendered yet; let the outer budget poll
      // rather than throwing on a parent row that is simply not there.
      if (parent.length === 0) return null;
      await parent[0].click();
      return (await session.findElements(leaf)).length > 0 ? true : null;
    },
    { label: `export submenu open, ${format} present` },
  );
  return session.waitForElement(leaf);
}

/**
 * Walk the desktop FIRST RUN from the welcome screen: the one create door, the
 * identity's phrase ceremony (reveal, continue, 4-of-24 type-back), and Done,
 * which hands off to vault creation (myne-md/myne#911 task 6).
 *
 * It returns nothing, because everything a caller needs to assert about the
 * identity is the fact that it exists: the phrase is never returned, never
 * logged, and never written to an artefact (SYNC-13). The words are scraped in
 * one in-page pass, used to fill the challenge, and dropped.
 *
 * What it does NOT do is save the phrase to a file: the save action goes through
 * the OS dialog, which this harness cannot answer, and the type-back is the gate
 * the flow actually enforces. A scenario that needs the phrase on disk for a
 * later recovery step must scrape it itself and treat it as a credential.
 *
 * Every scenario that used to click `welcome.create-cta` and land in vault
 * creation now calls this first, because the welcome screen no longer creates a
 * vault directly: identity first, then the vault.
 */
export async function startFirstRunIdentity(
  session: Session,
  /**
   * Which welcome door opens the ceremony. The create door by default; the
   * invited door (`welcome.invited-cta`) runs the SAME ceremony and only its
   * landing differs, so one helper serves both rather than a copy that could
   * drift on the phrase or the type-back.
   */
  doorTestId = "welcome.create-cta",
): Promise<string[]> {
  await (await session.byTestId(doorTestId, { timeoutMs: 20_000 })).click();
  await session.byTestId("first-run.root", { timeoutMs: 15_000 });
  await (await session.byTestId("first-run.identity.create-cta", { timeoutMs: 20_000 })).click();

  // Step 1: the phrase. Continue is gated on the words having been revealed,
  // and revealing is what makes them readable to the scrape below.
  await session.byTestId("first-run.identity.phrase", { timeoutMs: 120_000 });
  await (await session.byTestId("first-run.identity.phrase-reveal")).click();
  const words = await session.execute<string[]>(
    "var words = [];" +
      "for (var i = 1; i <= 24; i++) {" +
      "  var el = document.querySelector(" +
      "    '[data-testid=\"first-run.identity.phrase-word\"][data-index=\"' + i + '\"] span:last-child');" +
      "  words.push(el ? el.textContent || '' : '');" +
      "}" +
      "return words;",
  );
  expect(words.length).toBe(24);
  expect(words.every((w) => w.length > 0)).toBe(true);

  const cont = await session.byTestId("first-run.identity.phrase-continue");
  await session.waitUntil(() => cont.enabled(), {
    label: "identity phrase continue enabled after reveal",
    timeoutMs: 10_000,
  });
  await cont.click();

  // Step 2: the type-back. Each input declares its 1-based position.
  const cells = await session.byTestIdAll("first-run.identity.confirm-input");
  expect(cells.length).toBe(4);
  for (const cell of cells) {
    const pos = Number(await cell.attribute("data-index"));
    expect(pos).toBeGreaterThanOrEqual(1);
    expect(pos).toBeLessThanOrEqual(24);
    await cell.sendKeys(words[pos - 1]);
  }
  const done = await session.byTestId("first-run.identity.close-cta");
  await session.waitUntil(() => done.enabled(), {
    label: "identity done enabled after type-back",
    timeoutMs: 10_000,
  });
  await done.click();

  // Returned so a scenario that needs the identity LATER can use it: unlocking
  // the identity for a session is a real, frequent step (the person keypair is
  // session-scoped, decision 0612, so a vault unlock does not carry it), and the
  // phrase is the only credential that performs it.
  return words;
}

/**
 * [`startFirstRunIdentity`] plus the vault steps that follow it on the FIRST RUN:
 * the safety briefing (three acknowledgements), and the vault-name step, so the
 * caller lands on the password form (myne-md/myne#911 task 6).
 *
 * The briefing is still shown here, and it is not an oversight: its three
 * statements are about the PASSWORD and the phrase, and the phrase it names is
 * the identity's, which the user has just proved they saved. What it no longer
 * has is a vault kit after it.
 */
export async function startFirstRunToVault(session: Session): Promise<void> {
  await startFirstRunIdentity(session);

  await session.byTestId("create.briefing", { timeoutMs: 15_000 });
  const cont = await session.byTestId("create.briefing-continue");
  const acks = await session.byTestIdAll("create.briefing-ack");
  expect(acks.length).toBe(3);
  for (const ack of acks) {
    await ack.click();
  }
  await session.waitUntil(() => cont.enabled(), {
    label: "briefing continue enabled (3/3 acknowledged)",
    timeoutMs: 10_000,
  });
  await cont.click();

  await (await session.byTestId("create.name-input", { timeoutMs: 15_000 })).sendKeys("E2E Kasa");
  await (await session.byTestId("create.name-continue")).click();
  await session.byTestId("create.password-input", { timeoutMs: 10_000 });
}
