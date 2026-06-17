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
export { extractFullText, extractBodyText } from "./visitors/fullText";
export { stripDialectComments, hasDialectComment } from "./stripComments";
export {
  buildInitialPlaintext,
  formatYamlScalar,
  patchFirstH1Line,
  patchFolderField,
  patchFrontmatterField,
  patchSourceRanges,
  patchTemplateField,
  patchTitleField,
  patchTrashedField,
  patchUpdatedField,
  readTemplateFromFmBody,
  readTitleFromFmBody,
  readTrashedFromFmBody,
  TEMPLATE_FLAG_VALUE,
} from "./surgery";
export { parseStream } from "./worker";
export type { ParseStreamItem, ParseStreamResult } from "./worker";
