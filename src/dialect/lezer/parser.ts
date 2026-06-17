// Shared parser. Single instance lets the aggregator's "single lezer parse"
// guarantee be enforced and spied on; each visitor accepts an optional
// pre-parsed `tree` and falls back to `parser.parse(source)` when standalone.

import {
  parser as baseParser,
  GFM,
  Subscript,
  Superscript,
  Emoji,
} from "@lezer/markdown";
import { Wikilink } from "./wikilink";
import { InlineTag } from "./inline-tag";
import { DefinitionList } from "./definition-list";
import { Footnote } from "./footnote";
import { Highlight } from "./highlight";
import { Math } from "./math";
import { Comment } from "./comment";

export const parser = baseParser.configure([
  GFM,
  Wikilink,
  InlineTag,
  DefinitionList,
  Footnote,
  // Dialect comments `%%…%%` (MYND-315): inline delimiter + multi-line leaf
  // block, both terminated-only (an unterminated `%%` stays plain text).
  // Recognize-only — render hides off-cursor, lossy projections strip; bytes
  // round-trip unchanged (§6 C1). `.md` export stays verbatim (SYNC-2).
  Comment,
  // Inline typography (MYND-156): pre-built Sub/Super/Emoji configs from
  // @lezer/markdown + the hand-rolled Highlight (`==`). Recognize-only — the
  // editor decorations render them; serialization visitors fall through so
  // bytes round-trip unchanged (§6 C1).
  Subscript,
  Superscript,
  Emoji,
  Highlight,
  // Inline math `$…$` (MYND-48); block `$$…$$` is a decoration, not a node.
  Math,
]);
