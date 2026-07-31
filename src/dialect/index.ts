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
// Clip serializer (capture-extraction / browser-extension epic, SYNC-7/11):
// best-effort markdown → canonical-D1 bytes via the shared `parser` singleton.
export { serializeClipMarkdown } from "./clip";
// Image-reference seam contract (task 9, SYNC-10/SYNC-14): the `clip-image:N`
// positional reference the serializer emits per embedded image + the
// recover-index helper. Consumed by sub-feature 3's desktop ingest to match
// ref→`image_bytes[]` and rewrite to form-C `![[att:<id>|filename]]`.
export {
  CLIP_IMAGE_SCHEME,
  clipImageRef,
  parseClipImageRef,
} from "./clip";
// `capture_kind` discriminator + the two-shape clip-input contract (task 8,
// SYNC-10): both `full-article` and `selection` (highlight) clips route through
// the ONE `serializeClipMarkdown`; provenance is carried, not emitted.
// `serializeClip` returns a structured {@link ClipSerializeResult} (task 10): an
// `ok` body or a `no-content` outcome (distinct from a valid short clip), so the
// popup (sub-feature 4) can render "nothing to clip here" without the serializer
// ever fabricating an empty/garbage note.
export { serializeClip, CAPTURE_KINDS } from "./clip/captureKind";
export type {
  CaptureKind,
  ClipInput,
  ClipSerializeResult,
} from "./clip/captureKind";
export { extractFullText, extractBodyText } from "./visitors/fullText";
// SYNC-1 (MYND-300): the canonical heading-list-with-positions surface MYND-305
// imports for anchor resolution + `[[#` autocomplete.
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
  patchKindField,
  patchDoneField,
  patchFrontmatterField,
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
export { lineDiff, changedLineCount } from "./diff";
export type { DiffLine } from "./diff";
// Conflict-copy orchestrators (SYNC-45) — shared with mobile via injected note-IO.
export {
  buildConflictCopyContent,
  clearConflictMarkers,
  createConflictCopy,
  applyConflictVersion,
  undoConflictVersion,
} from "./conflictCopy";
export type { ConflictCopyHost } from "./conflictCopy";
