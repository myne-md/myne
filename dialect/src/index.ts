// @myne/dialect — shared markdown-dialect PARSER CORE public surface.
// The desktop `src/dialect/index.ts` re-exports this (plus its desktop-only
// clip/html/text export-renderers) so its ~90 importers stay unchanged; the
// mobile client imports this package directly. Spec: docs/spec/markdown-dialect.md.

export * from "./folderPath";

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
export { headingSections } from "./visitors/headingSections";
export type { HeadingSection } from "./visitors/headingSections";
export type { NoteKind } from "./surgery";
export { stripDialectComments, hasDialectComment } from "./stripComments";
export {
  buildInitialPlaintext,
  formatYamlScalar,
  patchArchivedField,
  patchDeletedField,
  patchFirstH1Line,
  patchFolderField,
  patchFolderIndexField,
  patchFrontmatterField,
  patchKindField,
  patchDoneField,
  patchSourceRanges,
  patchTemplateField,
  patchTitleField,
  patchTrashedField,
  patchUpdatedField,
  readArchivedFromFmBody,
  readConflictFromFmBody,
  readConflictOfFromFmBody,
  readDeletedFromFmBody,
  readFolderIndexFromFmBody,
  readKindFromFmBody,
  readDoneFromFmBody,
  readTemplateFromFmBody,
  readTitleFromFmBody,
  readTrashedFromFmBody,
  DRAWING_KIND_VALUE,
  TASK_KIND_VALUE,
  CANONICAL_KIND_VALUES,
  FOLDER_INDEX_FLAG_VALUE,
  TEMPLATE_FLAG_VALUE,
} from "./surgery";
export { parseStream } from "./worker";
export type { ParseStreamItem, ParseStreamResult } from "./worker";
// Version-comparison core (MYND-334) — the one diff implementation behind the
// snapshot preview, the conflict-compare surface and (later) mobile.
export { lineDiff, diffWithSegments, changedLineCount } from "./diff";
export type { DiffLine, DiffSegment } from "./diff";
export { normalizeForDiff, normalizeConflictPair } from "./diffNormalize";
export type { NormalizedConflictPair } from "./diffNormalize";
