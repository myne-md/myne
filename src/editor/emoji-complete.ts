// Emoji `:` autocomplete (MYND-156, inline-typography-extensions task 5).
//
// As the user types `:roc`, offer matching shortcodes; selecting one inserts the
// UNICODE GLYPH directly (not the `:shortcode:` text) — so authoring emits a
// plain glyph (no new §5 emit construct), while the rendering decoration handles
// imported/hand-typed `:rocket:`. Built on the in-tree `@codemirror/autocomplete`
// (no new dependency); the completion source awaits the same lazy emoji map as
// the render decoration.

import {
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { loadEmojiMap } from "./decorations/emoji";

async function emojiCompletionSource(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  // A started shortcode: `:` + word chars immediately before the cursor.
  const match = context.matchBefore(/:[\w+-]*/);
  if (match === null || match.from === match.to) return null;
  const typed = match.text.slice(1).toLowerCase(); // drop the leading `:`
  // Avoid firing on a lone `:` unless the user explicitly invoked completion.
  if (!context.explicit && typed.length < 2) return null;

  const map = await loadEmojiMap();
  const matches = Object.entries(map).filter(([name]) => name.includes(typed));
  // Prefix matches first, then substring matches; cap the list.
  matches.sort((a, b) => {
    const ap = a[0].startsWith(typed) ? 0 : 1;
    const bp = b[0].startsWith(typed) ? 0 : 1;
    return ap - bp || a[0].localeCompare(b[0]);
  });
  const options = matches.slice(0, 30).map(([name, glyph]) => ({
    label: `:${name}:`,
    detail: glyph,
    apply: glyph, // insert the unicode glyph directly
    type: "text",
  }));
  if (options.length === 0) return null;
  return { from: match.from, to: match.to, options, filter: false };
}

// Exported for direct unit testing of the source + the combined autocomplete
// config (`editor/completion.ts`).
export { emojiCompletionSource };
