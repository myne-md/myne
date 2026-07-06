// Onboarding Welcome note — mobile seeding wrapper over the SHARED builder
// (`@myne/dialect/welcomeNote`; the desktop counterpart is the main repo's
// `src/notes/welcomeNote.ts`, MYND-118). After a freshly-created vault
// auto-unlocks (CreateVaultFlow's openVault chain), we write one ordinary
// `.myn` note — "Welcome to Myne" — so the first unlock doesn't land on an
// empty list. It is a NORMAL note: editable, renamable, deletable, no
// special-casing. Seeded exactly once, on the create→unlock path only —
// never re-created on later unlocks.
//
// Copy resolves from the shared en catalog (`@myne/locales-en`) via the
// shared key names — the SAME source strings the desktop i18n runtime
// serves, so the copy cannot drift between clients. When mobile grows an
// i18n runtime, resolve the keys through it at seed time like desktop does.
//
// Desktop also pre-seeds the MYW1 workspace descriptor so its editor opens
// the note on mount; mobile has no workspace plugin — the note shows up in
// the notes list after unlock, which is the mobile list-first UX.

import enCatalog from "@myne/locales-en";
import {
  buildWelcomeNoteMarkdown,
  WELCOME_NOTE_TITLE_KEY,
  WELCOME_NOTE_BODY_KEY,
} from "../dialect/welcomeNote";
import { stampUpdated } from "./note-organize";
import { noteCreate } from "./notes";

// Nested-key catalog lookup (the editor-host `t()` shape, minus plurals and
// interpolation — the Welcome copy uses neither). Falls back to the raw key.
function catalogString(key: string): string {
  let node: unknown = enCatalog;
  for (const seg of key.split(".")) {
    if (typeof node !== "object" || node === null) return key;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === "string" ? node : key;
}

/** Resolved copy. The title is also the DEV seeder's "still-empty vault"
 *  marker (seed.ts). */
export const WELCOME_NOTE_TITLE = catalogString(WELCOME_NOTE_TITLE_KEY);
export const WELCOME_NOTE_BODY = catalogString(WELCOME_NOTE_BODY_KEY);

/** Full note plaintext (frontmatter `title:` + body) via the shared builder. */
export function welcomeNoteMarkdown(): string {
  return buildWelcomeNoteMarkdown(WELCOME_NOTE_TITLE, WELCOME_NOTE_BODY);
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
    await noteCreate(stampUpdated(welcomeNoteMarkdown()));
  } catch {
    // Onboarding nicety, not load-bearing — swallow any IPC/encode failure.
  }
}
