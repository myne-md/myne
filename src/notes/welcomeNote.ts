// MYND-118 — onboarding Welcome note, seeded on first vault open.
//
// After a freshly-created vault auto-unlocks (CreateVault's auto-unlock
// chain), we write one ordinary `.myn` note — an "Welcome to Myne" — and
// open it in the editor by pre-seeding the workspace descriptor the editor
// restores on mount. It is a NORMAL note: editable, renamable, deletable,
// no read-only / no special-casing (the issue's "nothing here is special"
// discipline). Seeded exactly once, on the create→unlock path only — never
// re-created on later unlocks.
//
// i18n: English only. No i18n layer exists in the client yet (the B17
// translation consumer is deferred); when it lands the copy moves into the
// string catalog and is localized at create-time from the detected locale.
//
// Auto-open without touching Editor.tsx: the editor restores its pane/tab
// layout from the `vault.workspace` (MYW1) descriptor on mount. We write a
// one-pane descriptor with the Welcome note as its active tab, so the
// existing restore path opens it — no Editor changes, no first-note
// auto-select special case.

import { patchTitleField } from "../dialect";
import { noteCreate } from "./createNote";
import { emptyWorkspace, openInFocusedTab } from "./workspaceState";
import { serializeWorkspace, workspaceWrite } from "../lib/workspace-persist";

/** The sidebar/tab title. Notes derive their title from the frontmatter
 *  `title:` field ONLY — never a body `# H1` (loadNoteBatch.ts) — so the
 *  Welcome note must carry it in frontmatter or it renders as "Untitled". */
export const WELCOME_NOTE_TITLE = "Welcome to Myne";

/** The Welcome note body (Markdown). No leading `# H1`: the title chip
 *  already shows "Welcome to Myne", so a duplicate heading would just be
 *  noise. The `[[My First Idea]]` wikilink is intentionally broken so a
 *  curious click demonstrates the unwritten-note UX. */
const WELCOME_NOTE_BODY = `Your **password** and **recovery phrase** are the only keys to these notes. Lose both and no one can recover them.

This is an ordinary note — edit, rename, or delete it. Markdown works, and you can link notes like [[My First Idea]] (that link's broken on purpose — click it).
`;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Full note plaintext: a frontmatter `title:` block (so the sidebar/tab
 * shows "Welcome to Myne", not "Untitled") followed by the Markdown body.
 * Built via the canonical dialect helper so quoting/format match every
 * other Myne-written note.
 */
export const WELCOME_NOTE_MARKDOWN = utf8Decoder.decode(
  patchTitleField(utf8Encoder.encode(WELCOME_NOTE_BODY), WELCOME_NOTE_TITLE),
);

/**
 * Best-effort: create the Welcome note and pre-seed the workspace so the
 * editor opens it on mount. NEVER throws — a failure here must not derail
 * the (already-successful) auto-unlock → editor transition; the user just
 * lands on an empty editor. The caller guards `HAS_TAURI` (real IPC only).
 */
export async function seedWelcomeNote(): Promise<void> {
  try {
    const noteId = await noteCreate(WELCOME_NOTE_MARKDOWN);
    // One pane, the Welcome note as its single active+focused tab — the
    // same shape the restore path produces, so it opens with no Editor.tsx
    // changes.
    const ws = openInFocusedTab(emptyWorkspace(crypto.randomUUID()), noteId);
    await workspaceWrite(serializeWorkspace(ws));
  } catch {
    // Onboarding nicety, not load-bearing — swallow any IPC/encode failure.
  }
}
