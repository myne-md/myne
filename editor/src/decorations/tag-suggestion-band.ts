// The inline tag-suggestion band (on-device-tag-suggestion MYND-651 task 7).
//
// One block widget, anchored at the frontmatter/body boundary, rendering the
// tags the on-device tag model proposed for the open note. It is the SINGLE
// tag-suggestion surface — the chat-tab one it replaces goes away in task 8.
//
// A **port of the task-query block**, deliberately: the host pushes what to
// render through a `StateEffect` (never a new `EditorHost` member, which would
// carry a mobile-parity obligation for a desktop-only feature), the widget owns
// its DOM and nothing else, and activation leaves as a bubbling `CustomEvent`
// that the app turns into a write. This package computes no tags and writes no
// bytes.
//
// ABSENT WHEN IDLE, NOT EMPTY. With no suggestions the decoration set is
// `Decoration.none` — no zero-height node, no margin, nothing in the layout. An
// always-mounted empty band would shift every note in the vault by its own
// height for a feature that is off by default, and the shift would be visible
// as a jump the moment a pass landed. §6 C1 byte-stability is free either way:
// a widget decoration inserts no text, so the buffer is untouched on every path
// here.
//
// ANCHOR: `blockEnd`, NOT `bodyStart`. The dialect's `FrontmatterRange` names
// the YAML block's own interior `bodyStart`/`bodyEnd`; the boundary between the
// frontmatter and the NOTE body is `blockEnd` (this is the same offset
// `acceptTag.ts` slices the body from when it looks for inline `#tag`s). A note
// with no frontmatter anchors at 0 — the band sits above the first line, which
// is where the frontmatter would have been.
//
// REVEAL / MODES. Reading mode renders no band: it is an editing affordance, and
// a reading view is read-only, so a chip there would offer a write the view
// cannot perform. Source mode needs nothing — `viewModeExtension` empties the
// whole decoration stack, this module with it.

import {
  type EditorState,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import i18n from "@myne/editor/i18n";
import { cachedLocateFrontmatter } from "../frontmatter-cache";
import { readingModeFacet } from "./cursor-aware";

/**
 * One chip the host wants rendered. Flat and inert, like `TaskQueryRow`: the
 * ranking, the vocabulary fold and the model call all happen host-side, and what
 * crosses is the answer.
 */
export type TagSuggestionChip = {
  /** Display form — already the vault's canonical casing where the candidate
   *  collapsed onto an existing tag. */
  readonly tag: string;
  /** `true` when the tag is not yet in the vault's vocabulary (dashed `+` chip);
   *  `false` for an existing tag (solid chip). */
  readonly isNew: boolean;
};

/**
 * Push the suggestions for the open note.
 *
 * A reconfiguration-style effect rather than a host-interface member, for the
 * reason `setTaskQueryResults` gives: a new `EditorHost` member obliges every
 * client compiling this package to implement it, and this needs none.
 */
export const setTagSuggestions = StateEffect.define<readonly TagSuggestionChip[]>();

const NO_CHIPS: readonly TagSuggestionChip[] = [];

const tagSuggestionsField = StateField.define<readonly TagSuggestionChip[]>({
  create: () => NO_CHIPS,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTagSuggestions)) return e.value;
    return value;
  },
});

/** Fired when a chip is activated; the host writes the tag into frontmatter. */
export const TAG_SUGGESTION_ACCEPT_EVENT = "myne-tag-suggestion-accept";
/** Fired when a chip's × is activated; the host drops it for this note. */
export const TAG_SUGGESTION_DISMISS_EVENT = "myne-tag-suggestion-dismiss";

export type TagSuggestionEventDetail = { tag: string };

/**
 * Where the band sits: immediately after the frontmatter block, or at the top of
 * a note that has none. Exported so a test can assert the anchor without
 * reaching into the decoration set.
 */
export function tagSuggestionBandAnchor(state: EditorState): number {
  return cachedLocateFrontmatter(state.doc)?.blockEnd ?? 0;
}

class TagSuggestionBandWidget extends WidgetType {
  constructor(
    private readonly chips: readonly TagSuggestionChip[],
    /** Source position, part of widget IDENTITY — the chip-widget lesson
     *  (`task-chip.ts`): CodeMirror reuses widget DOM when `eq` says the two are
     *  the same, and a value-only identity lets it reuse a band built at a
     *  different offset after an edit moved the boundary. */
    private readonly from: number,
  ) {
    super();
  }

  eq(other: TagSuggestionBandWidget): boolean {
    if (other.from !== this.from || other.chips.length !== this.chips.length) return false;
    return this.chips.every((chip, i) => {
      const o = other.chips[i]!;
      return o.tag === chip.tag && o.isNew === chip.isNew;
    });
  }

  toDOM(): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-tag-suggestion-band";
    root.setAttribute("data-testid", "editor.tag-suggestion-band");
    root.setAttribute("data-suggestion-count", String(this.chips.length));

    const label = document.createElement("span");
    label.className = "cm-tag-suggestion-label";
    label.setAttribute("data-testid", "editor.tag-suggestion-label");
    label.textContent = i18n.t("editor.tagSuggestion.label");
    root.appendChild(label);

    for (const chip of this.chips) root.appendChild(this.chipDom(chip));
    return root;
  }

  private chipDom(chip: TagSuggestionChip): HTMLElement {
    const wrap = document.createElement("span");
    // Solid border = already in your vault, dashed = new. The distinction is the
    // sprawl guard made visible: accepting a dashed chip grows the vocabulary.
    wrap.className = chip.isNew
      ? "cm-tag-suggestion-chip cm-tag-suggestion-chip-new"
      : "cm-tag-suggestion-chip";

    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "cm-tag-suggestion-accept";
    accept.setAttribute("data-testid", "editor.tag-suggestion-chip");
    accept.setAttribute("data-is-new", chip.isNew ? "true" : "false");
    // The tag rides a data attribute the handler re-reads live rather than a
    // closure, so a reused DOM node can never accept a stale tag.
    accept.setAttribute("data-tag-accept", chip.tag);
    accept.setAttribute(
      "aria-label",
      i18n.t("editor.tagSuggestion.accept", { tag: chip.tag }),
    );
    accept.textContent = chip.isNew ? `+ ${chip.tag}` : chip.tag;
    wrap.appendChild(accept);

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "cm-tag-suggestion-dismiss";
    dismiss.setAttribute("data-testid", "editor.tag-suggestion-dismiss");
    dismiss.setAttribute("data-tag-dismiss", chip.tag);
    dismiss.setAttribute(
      "aria-label",
      i18n.t("editor.tagSuggestion.dismiss", { tag: chip.tag }),
    );
    dismiss.textContent = "×";
    wrap.appendChild(dismiss);

    return wrap;
  }

  ignoreEvent(): boolean {
    // The band owns its own clicks and keys — both chips halves are real
    // controls, and the handlers below resolve them.
    return false;
  }
}

/**
 * Build the band decoration — `Decoration.none` unless there is something to
 * show. Pure over the state, so a test can call it without a mounted view.
 */
export function buildTagSuggestionBand(state: EditorState): DecorationSet {
  const chips = state.field(tagSuggestionsField, false) ?? NO_CHIPS;
  if (chips.length === 0) return Decoration.none;
  // An editing affordance in a read-only view would offer a write the view
  // cannot perform.
  if (state.facet(readingModeFacet)) return Decoration.none;
  const at = tagSuggestionBandAnchor(state);
  const builder = new RangeSetBuilder<Decoration>();
  builder.add(
    at,
    at,
    Decoration.widget({
      widget: new TagSuggestionBandWidget(chips, at),
      block: true,
      // Before the block that starts here, i.e. between the frontmatter and the
      // first body line.
      side: -1,
    }),
  );
  return builder.finish();
}

const tagSuggestionBandField = StateField.define<DecorationSet>({
  create: (state) => buildTagSuggestionBand(state),
  update(deco, tr) {
    const pushed = tr.effects.some((e) => e.is(setTagSuggestions));
    const modeChanged =
      tr.startState.facet(readingModeFacet) !== tr.state.facet(readingModeFacet);
    // The anchor is a pure function of the document, so a doc change is the only
    // other thing that can move it. Selection and focus are irrelevant here: the
    // band never reveals, so it never needs a cursor-aware rebuild.
    if (tr.docChanged || pushed || modeChanged) return buildTagSuggestionBand(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function dispatchChipEvent(event: Event, view: EditorView): boolean {
  const target = event.target as HTMLElement | null;
  const accept = target?.closest?.("[data-tag-accept]") as HTMLElement | null;
  const dismiss = target?.closest?.("[data-tag-dismiss]") as HTMLElement | null;
  const hit = accept ?? dismiss;
  if (hit === null || hit === undefined) return false;
  const tag = hit.getAttribute(accept !== null ? "data-tag-accept" : "data-tag-dismiss");
  if (tag === null || tag === "") return false;

  // Without this the click lands in the document and moves the caret to the
  // nearest position — which, for a band sitting on the frontmatter boundary,
  // is inside the frontmatter block and would flip it open (the tag-chip
  // precedent).
  event.preventDefault();
  view.dom.dispatchEvent(
    new CustomEvent<TagSuggestionEventDetail>(
      accept !== null ? TAG_SUGGESTION_ACCEPT_EVENT : TAG_SUGGESTION_DISMISS_EVENT,
      { bubbles: true, detail: { tag } },
    ),
  );
  return true;
}

const chipEvents = EditorView.domEventHandlers({
  mousedown(event, view) {
    return dispatchChipEvent(event, view);
  },
  keydown(event, view) {
    // Keyboard activation, so the band is operable without a pointer.
    if (event.key !== "Enter" && event.key !== " ") return false;
    return dispatchChipEvent(event, view);
  },
});

export function tagSuggestionBandDecorations(): readonly Extension[] {
  return [tagSuggestionsField, tagSuggestionBandField, chipEvents];
}
