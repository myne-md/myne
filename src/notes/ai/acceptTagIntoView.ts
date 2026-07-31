// The single tag-accept write path (on-device-tag-suggestion task 6). Every
// accepted tag chip — today the (superseded) chat-tab surface, from task 7 the
// inline suggestion band — routes here, so there is exactly one place that
// decides what accepting a tag does to a note.
//
// It writes into the LIVE CodeMirror document rather than to disk: the note is
// open, so a disk write would be the SYNC-15 clobber-the-live-buffer mistake.
// The normal autosave loop persists it through `note_save`/`MY01` afterwards —
// byte-identical to a hand-typed frontmatter tag, no new writer, no new format.

import type { EditorView } from "@codemirror/view";

import { computeTagAcceptEdit } from "./acceptTag";

/**
 * Add `tag` to the open note's frontmatter `tags:` list.
 *
 * Returns `false` — dispatching nothing — when {@link computeTagAcceptEdit}
 * finds nothing to write: the note already carries the tag under the §3.7.8
 * fold, or its frontmatter is a shape the writer refuses to touch. The edit is
 * minimal, so an accept in the middle of typing leaves the cursor where it was.
 */
export function acceptTagIntoView(view: EditorView, tag: string): boolean {
  const edit = computeTagAcceptEdit(view.state.doc.toString(), tag);
  if (edit === null) return false;
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    userEvent: "ai.accept-tag",
  });
  return true;
}
