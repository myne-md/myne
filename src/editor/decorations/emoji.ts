// Emoji shortcode rendering (MYND-156, inline-typography-extensions task 3).
//
// The @lezer/markdown `Emoji` config tags a `:word:` run as an `Emoji` node but
// does NOT map it to a glyph. This decoration looks the name up in a LAZY-LOADED
// shortcode map and replaces the `:word:` source with the unicode glyph
// off-cursor (revealed on-cursor); an unmapped shortcode stays literal text.
// Render-only — the buffer is never mutated (§6 C1).
//
// The map (`src/dialect/emoji-shortcodes.ts`) is reached via dynamic `import()`
// so it is code-split out of the cold editor bundle (SYNC-4). It loads into
// `emojiMapField` once per mount; the decoration rebuilds when it arrives.

import { syntaxTree } from "@codemirror/language";
import {
  type Extension,
  type Range,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { isInsideRange } from "./cursor-aware";
import { treeChanged } from "./plugin-factory";

type EmojiMap = Readonly<Record<string, string>>;

/** Dispatched once the lazy emoji map resolves. */
export const setEmojiMap = StateEffect.define<EmojiMap>();

/** The loaded shortcode→glyph map, `null` until the dynamic import resolves. */
export const emojiMapField = StateField.define<EmojiMap | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setEmojiMap)) return e.value;
    return value;
  },
});

// One dynamic import shared across editor mounts (cached promise).
let mapPromise: Promise<EmojiMap> | null = null;
type Loader = () => Promise<EmojiMap>;
let loadEmoji: Loader = () => {
  if (mapPromise === null) {
    mapPromise = import("../../dialect/emoji-shortcodes").then((m) => m.EMOJI);
  }
  return mapPromise;
};

/** The (overridable, cached) emoji map loader — reused by the `:` autocomplete
 *  source (`emoji-complete.ts`) so both share one dynamic import + test stub. */
export function loadEmojiMap(): Promise<EmojiMap> {
  return loadEmoji();
}

/** Override the loader (tests only); returns a restore fn. */
export function setEmojiLoader(loader: Loader): () => void {
  const prev = loadEmoji;
  loadEmoji = loader;
  mapPromise = null;
  return () => {
    loadEmoji = prev;
    mapPromise = null;
  };
}

const emojiLoaderPlugin = ViewPlugin.fromClass(
  class {
    private destroyed = false;
    constructor(view: EditorView) {
      void loadEmoji().then((map) => {
        if (this.destroyed) return;
        view.dispatch({ effects: setEmojiMap.of(map) });
      });
    }
    destroy() {
      this.destroyed = true;
    }
  },
);

class EmojiWidget extends WidgetType {
  constructor(private readonly glyph: string) {
    super();
  }
  eq(other: EmojiWidget): boolean {
    return other.glyph === this.glyph;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-emoji";
    span.textContent = this.glyph;
    return span;
  }
}

function buildEmojiDecorations(view: EditorView): DecorationSet {
  const map = view.state.field(emojiMapField, false) ?? null;
  if (map === null) return Decoration.none;

  const decorations: Array<Range<Decoration>> = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Emoji") return undefined;
        if (isInsideRange(view, node.from, node.to)) return undefined; // reveal
        const raw = view.state.doc.sliceString(node.from, node.to); // `:word:`
        const name = raw.slice(1, -1); // strip the surrounding colons
        const glyph = map[name];
        if (glyph === undefined) return undefined; // unmapped → stays literal
        decorations.push(
          Decoration.replace({ widget: new EmojiWidget(glyph) }).range(
            node.from,
            node.to,
          ),
        );
        return undefined;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => a.from - b.from);
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

const emojiDecorationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildEmojiDecorations(view);
    }
    update(update: ViewUpdate) {
      const mapChanged =
        update.startState.field(emojiMapField, false) !==
        update.state.field(emojiMapField, false);
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        mapChanged ||
        treeChanged(update)
      ) {
        this.decorations = buildEmojiDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export function emojiDecorations(): readonly Extension[] {
  return [emojiMapField, emojiLoaderPlugin, emojiDecorationPlugin];
}
