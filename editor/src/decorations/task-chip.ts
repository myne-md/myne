// Inline task-field chip decorations (MYND-614 tasks 3 + 4 — due, repeat, priority).
//
// Renders a task line's `due` field as a compact chip. Structurally the tag-chip
// twin: built within the visible range, registered through the cursor-aware
// plugin factory, with an atomic-range provider computed from **the identical
// predicate over the identical scope**.
//
// That equality is load-bearing rather than tidy. If the atomic provider walked a
// wider range than the decoration builder, off-screen raw text would be atomic
// while showing no chip, and the caret would start skipping characters in text
// that looks perfectly ordinary. The two functions therefore share one predicate
// (`chipRangesIn`) instead of restating it.
//
// Recognize-only / §6 C1: purely visual. The chip's label is derived from the
// literal source text and the buffer is never rewritten by this layer; writes go
// through the single writer seam (`dialect/src/taskFieldWriter.ts`).
//
// REVEAL POLICY (task 5) — deliberately NOT the tag chip's.
//
// A task field is a structured value, not prose, so it follows the wikilink rule
// rather than the tag rule: the chip does **not** open into raw text when the
// caret arrives. Two reasons. A date is not something you edit by retyping
// characters — task 6's editor is the way in, which is why that editor has to be
// complete and keyboard-reachable from day one. And a line carrying three chips
// would reflow every time the caret travelled it.
//
// The chip DOES open while the find panel is open. Otherwise a search finds a
// match inside hidden text, moves the caret there, and highlights nothing —
// strictly worse than not finding it. The precedent exists for block decorations
// (`revealActive` already folds `searchPanelOpen` in); the inline path simply
// never got the same condition, which is the hole the shipped tag chip still has.
//
// Reading mode never reveals, under any condition. Source mode needs nothing:
// it empties the decoration stack entirely.

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  MapMode,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { searchPanelOpen } from "@codemirror/search";
import { readingModeFacet } from "./cursor-aware";
import { makeGatedDecorationPlugin } from "./plugin-factory";
import { recurrenceLabel } from "./task-recurrence";
import i18n from "@myne/editor/i18n";
import { parseTaskFields, parseTaskInstant, type TaskFields } from "@myne/dialect/taskFields";
import { planTaskFieldWrite } from "@myne/dialect/taskFieldWriter";
import { parseRecurrenceSpec } from "@myne/dialect/recurrence";
import { canRecur } from "@myne/dialect/taskRecurrence";

/**
 * Which fields get a chip, and what each is called.
 *
 * Each entry maps every spelling of a field — Myne's key plus the Obsidian emoji
 * markers — onto one canonical kind, so the chip does not care which dialect the
 * file happens to use. Priority's five emoji are their own value, hence the
 * separate value map below.
 */
const CHIP_KINDS: ReadonlyMap<string, "due" | "repeat" | "priority"> = new Map([
  ["due", "due"],
  ["📅", "due"],
  ["repeat", "repeat"],
  ["🔁", "repeat"],
  ["priority", "priority"],
  ["🔺", "priority"],
  ["⏫", "priority"],
  ["🔼", "priority"],
  ["🔽", "priority"],
  ["⏬", "priority"],
]);

/** A priority emoji IS the value; the chip label comes from here. */
const PRIORITY_EMOJI_LABEL: ReadonlyMap<string, string> = new Map([
  ["🔺", "highest"],
  ["⏫", "high"],
  ["🔼", "medium"],
  ["🔽", "low"],
  ["⏬", "lowest"],
]);

/**
 * Whether a field's value types, per the dialect's authority — never a second
 * date parser and never a second rule grammar here (§3.6.4's
 * consume-never-redefine rule).
 *
 * `repeat` types iff the closed recurrence vocabulary reads it AND the line it
 * sits on carries an anchor date to advance from (MYND-615 task 10; myne#197).
 * This is the one field where a false "types" is not merely cosmetic: a rule
 * Myne cannot read must LOOK unread, because the silent alternative is
 * data-loss-shaped — the user believes the task repeats, completes it, nothing
 * appears, and they find out by missing something months later.
 *
 * The **line** is what makes the second half possible. Asking only whether the
 * vocabulary can *parse* the rule was the gap: `[repeat:: every day]` with no
 * date parses perfectly and then does nothing at all, which is exactly the
 * failure the paragraph above describes — it just wasn't covered, because the
 * question was about the value rather than about the record.
 */
function valueTypes(
  kind: "due" | "repeat" | "priority",
  value: string,
  lineText: string,
): boolean {
  if (kind === "due") return parseTaskInstant(value) !== null;
  if (kind === "priority") return PRIORITY_WORDS.has(value.toLowerCase());
  return parseRecurrenceSpec(value).ok && canRecur(lineText);
}

/**
 * The hover hint on a field Myne could not read.
 *
 * Each says what Myne could not read AND what follows from that, because the
 * consequence is the part the user cannot infer: an unreadable `repeat` means
 * the task will not repeat, which is precisely the surprise this state exists
 * to prevent.
 *
 * `repeat` has **two** ways to not work and they call for different actions, so
 * they get different hints: a rule outside the vocabulary is corrected, a rule
 * with no anchor date needs one added. Resolved here rather than at the
 * decoration site so the chip scanner is the only thing that decides what an
 * untyped field means.
 */
const INVALID_HINT_KEY: Readonly<Record<"due" | "repeat" | "priority", string>> = {
  due: "editor.taskField.invalidDue",
  repeat: "editor.taskField.invalidRepeat",
  priority: "editor.taskField.invalidPriority",
};

/** The hint for a field that did NOT type. Only meaningful in that case. */
function invalidHintKey(kind: "due" | "repeat" | "priority", value: string): string {
  // Reaching here means the field failed to type. For `repeat` that leaves two
  // possibilities, and if the vocabulary DOES read the rule then the failure was
  // the anchor — saying "Myne doesn't recognise this rule" would send the user
  // to fix a rule that is already correct.
  if (kind === "repeat" && parseRecurrenceSpec(value).ok) {
    return "editor.taskField.repeatNoAnchor";
  }
  return INVALID_HINT_KEY[kind];
}

/**
 * What a chip DISPLAYS, given the source bytes it stands for.
 *
 * Identity for everything except a recognized recurrence rule, which is stored
 * canonically in English and shown in the reader's language (task 11). An
 * unrecognized rule is never localized — there is nothing to localize, and the
 * raw text is exactly what the user needs to see to fix it.
 */
function displayLabel(kind: "due" | "repeat" | "priority", value: string, typed: boolean): string {
  if (kind !== "repeat" || !typed) return value;
  const spec = parseRecurrenceSpec(value);
  return spec.ok ? recurrenceLabel(spec.spec) : value;
}

const PRIORITY_WORDS: ReadonlySet<string> = new Set([
  "highest",
  "high",
  "medium",
  "low",
  "lowest",
]);

/** One chippable field occurrence: the whole node span plus what it says. */
export type ChipSpan = {
  from: number;
  to: number;
  /** Canonical kind — `due` / `repeat` / `priority`, dialect-independent. */
  kind: "due" | "repeat" | "priority";
  /**
   * The VALUE, in source form — the bytes that are in the file, and the bytes an
   * editor commits back. Kept separate from {@link label} so a localized display
   * can never travel back into a write.
   */
  value: string;
  /**
   * What the chip SHOWS. Equal to {@link value} everywhere except a recognized
   * recurrence rule, which is stored canonically and rendered in the reader's
   * language (MYND-615 task 11).
   */
  label: string;
  /**
   * Whether the value TYPED (MYND-614 task 8). A field whose value does not
   * parse renders as raw source text with a subtle failure hint rather than as a
   * chip — never a blank chip, and never a silently corrected value.
   */
  typed: boolean;
  /**
   * The i18n key of the hint to show while {@link typed} is false, naming both
   * what Myne could not read and what follows from it. Meaningless — and unread
   * — when the value typed.
   */
  hintKey: string;
};

/**
 * Every chippable task field in `[from, to)`.
 *
 * The **single** predicate. Both the decoration builder and the atomic-range
 * provider call this with the same bounds, so their outputs cannot diverge.
 *
 * Also read by the add-field flow (`task-field-menu.ts`) to learn which kinds a
 * line already carries and, for a present one, prefill the editor with its
 * source value — so the same predicate that renders the chips decides "add" vs
 * "edit", and no second field scanner exists.
 */
export function chipRangesIn(state: EditorState, from: number, to: number): ChipSpan[] {
  const out: ChipSpan[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.name !== "TaskField") return undefined;
      let key = "";
      let value = "";
      for (let c = node.node.firstChild; c; c = c.nextSibling) {
        if (c.name === "TaskFieldKey") key = state.doc.sliceString(c.from, c.to);
        if (c.name === "TaskFieldValue") value = state.doc.sliceString(c.from, c.to);
      }
      const folded = key.replace(/️$/, "").toLowerCase();
      const kind = CHIP_KINDS.get(folded);
      if (kind === undefined) return false;
      // A priority emoji carries no value node — the marker is the value.
      const emojiValue = PRIORITY_EMOJI_LABEL.get(folded);
      const source = emojiValue ?? value;
      if (source === "") return false;
      // The LINE, not just the value: `repeat` types only if it can be evaluated
      // where it sits, which depends on the other fields beside it (myne#197).
      const lineText = state.doc.lineAt(node.from).text;
      const typed = emojiValue !== undefined || valueTypes(kind, value, lineText);
      out.push({
        from: node.from,
        to: node.to,
        kind,
        value: source,
        label: displayLabel(kind, source, typed),
        typed,
        hintKey: typed ? "" : invalidHintKey(kind, value),
      });
      return false;
    },
  });
  return out;
}

class TaskChipWidget extends WidgetType {
  constructor(
    private readonly kind: "due" | "repeat" | "priority",
    /** What the chip shows — already localized where that applies. */
    private readonly value: string,
    /** Source position, part of widget IDENTITY — see `eq`. */
    private readonly from: number,
  ) {
    super();
  }

  /**
   * Identity includes the source position, not just the value.
   *
   * CodeMirror reuses widget DOM when `eq` returns true. Two chips with the same
   * due date on different lines are equal by value alone, so a value-only `eq`
   * lets the editor reuse one chip's DOM for the other after an edit shifts
   * lines — and a click then resolves against the wrong range.
   */
  eq(other: TaskChipWidget): boolean {
    return (
      other.kind === this.kind && other.value === this.value && other.from === this.from
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `cm-task-chip cm-task-chip-${this.kind}`;
    span.setAttribute("role", "button");
    span.setAttribute("tabindex", "0");
    span.setAttribute("data-testid", `editor.task-chip-${this.kind}`);
    span.setAttribute("data-task-chip", this.kind);
    // The position is NOT baked into a closure — it rides a data attribute the
    // handler re-reads live (see `taskChipAt`), because the DOM outlives the
    // offset it was built at.
    span.setAttribute("data-chip-from", String(this.from));
    // Accessible name: the field's meaning plus its value, so a screen reader
    // announces "due, 2026-08-01" rather than a bare date with no context.
    span.setAttribute("aria-label", `${this.kind}, ${this.value}`);
    span.textContent = this.value;
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Whether task chips are currently revealed as raw source text.
 *
 * **Never on caret** — unlike every cursor-aware decoration around it — and
 * **always while the find panel is open**. Reading mode overrides both.
 */
export function taskChipsRevealed(state: EditorState): boolean {
  if (state.facet(readingModeFacet)) return false;
  return searchPanelOpen(state);
}

function buildTaskChipDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  if (taskChipsRevealed(view.state)) return Decoration.none;
  for (const { from, to } of view.visibleRanges) {
    for (const span of chipRangesIn(view.state, from, to)) {
      if (!span.typed) {
        // Raw source text plus a subtle failure hint, following the math-error
        // widget: never a blank chip, never a silently corrected value. A mark
        // decoration leaves the characters in place, so the text stays editable
        // AND stays clickable — and the bytes are untouched, which is what lets
        // the user fix the value by reading what they actually wrote.
        decorations.push(
          Decoration.mark({
            class: "cm-task-field-invalid",
            attributes: {
              "data-testid": `editor.task-field-invalid-${span.kind}`,
              title: i18n.t(span.hintKey),
            },
          }).range(span.from, span.to),
        );
        continue;
      }
      decorations.push(
        Decoration.replace({
          widget: new TaskChipWidget(span.kind, span.label, span.from),
        }).range(span.from, span.to),
      );
    }
  }
  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => a.from - b.from);
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

/**
 * Atomic ranges for chipped due fields — **the same predicate over the same
 * scope** as the builder above, so arrow keys and backspace treat a chip as one
 * unit and no off-screen raw text is ever made atomic.
 */
function taskChipAtomicRanges(view: EditorView) {
  const ranges: Array<Range<Decoration>> = [];
  // Revealed chips are raw text; making raw text atomic is exactly the bug the
  // shared predicate exists to prevent, so bail on the same condition.
  if (taskChipsRevealed(view.state)) return Decoration.none;
  for (const { from, to } of view.visibleRanges) {
    for (const span of chipRangesIn(view.state, from, to)) {
      // A malformed field renders as raw text, so it must not be atomic — the
      // user has to be able to put the caret inside and fix it.
      if (!span.typed) continue;
      ranges.push(Decoration.replace({}).range(span.from, span.to));
    }
  }
  const builder = new RangeSetBuilder<Decoration>();
  ranges.sort((a, b) => a.from - b.from);
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

/**
 * Resolve a chip element to its CURRENT source span, live from the document.
 *
 * The rendered `data-chip-from` is only a hint: an edit above the line shifts
 * every offset below it, and CodeMirror may reuse the DOM node. So the authority
 * is `posAtDOM` plus a fresh tree walk — the attribute is used only to
 * disambiguate when a position sits exactly between two adjacent fields.
 */
export function taskChipAt(view: EditorView, target: HTMLElement): ChipSpan | null {
  const pos = view.posAtDOM(target);
  const line = view.state.doc.lineAt(pos);
  const spans = chipRangesIn(view.state, line.from, line.to);
  if (spans.length === 0) return null;
  return (
    spans.find((s) => pos >= s.from && pos <= s.to) ??
    spans.find((s) => s.from >= pos) ??
    null
  );
}

/** Fired when a due chip is activated; the host opens the editor for it. */
export const TASK_CHIP_EVENT = "myne-open-task-chip";

export type TaskChipEventDetail = {
  kind: "due" | "repeat" | "priority";
  /** The value in SOURCE form, never the localized label — this is what the
   *  field editor prefills with and what a commit writes back. */
  value: string;
  from: number;
  to: number;
};

export function taskChipDecorations(): readonly Extension[] {
  return [
    pendingChipField,
    makeGatedDecorationPlugin(
      buildTaskChipDecorations,
      // The find panel drives reveal here, and `openSearchPanel` changes neither
      // doc, viewport, selection nor focus — so the default gate would never
      // fire and a chip would sit on top of the match the user just searched for.
      (update) => searchPanelOpen(update.startState) !== searchPanelOpen(update.state),
    ),
    EditorView.atomicRanges.of(taskChipAtomicRanges),
    EditorView.domEventHandlers({
      keydown(event, view) {
        // Keyboard activation, so a chip is operable without a pointer. The
        // chip is the ONLY way to edit these values in live mode (they never
        // open on caret entry), which makes this a correctness requirement
        // rather than an enhancement.
        if (event.key !== "Enter" && event.key !== " ") return false;
        const target = event.target as HTMLElement | null;
        const chip = target?.closest?.("[data-task-chip]") as HTMLElement | null;
        if (chip === null || chip === undefined) return false;
        const span = taskChipAt(view, chip);
        if (span === null) return false;
        event.preventDefault();
        // Dispatched on the CHIP, not on `view.dom`. It bubbles either way, but
        // the target is what a listener uses to recover the element it must
        // anchor a popover to — and `view.dom` is the chip's ANCESTOR, so a
        // `closest("[data-task-chip]")` from there finds nothing. Getting this
        // wrong makes the chips render and do nothing.
        chip.dispatchEvent(
          new CustomEvent<TaskChipEventDetail>(TASK_CHIP_EVENT, {
            bubbles: true,
            detail: { kind: span.kind, value: span.value, from: span.from, to: span.to },
          }),
        );
        return true;
      },
      mousedown(event, view) {
        const target = event.target as HTMLElement | null;
        const chip = target?.closest?.("[data-task-chip]") as HTMLElement | null;
        if (chip === null || chip === undefined) return false;
        const span = taskChipAt(view, chip);
        if (span === null) return false;
        // `preventDefault` so the click does not move the caret into the field,
        // which the cursor-aware reveal would read as "edit me" and flip to raw
        // text instead of opening the editor (the tag-chip precedent).
        event.preventDefault();
        chip.dispatchEvent(
          new CustomEvent<TaskChipEventDetail>(TASK_CHIP_EVENT, {
            bubbles: true,
            detail: { kind: span.kind, value: span.value, from: span.from, to: span.to },
          }),
        );
        return true;
      },
    }),
  ];
}

/**
 * A chip edit that is currently OPEN, tracked across document changes.
 *
 * The field editor is a popover, and the document stays live underneath it: a
 * background autosave rewrites the frontmatter `updated:` stamp about a second
 * after any edit, and the user may be editing in another pane. So the offsets
 * captured when the chip was clicked are stale by the time the user commits.
 *
 * They are stale in a way that CORRUPTS rather than fails: an insertion above
 * the task line shifts every offset below it, and writing at the captured
 * position lands the new value in whatever text now occupies it — a heading, in
 * the case that first exposed this. Re-finding the chip by DOM does not help,
 * because CodeMirror recreates widget DOM on the same change that invalidates
 * the offsets.
 *
 * A `StateField` mapped through `tr.changes` is the fix that cannot drift: it
 * tracks the span the way CodeMirror tracks every other position. If the span
 * is deleted outright, it collapses and the field goes null, so the write
 * declines rather than guessing.
 */
type PendingChip = { from: number; to: number; kind: "due" | "repeat" | "priority" };

const setPendingChip = StateEffect.define<PendingChip | null>();

const pendingChipField = StateField.define<PendingChip | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPendingChip)) return e.value;
    if (value === null) return null;
    // -1 / 1 association: text inserted exactly at a boundary stays OUTSIDE the
    // span, so typing next to a chip never silently widens what a commit
    // replaces. `MapMode.TrackDel` yields null when a deletion crossed the
    // position, which is how a field deleted out from under an open popover
    // becomes null instead of collapsing onto whatever replaced it — plain
    // mapping hands back the replacement's own bounds, and the commit then
    // writes into text the user never opened.
    const from = tr.changes.mapPos(value.from, -1, MapMode.TrackDel);
    const to = tr.changes.mapPos(value.to, 1, MapMode.TrackDel);
    if (from === null || to === null || to <= from) return null;
    return { from, to, kind: value.kind };
  },
});

/** A tracked edit-in-progress: read the CURRENT span, or end the tracking. */
export type TaskFieldEditHandle = {
  /** The span as it stands now, or null if it no longer exists. */
  current: () => PendingChip | null;
  /** Stop tracking. Idempotent in effect — a second call just re-clears. */
  end: () => void;
};

/**
 * Begin tracking a chip edit. Call on open; call `end()` on commit or dismiss.
 *
 * The dispatch carries only an effect and no changes, so it adds nothing to
 * undo history — opening a popover is not an edit.
 */
export function beginTaskFieldEdit(
  view: EditorView,
  span: { from: number; to: number; kind: "due" | "repeat" | "priority" },
): TaskFieldEditHandle {
  view.dispatch({
    effects: setPendingChip.of({ from: span.from, to: span.to, kind: span.kind }),
  });
  return {
    current: () => view.state.field(pendingChipField, false) ?? null,
    end: () => view.dispatch({ effects: setPendingChip.of(null) }),
  };
}

/**
 * Apply a chip edit as ONE transaction (MYND-614 task 7).
 *
 * Three properties, each load-bearing:
 *
 *   - **One transaction per user gesture**, with a namespaced `userEvent` label,
 *     so a single undo restores the prior state exactly. Two dispatches would
 *     mean two undos for one visible action.
 *   - **The whole line converts** to Myne's write format, including fields the
 *     user did not touch. That follows from the dialect rule that only lines
 *     directly changed adopt canonical forms — and it has a real cost, accepted
 *     at the epic level: a task imported from Obsidian and then edited here drops
 *     out of that user's Obsidian Tasks view. This function is where that becomes
 *     active rather than latent.
 *   - **Emission goes through the single writer seam**
 *     (`dialect/src/taskFieldWriter.ts`). This module computes no bytes of its
 *     own; a second body writer would be a regression against the recorded
 *     single-writer discipline.
 *
 * Returns `false` when nothing would change, so a caller can tell a no-op from a
 * write.
 */
export function applyTaskFieldEdit(
  view: EditorView,
  span: { from: number; to: number; kind: "due" | "repeat" | "priority" },
  nextValue: string,
): boolean {
  const line = view.state.doc.lineAt(span.from);
  const lineText = line.text;

  const current = parseTaskFields(lineText);
  const next: TaskFields = { ...current };

  if (span.kind === "priority") {
    next.priority = nextValue === "" ? undefined : (nextValue as TaskFields["priority"]);
  } else if (span.kind === "repeat") {
    next.repeat = nextValue === "" ? undefined : nextValue;
  } else {
    // `due` — type through the dialect's own instant parser, so the single
    // typing authority stays there AND no task-field byte string is built here.
    const instant = nextValue === "" ? null : parseTaskInstant(nextValue);
    next.due = instant ?? undefined;
    if (instant === null && nextValue !== "") {
      // A value the parser refuses is preserved verbatim rather than dropped —
      // the editor will render it as raw text with a hint (task 8).
      next.malformed = [
        ...current.malformed.filter((f) => f.key !== "due"),
        // `raw` is unused by the writer (it re-emits from key+value), and
        // building a byte-shaped string here would muddy the grep that proves
        // the writer seam is the only emit site. Left empty on purpose.
        { key: "due", value: nextValue, raw: "" },
      ];
      next.due = undefined;
    } else {
      next.malformed = current.malformed.filter((f) => f.key !== "due");
    }
  }

  const edit = planTaskFieldWrite(lineText, next);
  if (edit === null) return false;

  view.dispatch({
    changes: {
      from: line.from + edit.range.start,
      to: line.from + edit.range.end,
      insert: edit.text,
    },
    // Namespaced so a single undo restores the prior state and the event is
    // attributable in a transaction log.
    userEvent: "myne.task-field.edit",
  });
  return true;
}
