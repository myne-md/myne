// Public aggregator. Consumers import from this entry only.
// Spec: docs/spec/markdown-dialect.md (D1).

export type {
  ByteRange,
  ParseError,
  ParseErrorSeverity,
  YamlParseError,
  FrontmatterUnclosedError,
  WikilinkUnclosedError,
  FencedCodeUnclosedError,
  Frontmatter,
  HeadingLevel,
  HeadingRef,
  WikilinkRef,
  WikilinkTargetKind,
  InlineTagRef,
  MediaRef,
  ParseResult,
} from "./types";

export { parse } from "./parse";
export { extractFullText } from "./visitors/fullText";
export {
  buildInitialPlaintext,
  formatYamlScalar,
  patchFirstH1Line,
  patchFolderField,
  patchSourceRanges,
  patchTitleField,
  patchTrashedField,
  patchUpdatedField,
  readTrashedFromFmBody,
} from "./surgery";
export { parseStream } from "./worker";
export type { ParseStreamItem, ParseStreamResult } from "./worker";
