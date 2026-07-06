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
// The note's SHAPE (frontmatter `title:` + body) and the catalog key names
// live in the shared `@myne/dialect/welcomeNote` builder, which the mobile
// client (`myne-mobile/src/lib/welcomeNote.ts`) consumes too — this file
// adds only the desktop-specific parts: i18n resolution and the MYW1
// workspace pre-seed.
//
// i18n: the copy is resolved at SEED TIME via the i18n runtime (NOT frozen at
// module load), so the Welcome note is authored in whatever language is active
// when the vault is created. The title/body/markdown are getter FUNCTIONS for
// exactly this reason — a module-scope const would capture the boot language.
//
// Auto-open without touching Editor.tsx: the editor restores its pane/tab
// layout from the `vault.workspace` (MYW1) descriptor on mount. We write a
// one-pane descriptor with the Welcome note as its active tab, so the
// existing restore path opens it — no Editor changes, no first-note
// auto-select special case.

import {
  buildWelcomeNoteMarkdown,
  WELCOME_NOTE_TITLE_KEY,
  WELCOME_NOTE_BODY_KEY,
} from "../dialect/welcomeNote";
import i18n from "../i18n";
import { noteCreate } from "./createNote";
import { emptyWorkspace, openInFocusedTab } from "./workspaceState";
import { serializeWorkspace, workspaceWrite } from "../lib/workspace-persist";

/** The sidebar/tab title. Notes derive their title from the frontmatter
 *  `title:` field ONLY — never a body `# H1` (loadNoteBatch.ts) — so the
 *  Welcome note must carry it in frontmatter or it renders as "Untitled".
 *  Resolved at call time (reactive to the active language). */
export function welcomeNoteTitle(): string {
  return i18n.t(WELCOME_NOTE_TITLE_KEY);
}

/** The Welcome note body (Markdown). No leading `# H1`: the title chip
 *  already shows the title, so a duplicate heading would just be noise. The
 *  myne.md link is a bare URL on purpose — only bare URLs and `<angle>`
 *  autolinks are click-to-open in the editor (`[text](url)` links render but
 *  aren't clickable, autolink.ts). A friendly welcome, not a feature tour.
 *  Resolved at call time (reactive to the active language). */
export function welcomeNoteBody(): string {
  return i18n.t(WELCOME_NOTE_BODY_KEY);
}

/**
 * Full note plaintext via the shared cross-client builder. A FUNCTION (not a
 * const) so the copy reflects the active language at seed time rather than
 * the boot language.
 */
export function welcomeNoteMarkdown(): string {
  return buildWelcomeNoteMarkdown(welcomeNoteTitle(), welcomeNoteBody());
}

/**
 * Best-effort: create the Welcome note and pre-seed the workspace so the
 * editor opens it on mount. NEVER throws — a failure here must not derail
 * the (already-successful) auto-unlock → editor transition; the user just
 * lands on an empty editor. The caller guards `HAS_TAURI` (real IPC only).
 */
export async function seedWelcomeNote(): Promise<void> {
  try {
    const noteId = await noteCreate(welcomeNoteMarkdown());
    // One pane, the Welcome note as its single active+focused tab — the
    // same shape the restore path produces, so it opens with no Editor.tsx
    // changes.
    const ws = openInFocusedTab(emptyWorkspace(crypto.randomUUID()), {
      kind: "note",
      id: noteId,
    });
    await workspaceWrite(serializeWorkspace(ws));
  } catch {
    // Onboarding nicety, not load-bearing — swallow any IPC/encode failure.
  }
}
