// A chat turn's text with any note mention pressable (myne-md/myne#867).
//
// ── The defect this closes ─────────────────────────────────────────────────
// Desktop and phone both printed a model's answer as flat text, so a sentence
// that named a note ("it is under Personal/Things I have/Pixel 10 Graphene OS")
// left that name exactly as pressable as the word "your". The desktop half of
// this fix renders the whole answer through its markdown renderer, which the
// phone does not have: a mobile turn is a single `<p>`, and adding a markdown
// renderer to get one link out of it would be a different change with a
// different blast radius. So this component does the ONE thing the defect needs
// and says so: it splits the text on note names and makes those pressable.
//
// ── Why the matcher is shared rather than typed here ───────────────────────
// `@myne/note-mentions` is the desktop's `src/notes/ai/noteMentions.ts`, aliased
// into this client the way `@myne/meeting-note` and `@myne/engine-error` are.
// Its three boundary rules (longest first, no match starting or ending inside a
// longer name, and `.` deliberately not continuing a name) are the part worth
// getting right, each one exists for a case that would otherwise put the WRONG
// note one press away, and it is unit-tested on the desktop side. A second copy
// here would be a second version of those rules, and the phone is where nobody
// would notice it drift.
//
// ── The anatomy, and why it is not the desktop's ───────────────────────────
// The desktop uses a `<button className="myne-text-link">`; this client's own
// text links are `role="link"` spans with a Tab stop and Enter/Space handlers
// (see `MarkdownView`'s wikilink arm, myne#728). Two clients, two idioms, and
// the phone's is the one already in this tree: a button inside a sentence also
// gets the phone's button chrome, which is not what a word in a sentence wants.

import type { CSSProperties } from "react";
import { useMemo } from "react";

import { linkifyMentions, type MentionTarget } from "@myne/note-mentions";

const LINK_STYLE: CSSProperties = {
  color: "var(--accent)",
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: 2,
  unicodeBidi: "isolate",
};

export function MentionText({
  text,
  targets,
  onOpenNote,
  style,
}: {
  text: string;
  /** Strings that name a note, from the shared `buildMentionTargets`. Absent
   *  or empty means every mention stays plain text, which is what happens while
   *  the note list has not loaded. */
  targets: readonly MentionTarget[] | undefined;
  onOpenNote: ((noteId: string) => void) | undefined;
  style?: CSSProperties;
}) {
  const segments = useMemo(
    () => linkifyMentions(text, targets ?? []),
    [text, targets],
  );
  // The common case: nothing in this turn names a note, so nothing is wrapped.
  // Worth the branch because every turn goes through here.
  if (segments.every((seg) => seg.noteUuid === undefined)) {
    return <p style={style}>{text}</p>;
  }
  const open = (noteId: string) => onOpenNote?.(noteId);
  return (
    <p style={style}>
      {segments.map((seg, i) =>
        seg.noteUuid === undefined ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <span
            key={i}
            role="link"
            tabIndex={0}
            data-testid="ai.mention-link"
            onClick={() => open(seg.noteUuid!)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              open(seg.noteUuid!);
            }}
            style={LINK_STYLE}
          >
            {seg.text}
          </span>
        ),
      )}
    </p>
  );
}
