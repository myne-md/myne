// #393 — first-run example vault, seeded on the create→unlock path.
//
// Supersedes the single Welcome note (MYND-118) on desktop: writes a small set
// of ordinary `.myn` notes under one "Getting started/" folder and opens the
// index note via the MYW1 workspace pre-seed. Ordinary notes throughout —
// editable, renamable, deletable, no read-only / no special-casing — and the
// whole set clears in one folder-delete (recoverable from Trash).
//
// The note SHAPE and copy KEYS live in the shared `@myne/dialect/exampleVault`
// builder (mobile will consume it in its own pass); this file adds the
// desktop-specific parts: i18n resolution (language-reactive at seed time, so
// the vault is authored in whatever language is active when it is created) and
// the workspace pre-seed. Bodies cross-link by title through interpolation
// placeholders filled here with the resolved titles, so no link is ever broken
// in any locale.

import {
  buildExampleNoteMarkdown,
  EXAMPLE_FOLDER_KEY,
  EXAMPLE_NOTES,
} from "../dialect/exampleVault";
import i18n from "../i18n";
import { noteCreate } from "./createNote";
import { emptyWorkspace, openInFocusedTab } from "./workspaceState";
import { serializeWorkspace, workspaceWrite } from "../lib/workspace-persist";

/** One resolved example note, ready to write. */
export interface ResolvedExampleNote {
  readonly role: string;
  readonly title: string;
  readonly folder: string;
  /** Full note plaintext (frontmatter + body), as `noteCreate` receives it. */
  readonly markdown: string;
  readonly index: boolean;
}

/**
 * Resolve the example notes through i18n (language-reactive at call time) and
 * assemble each note's plaintext — the pure, IPC-free half of {@link
 * seedExampleVault}, exported so `tests/notes/exampleVault.test.ts` can pin the
 * copy invariants (every placeholder filled, every `[[link]]` targets a real
 * seeded title). Bodies name their sibling notes through interpolation vars
 * keyed by role, so a `[[link]]` always carries the note's ACTUAL (resolved)
 * title rather than a hardcoded English one.
 */
export function resolveExampleNotes(): ResolvedExampleNote[] {
  const folder = i18n.t(EXAMPLE_FOLDER_KEY);
  const titleVars: Record<string, string> = {};
  for (const spec of EXAMPLE_NOTES) titleVars[spec.role] = i18n.t(spec.titleKey);

  return EXAMPLE_NOTES.map((spec) => {
    const title = titleVars[spec.role];
    const body = i18n.t(spec.bodyKey, titleVars);
    return {
      role: spec.role,
      title,
      folder,
      markdown: buildExampleNoteMarkdown(title, folder, body, {
        index: spec.index === true,
      }),
      index: spec.index === true,
    };
  });
}

/**
 * Best-effort: seed the example vault and pre-seed the workspace so the editor
 * opens the index note on mount. NEVER throws — a failure here must not derail
 * the (already-successful) auto-unlock → editor transition; the user just lands
 * on an empty editor. The caller guards `HAS_TAURI` (real IPC only).
 */
export async function seedExampleVault(): Promise<void> {
  try {
    let indexNoteId: string | null = null;
    for (const note of resolveExampleNotes()) {
      const noteId = await noteCreate(note.markdown);
      if (note.index) indexNoteId = noteId;
    }

    if (indexNoteId !== null) {
      // One pane, the index note as its single active+focused tab — the same
      // shape the restore path produces, so it opens with no Editor.tsx change.
      const ws = openInFocusedTab(emptyWorkspace(crypto.randomUUID()), {
        kind: "note",
        id: indexNoteId,
      });
      await workspaceWrite(serializeWorkspace(ws));
    }
  } catch {
    // Onboarding nicety, not load-bearing — swallow any IPC/encode failure.
  }
}
