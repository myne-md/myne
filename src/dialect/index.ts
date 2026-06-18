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
// SYNC-1 (MYND-300): the canonical heading-list-with-positions surface MYND-305
// imports for anchor resolution + `[[#` autocomplete.
export { headingSections } from "./visitors/headingSections";
export type { HeadingSection } from "./visitors/headingSections";
export { stripDialectComments, hasDialectComment } from "./stripComments";
export {
  buildInitialPlaintext,
  formatYamlScalar,
  patchFirstH1Line,
  patchFolderField,
  patchFolderIndexField,
  patchFrontmatterField,
  patchSourceRanges,
  patchTemplateField,
  patchTitleField,
  patchTrashedField,
  patchUpdatedField,
  readFolderIndexFromFmBody,
  readTemplateFromFmBody,
  readTitleFromFmBody,
  readTrashedFromFmBody,
  FOLDER_INDEX_FLAG_VALUE,
  TEMPLATE_FLAG_VALUE,
} from "./surgery";
export { parseStream } from "./worker";
export type { ParseStreamItem, ParseStreamResult } from "./worker";
