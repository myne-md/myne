// First-run example vault — the SHARED note-set builder (#393).
//
// Replaces the single "Welcome to Myne" note (MYND-118) with a small,
// self-contained set of ordinary notes under ONE folder ("Getting started/"),
// so a new user meets a worked example of a Myne vault — wikilinks that build a
// graph, a task list that fills the Tasks surface, #tags that fill the tag
// tree, and the Markdown the editor renders — instead of one paragraph. The
// property that makes a richer set acceptable is cleanup: every note is under
// one folder, which folder-delete trashes (recoverably) in a single action.
//
// Like `welcomeNote.ts` this stays i18n-free (parser-core discipline): the COPY
// lives in the shared en catalog (`locales/en/common.json` → `notes.example.*`)
// and each platform resolves it through its own runtime and passes the strings
// in. The notes cross-link BY TITLE; to keep every link unbroken in every
// locale, the bodies name their targets through interpolation placeholders
// (`[[{{index}}]]`, `[[{{tasks}}]]`, …) that the seeder fills with the RESOLVED
// titles — so a translated title and the links that point at it can never
// drift apart.

import {
  patchFolderField,
  patchFolderIndexField,
  patchTitleField,
} from "./surgery";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Catalog key for the folder every example note lives under. */
export const EXAMPLE_FOLDER_KEY = "notes.example.folder";

/** A stable role id per example note. Doubles as the interpolation variable
 *  name the bodies use (`[[{{index}}]]` → the resolved index-note title), so
 *  the seeder can resolve every title once and hand the whole set to i18n. */
export type ExampleNoteRole =
  | "index"
  | "markdown"
  | "tasks"
  | "links"
  | "makeItYours";

export interface ExampleNoteSpec {
  readonly role: ExampleNoteRole;
  readonly titleKey: string;
  readonly bodyKey: string;
  /** The folder index note (`folder_index: true`) and the tab opened on first
   *  run. Exactly one spec carries it. The `folder_index: true` flag is seeded
   *  unconditionally (myne-md/myne#661): folder notes are OFF by default, so on
   *  first run this note renders and opens as an ORDINARY note; the flag stays on
   *  disk untouched, so a user who later enables folder notes gets it as the
   *  folder's index with no re-seed. (The tab-open keys off this `index` spec
   *  flag, not off reading `folder_index` back, so first run is unaffected by the
   *  feature default.) */
  readonly index?: true;
}

/** The example notes, in creation order. The index note is first so its id is
 *  known before the others are written; links resolve by title, so order is not
 *  load-bearing for them — a stable order just keeps seeded ids reproducible. */
export const EXAMPLE_NOTES: readonly ExampleNoteSpec[] = [
  {
    role: "index",
    titleKey: "notes.example.index.title",
    bodyKey: "notes.example.index.body",
    index: true,
  },
  {
    role: "markdown",
    titleKey: "notes.example.markdown.title",
    bodyKey: "notes.example.markdown.body",
  },
  {
    role: "tasks",
    titleKey: "notes.example.tasks.title",
    bodyKey: "notes.example.tasks.body",
  },
  {
    role: "links",
    titleKey: "notes.example.links.title",
    bodyKey: "notes.example.links.body",
  },
  {
    role: "makeItYours",
    titleKey: "notes.example.makeItYours.title",
    bodyKey: "notes.example.makeItYours.body",
  },
];

/**
 * Full note plaintext for one example note: the resolved Markdown `body` with a
 * frontmatter `title:` + `folder:` block (and `folder_index: true` for the
 * index note), built via the canonical dialect helpers so quoting/format match
 * every other Myne-written note. Each `patch*` composes on the previous field
 * without clobbering it.
 */
export function buildExampleNoteMarkdown(
  title: string,
  folder: string,
  body: string,
  opts?: { readonly index?: boolean },
): string {
  const withTitle = patchTitleField(utf8Encoder.encode(body), title);
  const withFolder = patchFolderField(withTitle, folder);
  const bytes =
    opts?.index === true ? patchFolderIndexField(withFolder, true) : withFolder;
  return utf8Decoder.decode(bytes);
}
