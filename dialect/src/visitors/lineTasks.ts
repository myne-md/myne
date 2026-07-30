// Line-task extractor (MYND-612, task 3).
//
// Walks the shared parse for GFM `Task` nodes and turns each into the record the
// index stores. Runs off the parse tree rather than a regex on purpose: the
// exclusion zones (code spans, fenced and indented code, wikilink interiors, HTML)
// come free, because the tokenizer never descends into a range those nodes have
// consumed. A regex would have to re-implement every one of them and would drift
// from the tokenizer the moment either changed.
//
// This is also where the line-task restriction is applied — MYND-611's recognizer
// deliberately does not scope itself to task lines (it cannot see the enclosing
// block from inside inline content), so a `📅` in prose produces a field but not a
// task. Applying it here is the consuming layer honouring `markdown-dialect.md`
// §3.8.6.

import type { Tree } from "@lezer/common";
import { parser } from "../lezer/parser";
import { locateFrontmatter } from "../lezer/frontmatter";
import { readKindFromFmBody } from "../surgery";
import { parseTaskFields, type TaskInstant } from "../taskFields";

/**
 * Maximum stored length of a task's raw line (MYND-612 task 5). The record-level
 * cap parallels the existing preview cap and whole-vault ceiling in
 * `protocol.md` §9.8.5. Real task lines are two orders of magnitude short of it.
 */
export const LINE_TASK_RAW_CAP = 4000;

/** One extracted line-task. Field keys are omitted when the value did not type. */
export type LineTask = {
  /** Zero-based line number within the source. */
  lineIndex: number;
  /** The task's source line, verbatim (no trailing newline), truncated at
   *  [`LINE_TASK_RAW_CAP`] — in which case `oversized` is set. */
  rawLine: string;
  /** Whether the checkbox is checked — `[x]` and `[X]` both count. */
  completed: boolean;
  /**
   * Set when the source line exceeded the cap and `rawLine` is therefore
   * truncated. The record is still indexed and still returned — dropping it
   * would make the task vanish from every surface — but the raw line is the
   * authority for the pre-write verification, so a truncated one makes the task
   * **unwritable**. Writers refuse on this flag rather than attempting a write
   * they cannot verify.
   */
  oversized?: true;
  due?: string;
  repeat?: string;
  done?: string;
  priority?: string;
  remind?: string;
};

/** Serialize a typed instant back to the form the index stores (verbatim shape). */
function instantText(value: TaskInstant | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.time === undefined ? value.date : `${value.date} ${value.time}`;
}

/** Byte offset → zero-based line index, via a prefix scan of newlines. */
function lineIndexAt(source: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** The whole source line containing `offset`, without its terminator. */
function lineAt(source: string, offset: number): string {
  const start = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  let end = source.indexOf("\n", offset);
  if (end === -1) end = source.length;
  return source.slice(start, end).replace(/\r$/, "");
}

/**
 * Every line-task in `source`, in document order.
 *
 * Drawing-class notes yield nothing at all: a drawing's body is serialized scene
 * JSON, so a `- [ ]` occurring inside it is a phantom task. Skipping the note
 * wholesale is cheaper and safer than filtering line by line.
 */
export function extractLineTasks(source: string, tree?: Tree): LineTask[] {
  if (source.length === 0) return [];

  const fm = locateFrontmatter(source);
  if (fm !== null) {
    const fmBody = source.slice(fm.bodyStart, fm.bodyEnd);
    if (readKindFromFmBody(fmBody) === "drawing") return [];
  }

  const t = tree ?? parser.parse(source);
  const out: LineTask[] = [];

  t.iterate({
    enter: (nodeRef) => {
      if (nodeRef.name !== "Task") return undefined;

      // Frontmatter has no parse node of its own (see `parse.ts`), so the
      // aggregator-level filter is applied here, exactly as `parse()` does for
      // headings, wikilinks, tags and media refs.
      if (fm !== null && nodeRef.from < fm.blockEnd) return false;

      const marker = nodeRef.node.getChild("TaskMarker");
      const markerText = marker === null ? "" : source.slice(marker.from, marker.to);
      const completed = /\[[xX]\]/.test(markerText);

      const fullLine = lineAt(source, nodeRef.from);
      // Fields are read from the FULL line before truncation, so an over-cap task
      // still appears under a date filter — it just cannot be written.
      const fields = parseTaskFields(fullLine);
      const oversized = fullLine.length > LINE_TASK_RAW_CAP;

      const task: LineTask = {
        lineIndex: lineIndexAt(source, nodeRef.from),
        rawLine: oversized ? fullLine.slice(0, LINE_TASK_RAW_CAP) : fullLine,
        completed,
      };
      if (oversized) task.oversized = true;
      const due = instantText(fields.due);
      if (due !== undefined) task.due = due;
      if (fields.repeat !== undefined) task.repeat = fields.repeat;
      const done = instantText(fields.done);
      if (done !== undefined) task.done = done;
      if (fields.priority !== undefined) task.priority = fields.priority;
      const remind = instantText(fields.remind);
      if (remind !== undefined) task.remind = remind;

      out.push(task);
      return false;
    },
  });

  return out;
}
