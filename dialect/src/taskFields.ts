// Field parser: three dialects to one typed record (MYND-611, task 2).
//
// Myne READS three dialects and WRITES one. This is the read side's typing layer:
// it walks the `TaskField` nodes the recognizer emits (task 1) and produces one
// record, so a task written in Obsidian's emoji form, Obsidian's Dataview form, or
// Myne's own form is indistinguishable downstream. That equivalence is what makes
// the Obsidian importer honest — an imported vault's tasks light up whichever form
// the user already had.
//
// It consumes the parse tree rather than re-scanning the line with a regex. A
// second recognizer would drift from the first, and spell-skip would have nothing
// to key on (PRD "Implementation Decisions").
//
// Two deliberate refusals, both load-bearing:
//
//   - `onCompletion` is NEVER interpreted. It is a miniature action language, and
//     running it crosses the no-code-eval line the epic defends elsewhere. Its
//     bytes are still preserved, because task 4 converts the whole line on edit —
//     anything missing from this record is deleted by the next write.
//
//   - No timezone offset and no zone identifier is ever produced. Times are local
//     wall-clock: "09:00" means 09:00 wherever the user is, which is what a
//     personal reminder means, and it keeps a coarse geolocation datum out of a
//     file that gets exported as plaintext. A value carrying an offset does not
//     type at all rather than being silently normalized — a silently shifted due
//     date is worse than one the editor flags as raw text (MYND-614 task 8).

import type { Tree } from "@lezer/common";
import { parser } from "./lezer/parser";
import { isRealDate } from "./dates";

/** Myne's five priority levels, lowest-divergence names shared with Obsidian. */
export type TaskPriority = "highest" | "high" | "medium" | "low" | "lowest";

/** A local wall-clock instant. No offset, no zone id — ever. */
export type TaskInstant = { date: string; time?: string };

/** A field kept verbatim: recognized, but not typed by Myne. */
export type PreservedTaskField = { key: string; value: string; raw: string };

export type TaskFields = {
  due?: TaskInstant;
  repeat?: string;
  done?: TaskInstant;
  priority?: TaskPriority;
  remind?: TaskInstant;
  /** Recognized keys Myne does not type — Obsidian's `scheduled`, `start`,
   *  `cancelled`, `created`, `id`, `dependsOn`, `onCompletion`, and any other
   *  inline field on the line. Preserved so a whole-line rewrite cannot destroy
   *  data Myne did not understand. */
  preserved: PreservedTaskField[];
  /** Supported keys whose value did not parse. Preserved verbatim as well; the
   *  editor renders these as raw source text with a hint rather than as a chip. */
  malformed: PreservedTaskField[];
};

/** Emoji marker → canonical key. Obsidian's vocabulary, read-only. */
const EMOJI_KEYS: ReadonlyMap<string, string> = new Map([
  ["📅", "due"],
  ["🔁", "repeat"],
  ["✅", "done"],
  ["⏰", "remind"],
  ["⏳", "scheduled"],
  ["🛫", "start"],
  ["❌", "cancelled"],
  ["➕", "created"],
  ["🆔", "id"],
  ["⛔", "dependsOn"],
]);

/** Priority emoji carry no value — the marker is the value. */
const EMOJI_PRIORITIES: ReadonlyMap<string, TaskPriority> = new Map([
  ["🔺", "highest"],
  ["⏫", "high"],
  ["🔼", "medium"],
  ["🔽", "low"],
  ["⏬", "lowest"],
]);

/**
 * Case-folded key → canonical key. `completion` folds onto `done`: Myne diverges
 * from Obsidian's name only where it already has a competing one, so the inline
 * field and the frontmatter field for note-tasks share a single word for a single
 * concept. That is the whole of the "third dialect" a reader must learn.
 */
const CANONICAL_KEYS: ReadonlyMap<string, string> = new Map([
  ["due", "due"],
  ["repeat", "repeat"],
  ["done", "done"],
  ["priority", "priority"],
  ["remind", "remind"],
  ["completion", "done"],
  ["scheduled", "scheduled"],
  ["start", "start"],
  ["cancelled", "cancelled"],
  ["created", "created"],
  ["id", "id"],
  ["dependson", "dependsOn"],
  ["oncompletion", "onCompletion"],
]);

const PRIORITY_WORDS: ReadonlySet<string> = new Set([
  "highest",
  "high",
  "medium",
  "low",
  "lowest",
]);

// Date, and date with a wall-clock time. The absence of an offset alternative is
// the point: `2026-08-01T10:00:00Z` matches neither and therefore does not type.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parse a bare value into a local wall-clock instant, or `null` if it is not one.
 *
 * Exported so a caller typing a single field's value does not have to build a
 * task line around it — constructing `[due:: …]` just to re-parse it would put a
 * second task-field byte-emitter in the codebase, which the single-writer
 * discipline forbids (and the grep that proves it would go noisy).
 */
export function parseTaskInstant(value: string): TaskInstant | null {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    if (!isRealDate(Number(y), Number(m), Number(d))) return null;
    return { date: value };
  }

  const dateTime = DATE_TIME.exec(value);
  if (!dateTime) return null;
  const [, y, m, d, hh, mm, ss] = dateTime;
  if (!isRealDate(Number(y), Number(m), Number(d))) return null;
  if (Number(hh) > 23 || Number(mm) > 59) return null;
  if (ss !== undefined && Number(ss) > 59) return null;

  return {
    date: `${y}-${m}-${d}`,
    time: ss === undefined ? `${hh}:${mm}` : `${hh}:${mm}:${ss}`,
  };
}

/**
 * A task line's fields, typed. Pure: same line in, same record out.
 *
 * Note this does NOT check that the line is a line-task — the recognizer cannot
 * see the `- [ ]` marker from inside the inline scope, so an emoji marker in
 * ordinary prose produces a field here too. Callers that care (the index, the
 * chip renderer) apply that restriction themselves.
 */
export function parseTaskFields(line: string, tree?: Tree): TaskFields {
  const t = tree ?? parser.parse(line);
  const result: TaskFields = { preserved: [], malformed: [] };

  t.iterate({
    enter: (nodeRef) => {
      if (nodeRef.name !== "TaskField") return undefined;

      let rawKey = "";
      let value = "";
      for (let c = nodeRef.node.firstChild; c; c = c.nextSibling) {
        if (c.name === "TaskFieldKey") rawKey = line.slice(c.from, c.to);
        if (c.name === "TaskFieldValue") value = line.slice(c.from, c.to);
      }
      const raw = line.slice(nodeRef.from, nodeRef.to);
      if (rawKey === "") return false;

      const bare = rawKey.replace(/️$/, "");
      const emojiPriority = EMOJI_PRIORITIES.get(bare);
      if (emojiPriority !== undefined) {
        if (result.priority === undefined) result.priority = emojiPriority;
        return false;
      }

      const key =
        EMOJI_KEYS.get(bare) ?? CANONICAL_KEYS.get(rawKey.toLowerCase()) ?? rawKey;

      const preserve = (into: PreservedTaskField[]) => {
        into.push({ key, value, raw });
      };

      switch (key) {
        case "due":
        case "done":
        case "remind": {
          if (result[key] !== undefined) return false; // first occurrence wins
          const instant = parseTaskInstant(value);
          if (instant === null) preserve(result.malformed);
          else result[key] = instant;
          return false;
        }
        case "repeat": {
          // The rule vocabulary belongs to MYND-615; here it is raw text.
          if (result.repeat === undefined && value !== "") result.repeat = value;
          return false;
        }
        case "priority": {
          if (result.priority !== undefined) return false;
          const word = value.toLowerCase();
          if (PRIORITY_WORDS.has(word)) result.priority = word as TaskPriority;
          else preserve(result.malformed);
          return false;
        }
        default: {
          // Everything else — including `onCompletion` — is kept verbatim and
          // given no meaning whatsoever.
          preserve(result.preserved);
          return false;
        }
      }
    },
  });

  return result;
}
