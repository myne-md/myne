// Live-collaboration awareness decorations (epic live-collab, `collab-presence-ui`
// task 2): each peer's caret as a point widget and their selection as a range mark,
// bound to the note the view holds.
//
// The engine takes a PUSHED list (`setAwareness` effect) and holds it in a
// `StateField`, so a `setState` swap from the persistent-view cache re-populates the
// field instead of dropping it (`reapplyCompartments` re-pushes it). Nothing is read
// from the frame codec, this is presentation only.
//
// # The peer shape is structural, and colour is a CSS variable
//
// The editor package is consumed by all three clients, so it does NOT import the app
// tree's `Participant`; `AwarenessPeer` is a structural twin and the app passes its
// `Participant` (plus the `var(--group-*)` string it already resolved). The palette
// name never crosses this boundary and no literal colour is written here, the widget
// sets `--cm-awareness-color` to the caller's `colorVar`.
//
// # What this deliberately does NOT do
//
// It installs no second `drawSelection`: the LOCAL caret/selection stay the editor's
// own, and a peer's caret/selection are drawn on top as plain widget/mark. A
// participant bound to another note renders nothing, so two panes editing different
// notes never bleed into each other.

import {
  type EditorState,
  type Extension,
  type Range,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

/** A peer's awareness, structurally compatible with the app's `Participant`. */
export interface AwarenessPeer {
  /** The stable identity key (person id / device id), used for widget identity. */
  id: string;
  /** The note this peer edits; a peer on another note renders nothing. */
  noteId: string;
  /** The resolver's resolved label, the caret widget's text. */
  label: string;
  /** True when the session assertion did not verify (degraded label). */
  unAttributed: boolean;
  /** Caret offset (scalar), or `null`. */
  caret: number | null;
  /** Selection span, or `null`. */
  selection: { anchor: number; head: number } | null;
  /** The resolved `var(--group-*)` string (the app computes it; no literal here). */
  colorVar: string;
}

/** The pushed awareness state: the note the view holds, and its peers. */
export interface AwarenessPush {
  noteId: string;
  peers: readonly AwarenessPeer[];
}

/** Push (or, with `undefined`, clear) the awareness set for the view's note. */
export const setAwareness = StateEffect.define<AwarenessPush | undefined>();

/** The decoration testids the E2E lane addresses (`collab-verification`,
 *  `collab-presence`). The shipped roster prefix is `editor.*` (consistent with
 *  `editor.presence-row` in the "Who's here" tab), NOT the `collab.*` names the
 *  feature's draft tasks.md planned. The reconciliation is recorded at the top
 *  of `e2e/collab-presence.e2e.ts`. */
const CARET_TESTID = "editor.remote-cursor";
const SELECTION_TESTID = "editor.remote-selection";

/** 1-based line number and 0-based column for `offset`, clamped to the doc. */
function lineChAt(state: EditorState, offset: number): { line: number; ch: number } {
  const clamped = Math.max(0, Math.min(offset, state.doc.length));
  const line = state.doc.lineAt(clamped);
  return { line: line.number, ch: clamped - line.from };
}

/** The observability attributes every awareness decoration carries (SYNC-8).
 *  `data-color` is the caller's resolved `var(--group-*)` string, never a
 *  literal colour; `data-line`/`data-ch` are the peer's position. */
function decorationAttrs(
  state: EditorState,
  testId: string,
  peer: AwarenessPeer,
  offset: number,
): Record<string, string> {
  const { line, ch } = lineChAt(state, offset);
  return {
    "data-testid": testId,
    "data-participant-id": peer.id,
    "data-color": peer.colorVar,
    "data-line": String(line),
    "data-ch": String(ch),
  };
}

function selectionMark(
  peer: AwarenessPeer,
  state: EditorState,
  head: number,
): Decoration {
  // Not cached: the attributes carry this peer's id and position, so two peers
  // sharing a colour must not share one instance.
  return Decoration.mark({
    class: "cm-awareness-selection",
    attributes: {
      style: `--cm-awareness-color: ${peer.colorVar}`,
      ...decorationAttrs(state, SELECTION_TESTID, peer, head),
    },
  });
}

/** The caret + label widget for one peer. */
class AwarenessCaret extends WidgetType {
  constructor(
    private readonly peer: AwarenessPeer,
    private readonly offset: number,
  ) {
    super();
  }
  override eq(other: AwarenessCaret): boolean {
    return (
      other.peer.id === this.peer.id &&
      other.peer.colorVar === this.peer.colorVar &&
      other.peer.label === this.peer.label &&
      other.peer.unAttributed === this.peer.unAttributed &&
      other.offset === this.offset
    );
  }
  override toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = "cm-awareness-caret";
    caret.style.setProperty("--cm-awareness-color", this.peer.colorVar);
    if (this.peer.unAttributed) caret.setAttribute("data-unattributed", "true");
    // `aria-hidden`: the label is a visual affordance; the roster is the accessible
    // list of who is here.
    caret.setAttribute("aria-hidden", "true");
    // The position attributes need the document, and a widget's `toDOM` has no
    // state, so the builder computes them and hands the string in.
    const attrs = this.attrs;
    for (const [k, v] of Object.entries(attrs)) caret.setAttribute(k, v);
    const label = document.createElement("span");
    label.className = "cm-awareness-label";
    label.textContent = this.peer.label;
    caret.appendChild(label);
    return caret;
  }
  /** Set by {@link buildDecorations} before `toDOM`; widget identity is `eq`. */
  attrs: Record<string, string> = {};
  override ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(
  push: AwarenessPush | undefined,
  state: EditorState,
): DecorationSet {
  if (push === undefined || push.peers.length === 0) return Decoration.none;
  const ranges: Array<Range<Decoration>> = [];
  for (const p of push.peers) {
    if (p.noteId !== push.noteId) continue; // a peer on another note renders nothing
    if (p.selection !== null) {
      const from = Math.min(p.selection.anchor, p.selection.head);
      const to = Math.max(p.selection.anchor, p.selection.head);
      if (from !== to) ranges.push(selectionMark(p, state, p.selection.head).range(from, to));
    }
    if (p.caret !== null) {
      const widget = new AwarenessCaret(p, p.caret);
      widget.attrs = decorationAttrs(state, CARET_TESTID, p, p.caret);
      const at = Math.max(0, Math.min(p.caret, state.doc.length));
      ranges.push(Decoration.widget({ widget, side: 1 }).range(at));
    }
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

const awarenessField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setAwareness)) next = buildDecorations(e.value, tr.state);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The awareness decoration extension (composed in `decorations/index.ts`). */
export function awarenessDecorations(): Extension {
  return awarenessField;
}

/** The field, for a caller that needs to read it back (tests, `reapplyCompartments`). */
export { awarenessField };
