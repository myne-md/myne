// Shared parser. Single instance lets the aggregator's "single lezer parse"
// guarantee be enforced and spied on; each visitor accepts an optional
// pre-parsed `tree` and falls back to `parser.parse(source)` when standalone.

import { parser as baseParser, GFM } from "@lezer/markdown";
import { Wikilink } from "./wikilink";
import { InlineTag } from "./inline-tag";

export const parser = baseParser.configure([GFM, Wikilink, InlineTag]);
