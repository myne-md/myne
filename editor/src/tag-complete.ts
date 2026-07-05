// Inline `#tag` autocomplete (tag-system follow-up / MYND-45). As the user types
// `#ed`, offer matching EXISTING tags from the in-RAM index (`tagTree()`);
// selecting one inserts the tag's display text. Built on the in-tree
// `@codemirror/autocomplete` (same as `emoji-complete.ts`). Suggests only tags
// that already exist — this is completion, not tag creation; an unmatched prefix
// just stays literal and the index picks it up on save like any inline tag.

import {
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { foldSegment } from "@myne/dialect/folderPath";
import { isInCode } from "./decorations/cursor-aware";
import { tagTree } from "@myne/editor/host/notes/vaultIndices";

export async function tagCompletionSource(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  // A started inline tag: `#` + tag-ish chars immediately before the cursor.
  const match = context.matchBefore(/#[\p{L}\p{N}_/-]*/u);
  if (match === null) return null;
  // Boundary (dialect §3.7): a tag's `#` sits at line start or after whitespace —
  // otherwise it's `word#frag`, not a tag.
  if (match.from > 0) {
    const before = context.state.doc.sliceString(match.from - 1, match.from);
    if (!/\s/.test(before)) return null;
  }
  // `#` is common in code (CSS ids, comments) — don't fire there.
  if (isInCode(context.state, match.from)) return null;
  const typed = match.text.slice(1); // drop the leading `#`
  // Skip a bare `#` (e.g. an ATX heading `# Title`) unless explicitly invoked.
  if (!context.explicit && typed.length < 1) return null;

  const folded = foldSegment(typed);
  const nodes = await tagTree();
  const options = nodes
    .filter((n) => n.key.includes(folded))
    .sort((a, b) => {
      const ap = a.key.startsWith(folded) ? 0 : 1;
      const bp = b.key.startsWith(folded) ? 0 : 1;
      return ap - bp || a.key.localeCompare(b.key);
    })
    .slice(0, 30)
    .map((n) => ({
      label: `#${n.display}`,
      detail: `${n.subtreeCount}`,
      apply: `#${n.display}`, // insert the tag's display text verbatim
      type: "text",
    }));
  if (options.length === 0) return null;
  return { from: match.from, to: match.to, options, filter: false };
}
