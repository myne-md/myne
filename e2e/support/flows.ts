// Shared in-app flow fragments used by multiple scenario suites.
//
// SYNC-13: helpers here never log credential-bearing values; assertion
// shapes are length-only / index-only. The note-editing helpers carry
// note-content markers — the accepted in-source scenario-constant
// class (not credentials; see the notes suite header).

import { expect } from "vitest";
import { testIdSelector, type Session } from "./webdriver";

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
  timeoutMs = 30_000,
): Promise<void> {
  const input = await session.byTestId("unlock.password-input");
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
async function openPalette(session: Session): Promise<void> {
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
  await session.byTestId("unlock.password-input", { timeoutMs: 30_000 });
  await unlockToEditor(session, password);
  await dismissImporterOfferIfPresent(session);
}

/** Open the Settings modal from the editor's gear button and wait for
 *  the dialog root. Optionally switch to a rail tab (the modal always
 *  opens on Account). */
export async function openSettings(
  session: Session,
  tab?:
    | "account"
    | "privacy"
    | "sync"
    | "editor"
    | "files"
    | "hotkeys"
    | "appearance"
    | "storage"
    | "ai"
    | "about",
): Promise<void> {
  await (await session.byTestId("editor.settings-cta")).click();
  await session.byTestId("settings.modal");
  if (tab && tab !== "account") {
    await (await session.byTestId(`settings.tab-${tab}`)).click();
  }
}

/** Enable the local-AI master switch via Settings → AI → toggle, then close
 *  the modal. The switch is off by default (opt-in, SYNC-12); the `ai.*`
 *  editor extensions (ghost-text, slash) compose only when it is on, so callers
 *  that drive those flows enable AI BEFORE opening the target note. Reflects the
 *  persisted pref via `aria-checked` on the `role="switch"` element. Requires the
 *  `local-inference`(-stub) build — the AI settings tab is absent otherwise. */
export async function enableAi(session: Session): Promise<void> {
  await openSettings(session, "ai");
  await session.byTestId("settings.ai-panel");
  await (await session.byTestId("ai.enable-toggle")).click();
  await session.waitUntil(
    async () =>
      (await (await session.byTestId("ai.enable-toggle")).attribute("aria-checked")) === "true"
        ? true
        : null,
    { label: "ai_enabled toggled on", timeoutMs: 10_000 },
  );
  await closeSettings(session);
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

/** Create a note via the sidebar CTA and commit `title` through the
 *  inline-rename input (Enter). Leaves the note selected. */
export async function createNote(session: Session, title: string): Promise<void> {
  await (await session.byTestId("notes.create")).click();
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
 *  leftover truncated fragment are harmless. */
export async function typeIntoEditor(session: Session, text: string): Promise<void> {
  const content = await session.waitForElement(CM_CONTENT);
  await content.click();
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
  const flat = norm(text);
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
