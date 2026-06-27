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
  await (await session.byTestId("unlock.password-input")).sendKeys(password);
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

/** Open the command palette via its Ctrl+K hotkey (the Linux-container
 *  modifier — the `palette.toggle` keybind defaults to Mod-k / Mod-p) and
 *  wait for the palette input. Pure-key chord through the W3C Actions API:
 *  Control DOWN → k DOWN → k UP → Control UP. Then optionally filter by
 *  typing `query` and run the matching action row by its `data-action-id`. */
export async function runPaletteAction(
  session: Session,
  actionId: string,
  query: string,
): Promise<void> {
  const CONTROL = "\uE009"; // W3C Actions API code point for Control
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
  const CONTROL = "\uE009"; // W3C Actions API code point for Control
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

/** Open the Settings modal from the editor's gear button and wait for
 *  the dialog root. Optionally switch to a rail tab (the modal always
 *  opens on Account). */
export async function openSettings(
  session: Session,
  tab?:
    | "account"
    | "privacy"
    | "editor"
    | "files"
    | "hotkeys"
    | "appearance"
    | "storage"
    | "about",
): Promise<void> {
  await (await session.byTestId("editor.settings-cta")).click();
  await session.byTestId("settings.modal");
  if (tab && tab !== "account") {
    await (await session.byTestId(`settings.tab-${tab}`)).click();
  }
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
  const landed = async () => (await editorText(session)).includes(text) || null;
  await content.sendKeys(text);
  try {
    await session.waitUntil(landed, {
      label: "typed text landed in the document",
      timeoutMs: 5_000,
    });
  } catch {
    await content.sendKeys(text);
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
