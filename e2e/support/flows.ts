// Shared in-app flow fragments used by multiple scenario suites.
//
// SYNC-13: helpers here never log credential-bearing values; assertion
// shapes are length-only / index-only. The note-editing helpers carry
// note-content markers — the accepted in-source scenario-constant
// class (not credentials; see the notes suite header).

import { expect } from "vitest";
import { testIdSelector, WebDriverError, type Session } from "./webdriver";

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
  await session.waitForElement(
    `${testIdSelector("unlock.password-input")}, ${testIdSelector("unlock.use-password-link")}`,
    { timeoutMs },
  );
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
      try {
        await (await session.byTestId("editor.content", { timeoutMs: 400 })).click();
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

/** Open the command palette via Ctrl+K (retrying the chord), then filter by
 *  typing `query` and run the matching action row by its `data-action-id`. */
export async function runPaletteAction(
  session: Session,
  actionId: string,
  query: string,
): Promise<void> {
  await openPalette(session);
  await (await session.byTestId("palette.input")).sendKeys(query);
  await (
    await session.waitForElement(
      testIdSelector("palette.option", { "data-action-id": actionId }),
    )
  ).click();
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
  await openPalette(session);
  await (await session.byTestId("palette.input")).sendKeys(query);
  await (
    await session.waitForElement(
      testIdSelector("palette.option", { "data-kind": "note", "data-note-id": noteId }),
    )
  ).click();
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
  | "privacy"
  | "sync"
  | "editor"
  | "files"
  | "hotkeys"
  | "appearance"
  | "storage"
  | "ai"
  | "network"
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
  // (developer mode, then `setSettingsSwitch` → here), so ai-chat, ai-summarize,
  // ai-embeddings-persistence and transcription were all failing in CI on this
  // one line.
  if ((await session.byTestIdAll("settings.modal")).length === 0) {
    await (await session.byTestId("editor.settings-cta")).click();
    await session.byTestId("settings.modal");
  }
  if (tab && tab !== "account") {
    await (await session.byTestId(`settings.tab-${tab}`)).click();
  }
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
    toggleTestId: string;
    enabled: boolean;
    label: string;
  },
): Promise<void> {
  const want = opts.enabled ? "true" : "false";
  await openSettings(session, opts.tab);
  if (opts.panelTestId !== undefined) await session.byTestId(opts.panelTestId);
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
    toggleTestId: "settings.views-enabled",
    enabled,
    label: "views_enabled",
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
    await (await session.byTestId("about.developer-mode-toggle")).click();
  }
  await session.waitUntil(async () => ((await checked()) === "true" ? true : null), {
    label: "developer_mode toggled on",
    timeoutMs: 10_000,
  });
  await session.waitForElement(testIdSelector("settings.developer-group"));
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

/** Set the auto-tag sub-switch via Settings → AI (MYND-651). Off by default, and
 *  the host re-reads BOTH it and `ai_enabled` before any model touch — so a
 *  caller that wants the inline suggestion band must have called {@link enableAi}
 *  first. The toggle renders disabled while `ai_enabled` is off, so an
 *  out-of-order call would silently do nothing. */
export async function setAutoTagEnabled(session: Session, enabled: boolean): Promise<void> {
  await setSettingsSwitch(session, {
    tab: "ai",
    panelTestId: "settings.ai-panel",
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

const CM_CONTENT = '[data-testid="editor.content"] .cm-content';

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
  const [tab] = await session.findElements('[data-testid="editor.tab"][data-active="true"]');
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
  // Which half went missing is the whole diagnosis, and a label naming only the
  // pair loses it: "the trigger never rendered" (a missing precondition — see
  // the five Views specs that never enabled `settings.views-enabled`) and "the
  // trigger is there but its click keeps missing" (the flake this exists for)
  // are different bugs with different fixes. Track it and say which.
  let everSawTrigger = false;
  try {
    await session.waitUntil(
      async () => {
        if ((await session.byTestIdAll(revealedTestId)).length > 0) return true;
        const trigger = await session.byTestIdAll(triggerTestId);
        if (trigger.length === 0) return null;
        everSawTrigger = true;
        await trigger[0].click();
        for (let i = 0; i < 20; i++) {
          if ((await session.byTestIdAll(revealedTestId)).length > 0) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return null;
      },
      { label: `${triggerTestId} reveals ${revealedTestId}` },
    );
  } catch (e) {
    const why = everSawTrigger
      ? `[${triggerTestId}] rendered and was clicked, but [${revealedTestId}] never appeared`
      : `[${triggerTestId}] NEVER RENDERED — nothing was ever clicked. This is a missing precondition, not a flaky click (e.g. a feature still behind its setting).`;
    throw new Error(`clickUntilVisible: ${why}\n${(e as Error).message}`);
  }
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
export async function clickNewMenuItem(session: Session, testId: string): Promise<void> {
  if ((await session.byTestIdAll("notes.new-menu-dropdown")).length === 0) {
    await session.waitUntil(
      async () => {
        if ((await session.byTestIdAll("notes.new-menu-dropdown")).length > 0) return true;
        const trigger = await session.byTestIdAll("notes.new-menu");
        // Sidebar not mounted yet — let the outer budget keep polling rather
        // than throwing on a `+` that simply has not rendered.
        if (trigger.length === 0) return null;
        await trigger[0].click();
        for (let i = 0; i < 20; i++) {
          if ((await session.byTestIdAll("notes.new-menu-dropdown")).length > 0) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return null;
      },
      { label: "new-menu dropdown open" },
    );
  }
  // The ITEM click needs the same re-click the trigger got, and for the same
  // reason — but it cannot simply be repeated: every item in this menu COMMITS
  // (creates a note, opens the new-folder input), so a blind second click on a
  // first click that actually landed would create two.
  //
  // The menu's own render gives the invariant that makes the retry safe.
  // `NoteList.tsx`'s `item()` runs `setOpen(false)` BEFORE the action, for all
  // four items, so:
  //   - the click landed  -> the dropdown is gone, and there is nothing to retry
  //   - the click missed  -> the dropdown is still up, and nothing was committed
  // Re-clicking only while the dropdown is still present is therefore exactly
  // the "the click provably did nothing" case, and cannot double-commit.
  await session.waitUntil(
    async () => {
      if ((await session.byTestIdAll("notes.new-menu-dropdown")).length === 0) return true;
      const [item] = await session.byTestIdAll(testId);
      if (!item) return null;
      await item.click();
      for (let i = 0; i < 20; i++) {
        if ((await session.byTestIdAll("notes.new-menu-dropdown")).length === 0) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    },
    { label: `new-menu item [${testId}] committed (dropdown closed)` },
  );
}

/** Create a note via the sidebar CTA and commit `title` through the
 *  inline-rename input (Enter). Leaves the note selected. */
export async function createNote(session: Session, title: string): Promise<void> {
  await clickNewMenuItem(session, "notes.create");
  const rename = await session.byTestId("notes.rename-input");
  await rename.sendKeys(`${title}`);
  await session.waitForGone(testIdSelector("notes.rename-input"));
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

/** Wait until the autosave badge settles on "Saved" AFTER having seen
 *  the edit register ("Editing…"/"Saving…") — polling for "Saved" alone
 *  could match the pre-edit clean state. */
export async function waitForSaved(session: Session): Promise<void> {
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

/** Current CodeMirror document text (`textContent()` — the doc lives in
 *  nested .cm-line elements this driver's getText drops). Re-found per
 *  call: CM remounts across relock/reload. */
export async function editorText(session: Session): Promise<string> {
  return (await session.waitForElement(CM_CONTENT)).textContent();
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
