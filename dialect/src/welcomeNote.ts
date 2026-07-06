// Onboarding Welcome note — the SHARED plaintext builder (desktop MYND-118 +
// mobile). One definition of the note's shape — a frontmatter `title:` block
// plus the Markdown body, via the canonical surgery helper — so the two
// clients cannot drift structurally.
//
// The COPY's single source of truth is the shared en catalog
// (`locales/en/common.json` → the `notes.welcome.*` keys below). This module
// stays i18n-free like the rest of the parser core: each platform resolves
// the copy through its own runtime — desktop via react-i18next at seed time
// (language-reactive), mobile via the `@myne/locales-en` catalog it already
// bundles (no i18n runtime yet) — and passes the resolved strings in.
//
// Seeding itself stays per-platform (desktop `src/notes/welcomeNote.ts` adds
// the MYW1 workspace pre-seed, mobile `src/lib/welcomeNote.ts` adds the
// `updated:` stamp): the IPC wrappers and side-channels differ, the note
// does not.

import { patchTitleField } from "./surgery";

/** Catalog keys for the Welcome note copy (`locales/en/common.json`). Both
 *  platforms resolve THESE keys, so a copy change is a one-catalog edit. */
export const WELCOME_NOTE_TITLE_KEY = "notes.welcome.title";
export const WELCOME_NOTE_BODY_KEY = "notes.welcome.body";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Full note plaintext: a frontmatter `title:` block (notes derive their
 * title from the frontmatter `title:` field ONLY — never a body `# H1` — so
 * without it the note renders as "Untitled") followed by the Markdown body,
 * built via the canonical dialect helper so quoting/format match every
 * other Myne-written note.
 */
export function buildWelcomeNoteMarkdown(title: string, body: string): string {
  return utf8Decoder.decode(patchTitleField(utf8Encoder.encode(body), title));
}
