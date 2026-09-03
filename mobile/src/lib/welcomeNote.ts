// Onboarding Welcome note — mobile seeding wrapper over the SHARED builder
// (`@myne/dialect/welcomeNote`; the desktop counterpart is the main repo's
// `src/notes/welcomeNote.ts`, MYND-118). After a freshly-created vault
// auto-unlocks (CreateVaultFlow's openVault chain), we write one ordinary
// `.myn` note — "Welcome to Myne" — so the first unlock doesn't land on an
// empty list. It is a NORMAL note: editable, renamable, deletable, no
// special-casing. Seeded exactly once, on the create→unlock path only —
// never re-created on later unlocks.
//
// Copy resolves through the i18n RUNTIME (#49). It used to read the English
// catalog directly — correct when this file was written, because mobile had no
// i18n runtime, and stale from the moment `@myne/i18n` went live: a user who
// completed onboarding in Turkish got an English Welcome note as the first
// thing in their vault. Resolved at SEED time rather than at module load, so
// the note is written in whatever language the user just chose.
//
// Desktop also pre-seeds the MYW1 workspace descriptor so its editor opens
// the note on mount; mobile has no workspace plugin — the note shows up in
// the notes list after unlock, which is the mobile list-first UX.

import i18n from "@myne/i18n";
import {
  buildWelcomeNoteMarkdown,
  WELCOME_NOTE_TITLE_KEY,
  WELCOME_NOTE_BODY_KEY,
} from "../dialect/welcomeNote";
import { stampUpdated } from "./note-organize";
import { noteCreate } from "./notes";

/** The Welcome note's title in the ACTIVE language. Also the DEV seeder's
 *  "still-empty vault" marker (seed.ts).
 *
 *  A function rather than a `const` (#49): a module-level constant freezes the
 *  boot language, and the create flow can run after the user has switched. */
export function welcomeNoteTitle(): string {
  return i18n.t(WELCOME_NOTE_TITLE_KEY);
}

/** The Welcome note's body in the active language. */
export function welcomeNoteBody(): string {
  return i18n.t(WELCOME_NOTE_BODY_KEY);
}

/** Full note plaintext (frontmatter `title:` + body) via the shared builder. */
export function welcomeNoteMarkdown(): string {
  return buildWelcomeNoteMarkdown(welcomeNoteTitle(), welcomeNoteBody());
}

/**
 * Best-effort: create the Welcome note in the just-unlocked vault. NEVER
 * throws — a failure here must not derail the (already-successful)
 * auto-unlock → editor transition; the user just lands on an empty list.
 * The caller guards `HAS_TAURI` (real IPC only). `updated:` is stamped like
 * every other mobile create site so the list shows a last-edited time.
 */
export async function seedWelcomeNote(): Promise<void> {
  try {
    // The welcome note is a root note by construction.
    await noteCreate(stampUpdated(welcomeNoteMarkdown()), null);
  } catch {
    // Onboarding nicety, not load-bearing — swallow any IPC/encode failure.
  }
}
