// Note mentions in an assistant answer (myne-md/myne#867).
//
// ── The defect this closes ─────────────────────────────────────────────────
// A model that has just told you "your note is under Personal/Things I have/
// Pixel 10 Graphene OS" left that name as bold plain text. The one thing a
// reader wants at that moment, opening the note, was the one thing the surface
// could not do, and the name was exactly as clickable as the word "your".
//
// ── What may become a link, and what may not ───────────────────────────────
// Only a WHOLE name that the vault already contains: a note's path, its path
// without the trailing `.md`, or its bare title. Nothing fuzzy, nothing
// guessed. Three rules, and each exists for a case that would otherwise put the
// wrong note one click away:
//
//   1. **Longest first at any position.** A note titled `Notes` must not claim
//      the `Notes` inside a mention of `Notes on Q3`. Trying the longer
//      candidates first is what makes the longer name win.
//   2. **A match may not begin or end inside a longer name.** The characters
//      immediately before and after must not be in `[A-Za-z0-9_/-]`. That set
//      is what stops `…/Graphene OSX` from linking the note `…/Graphene OS`, and
//      what stops a match starting halfway through a path.
//   3. **`.` is deliberately NOT one of those characters.** A sentence-final
//      mention ("… under Personal/Things I have/Pixel 10 Graphene OS.") is the
//      common case, and treating a full stop as name-continuation would drop it.
//      The `Title.md` case is covered by rule 1 instead: `Title.md` is longer
//      than `Title`, so it wins wherever it is a candidate at all.
//
// A consequence worth stating rather than discovering: this is an EXACT-match
// lookup, so a text that is only a prefix of a real title (`Pixel 10`, where the
// note is `Pixel 10 Graphene OS`) is not a candidate and stays plain text. That
// is the point of the exercise. The error it prevents is a link that opens a
// note the model did not name.
//
// ── Why one matcher for text and wikilinks ─────────────────────────────────
// A `[[note]]` token resolves through this same lookup rather than through
// `resolveWikilink`, and the reason is structural rather than a shortcut: that
// resolver takes a `WikilinkRef`, which only the Lezer document parse produces
// (`dialect/src/parse.ts`), and a chat bubble holds tokens rather than a parsed
// document. What IS reused is the resolver's own projection of a note to its
// path (`notePath`), so a mention and a displayed path cannot disagree about
// what a note is called. The consequence: a folder target (`[[Projects/]]`) and
// an alias (`[[Title|alias]]`) find no candidate here and stay plain text,
// which is exactly what this surface already did with every wikilink.

import { notePath, type ResolverNote } from "../resolveWikilink";

/** A string that, appearing whole in an answer, names a note the vault holds. */
export interface MentionTarget {
  text: string;
  noteUuid: string;
}

export interface MentionSegment {
  text: string;
  /** Present when this segment is a note mention rather than prose. */
  noteUuid?: string;
}

/**
 * Characters that continue a name. A match may not begin or end against one.
 *
 * `.` is absent on purpose, and the header explains why. `/` and `-` are
 * present so a match cannot start in the middle of a path or end in the middle
 * of a hyphenated title.
 */
const NAME_CHAR = /[A-Za-z0-9_/-]/;

/**
 * Every string that names a note, longest first and deduplicated.
 *
 * Pure, and unit-testable without React, because the boundary rules above are
 * the part worth testing and none of them needs a DOM.
 */
export function buildMentionTargets(
  notes: readonly ResolverNote[],
): MentionTarget[] {
  const byText = new Map<string, string>();
  // **A name two notes share names neither** (myne-md/myne#867 review, D7).
  // `A/Meeting.md` and `B/Meeting.md` both offer the bare title `Meeting`, and
  // keeping whichever came first in the resolver list made the link open a
  // note chosen by list order: a guess, which is the one thing this module
  // refuses. Such a text is dropped and stays plain; each note is still
  // reachable by its full path, which only one of them can have.
  const ambiguous = new Set<string>();
  const add = (text: string, noteUuid: string) => {
    if (text === "" || ambiguous.has(text)) return;
    const prior = byText.get(text);
    if (prior === undefined) {
      byText.set(text, noteUuid);
    } else if (prior !== noteUuid) {
      byText.delete(text);
      ambiguous.add(text);
    }
  };
  for (const note of notes) {
    const path = notePath(note);
    add(path, note.noteUuid);
    // The form a model actually writes: it names a note, not a file. SKIPPED when
    // the note has no title, because `notePath` then renders `<folder>/.md` and
    // the stripped form is a bare FOLDER path: a mention of that folder in prose
    // (`...under Projects/`) or a folder wikilink (`[[Projects/]]`, whose label
    // equals its target so the alias guard does not refuse it) would open an
    // untitled note the user never named, which is the wrong-note click this
    // exact-match rule exists to prevent (myne#892 review).
    const withoutExtension = path.replace(/\.md$/, "");
    if (!withoutExtension.endsWith("/")) add(withoutExtension, note.noteUuid);
    if (note.title !== null) add(note.title, note.noteUuid);
  }
  return [...byText.entries()]
    .map(([text, noteUuid]) => ({ text, noteUuid }))
    .sort((a, b) => b.text.length - a.text.length);
}

/**
 * The targets grouped by first character, longest first within each group.
 *
 * `linkifyMentions` runs on every render of a streaming bubble, once per token,
 * and trying every target at every word boundary made that cost the text
 * length times the vault's note count (myne-md/myne#867 review, D7). Grouping
 * by the first character leaves only the candidates that can match at a
 * position. Cached per targets array, which callers already memoise, so the
 * grouping is built once per vault change rather than once per token.
 */
const BY_FIRST_CHAR = new WeakMap<
  readonly MentionTarget[],
  Map<string, MentionTarget[]>
>();

function targetsByFirstChar(
  targets: readonly MentionTarget[],
): Map<string, MentionTarget[]> {
  const cached = BY_FIRST_CHAR.get(targets);
  if (cached !== undefined) return cached;
  const grouped = new Map<string, MentionTarget[]>();
  // `targets` is longest-first, and pushing in that order keeps each group so.
  for (const target of targets) {
    const first = target.text[0];
    if (first === undefined) continue;
    const group = grouped.get(first);
    if (group === undefined) grouped.set(first, [target]);
    else group.push(target);
  }
  BY_FIRST_CHAR.set(targets, grouped);
  return grouped;
}

/**
 * Split `text` into prose and note mentions.
 *
 * `targets` is expected to be {@link buildMentionTargets}'s output (longest
 * first); a caller that hands it an unsorted list gets rule 1's outcome only by
 * accident, so the sort lives in the builder rather than here.
 */
export function linkifyMentions(
  text: string,
  targets: readonly MentionTarget[],
): MentionSegment[] {
  const out: MentionSegment[] = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") out.push({ text: plain });
    plain = "";
  };

  const grouped = targetsByFirstChar(targets);
  let i = 0;
  outer: while (i < text.length) {
    const leftOk = i === 0 || !NAME_CHAR.test(text[i - 1]);
    const candidates = leftOk ? grouped.get(text[i]) : undefined;
    if (candidates !== undefined) {
      for (const target of candidates) {
        if (!text.startsWith(target.text, i)) continue;
        const end = i + target.text.length;
        if (end < text.length && NAME_CHAR.test(text[end])) {
          // **STOP at this position, do not try a shorter candidate**
          // (myne-md/myne#867 review, D7). `targets` is longest-first, so a
          // candidate that matched here and was refused by the boundary is the
          // longest name this position could have been. Falling through let a
          // SHORTER title claim the same position: with notes `Notes` and
          // `Notes on Q3`, the text `Notes on Q3X` refused `Notes on Q3` (X
          // continues a name) and then linked `Notes`, which is exactly the
          // "a link that opens a note the model did not name" this module's
          // header forbids, and rule 1's own worked case one step further out.
          break;
        }
        flush();
        out.push({ text: target.text, noteUuid: target.noteUuid });
        i = end;
        continue outer;
      }
    }
    plain += text[i];
    i += 1;
  }
  flush();
  return out;
}
