// Spec: agent-tooling/docs/spec/markdown-dialect.md §3.7. `tag` is verbatim source bytes
// minus the leading `#`; NFC + case-fold are the index layer's job (B10.4)
// per the 2026-05-09 grill addendum.

import type { Tree } from "@lezer/common";
import { parser } from "../lezer/parser";
import type { InlineTagRef } from "../types";

export function extractInlineTags(source: string, tree?: Tree): InlineTagRef[] {
  if (source.length === 0) return [];
  const t = tree ?? parser.parse(source);
  const results: InlineTagRef[] = [];
  t.iterate({
    enter: (nodeRef) => {
      if (nodeRef.name !== "InlineTag") return undefined;
      const from = nodeRef.from;
      const to = nodeRef.to;
      const raw = source.substring(from, to);
      results.push({
        raw,
        tag: raw.substring(1),
        byteRange: { start: from, end: to },
      });
      return false;
    },
  });
  return results;
}
