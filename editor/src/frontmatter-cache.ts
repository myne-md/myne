// `cachedLocateFrontmatter` — `Text`-keyed cache around the dialect's
// `locateFrontmatter` helper.
//
// Several decorations (`frontmatter.ts`, `horizontal-rule.ts`) need to know
// whether a doc has a line-1-anchored YAML frontmatter block, on every
// `selectionSet` rebuild. Without caching, each rebuild calls
// `view.state.doc.toString()` (O(n) memory copy) + `locateFrontmatter`
// (O(n) scan) — for a 16 MiB note, this happens on every cursor keystroke
// across two plugins.
//
// The CM6 `Text` instance is reference-stable across non-doc transactions
// (`selectionSet`, `viewportChanged`, `focusChanged`). A `WeakMap<Text,
// FrontmatterRange | null>` collapses the per-keystroke cost to O(1) cache
// hit; only docChanged transactions pay the locate cost.

import type { Text } from "@codemirror/state";
import {
  locateFrontmatter,
  type FrontmatterRange,
} from "@myne/dialect/lezer/frontmatter";

const cache = new WeakMap<Text, FrontmatterRange | null>();

export function cachedLocateFrontmatter(
  doc: Text,
): FrontmatterRange | null {
  const cached = cache.get(doc);
  if (cached !== undefined) return cached;
  const result = locateFrontmatter(doc.toString());
  cache.set(doc, result);
  return result;
}
