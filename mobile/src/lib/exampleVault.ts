// First-run example vault: mobile's seeder over the SHARED builder
// (`@myne/dialect/exampleVault`; the desktop counterpart is
// `src/notes/exampleVault.ts`, #393).
//
// # Why this file exists now
//
// Desktop stopped seeding a single "Welcome to Myne" note and started seeding a
// small worked example (#393, `design-notes/editor/0456`). That decision
// recorded mobile as a TEMPORARY divergence: mobile kept seeding the one note
// "until its companion change lands". It never landed, so a vault created on a
// phone and a vault created on a computer handed the user two different first
// runs. Same product, same promise, different contents (myne-md/myne#960). The
// note SET is one question with one answer, so both clients now read it from the
// shared builder; this file is only the mobile half, being the IPC calls and the
// language resolution.
//
// # What stays per platform, and why that is not drift
//
// The shared builder owns the note SHAPE and the catalog keys; each client
// resolves the copy through its own runtime and passes the strings in. Desktop
// pre-seeds the `MYW1` workspace descriptor so its editor opens the index note on
// mount; mobile has no workspace plugin and lands on the notes list, which is
// the mobile list-first UX, so there is nothing to pre-seed here.
//
// # Best effort, always
//
// A failure must not derail the already-successful auto-unlock. The caller
// guards `HAS_TAURI` (real IPC only); anything thrown here is swallowed and the
// user gets an empty vault rather than a broken one.

import i18n from "@myne/i18n";
import {
  buildExampleNoteMarkdown,
  EXAMPLE_FOLDER_KEY,
  EXAMPLE_NOTES,
} from "../dialect/exampleVault";
import { normalizeFolderPath } from "../dialect/folderPath";
import { mutateDeliberateFolders } from "./prefs";
import { stampUpdated } from "./note-organize";
import { noteCreate } from "./notes";

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
 * Resolve the example notes through i18n at CALL time (not module load), so a
 * vault created right after the user switches language is authored in that
 * language. Exported so the mobile tests can pin the copy invariants: every
 * placeholder filled, every `[[link]]` targeting a seeded title, against the
 * same resolution the seeder uses.
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
      markdown: stampUpdated(
        buildExampleNoteMarkdown(title, folder, body, { index: spec.index === true }),
      ),
      index: spec.index === true,
    };
  });
}

/**
 * Best-effort: seed the example vault into the just-unlocked vault. NEVER
 * throws: a failure here must not derail the (already-successful)
 * auto-unlock → list transition; the user just lands on an empty vault.
 */
export async function seedExampleVault(): Promise<void> {
  try {
    const folders: string[] = [];
    for (const note of resolveExampleNotes()) {
      // `null` because this is a BULK path: ONE registration for the whole seed
      // is issued below rather than one `vault.prefs` re-encrypt per note
      // (myne-md/myne#613, the same reason desktop passes `null`).
      await noteCreate(note.markdown, null);
      // `note.folder` is the value that went INTO the frontmatter a line above,
      // so it is taken rather than re-parsed back out of it.
      const folder = normalizeFolderPath(note.folder);
      if (folder !== null && !folders.includes(folder)) folders.push(folder);
    }
    // The registration the comment above promises. Without it a seeded folder
    // emptied by trashing its notes would vanish, because the deliberate-folder
    // list is what keeps an empty folder alive.
    if (folders.length > 0) {
      await mutateDeliberateFolders({ add: folders });
    }
  } catch {
    // Onboarding nicety, not load-bearing. Swallow any IPC/encode failure.
  }
}
