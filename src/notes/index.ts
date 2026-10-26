// Barrel exports for the `src/notes/` module.
//
// Per the 2026-05-15 MYND-82 grill Q9 "Save-handler discipline":
// `src/notes/` houses Tauri IPC orchestration (one file per user-action
// helper, throws-on-error idiom). Surgery composition (`patchUpdatedField`,
// `patchTitleField`, `patchFirstH1Line`) lives in `src/dialect/surgery.ts`
// and is consumed BY this module's higher-level helpers (`saveNote`,
// `renameNote`).
//
// Discipline rule: `noteUpdate` MUST be called only from `./saveNote.ts`
// (and `./renameNote.ts` via the same composition). Direct callers
// would skip the `patchUpdatedField` surgery step → silent contract
// violation per `decisions.md` 2026-05-09. Reviewer enforcement is via
// grep on `plugin:notes|note_update` outside `src/notes/`.

export { createNote, noteCreate } from "./createNote";
export { noteExportAsMarkdown, noteExportAttachments } from "./exportNote";
export { vaultExportMarkdown, vaultExportCancel } from "./vaultExport";
export { noteRead } from "./readNote";
export { noteUpdate } from "./updateNote";
export {
  NOTE_FIELD_WRITE_EVENT,
  setNoteField,
} from "./setNoteField";
export type {
  NoteFieldWriteDetail,
  SetNoteFieldRequest,
  SetNoteFieldResult,
} from "./setNoteField";
export { deleteNote, noteDelete } from "./deleteNote";
export { noteList } from "./listNotes";
export {
  NOTE_TITLES_BATCH_CAP,
  loadNoteBatch,
  noteTitlesBatch,
} from "./loadNoteBatch";
export type { TitleRecord } from "./loadNoteBatch";
export {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_MS,
  saveNote,
} from "./saveNote";
export { renameNote } from "./renameNote";
export {
  createTemplate,
  convertNoteToTemplate,
  convertTemplateToNote,
  deleteTemplate,
  listTemplates,
} from "./templates";
export {
  buildRenderContext,
  extractTemplateBody,
  createNoteFromTemplate,
  singleDay,
  createBlankNamedNote,
} from "./newNoteFromTemplate";
export {
  resolvePeriodNote,
  periodRange,
  periodSettings,
  formatDailyDate,
  isoWeek,
  zonedNow,
  PERIODS,
  PERIOD_DEFAULTS,
  DEFAULT_DAILY_FOLDER,
  DEFAULT_DAILY_DATE_FORMAT,
  type DailyResolution,
  type Period,
  type PeriodRange,
  type PeriodSettings,
  type PeriodPrefs,
  type PeriodResolution,
} from "./dailyNote";
export { moveNote, bulkMoveNotes } from "./moveNote";
export type { BulkMoveResult } from "./moveNote";
export {
  planFolderDelete,
  persistFolderDelete,
  planFolderRenameBatch,
  renameFolder,
} from "./folderActions";
export { resolveWikilink } from "./resolveWikilink";
export type { ResolverNote, WikilinkResolution } from "./resolveWikilink";
export type {
  FolderDeletePlan,
  FolderRenameNote,
  FolderRenameBatchPlan,
  FolderRenameResult,
} from "./folderActions";
export {
  EMPTY_SIDEBAR_STATE,
  SidebarStateProvider,
  applyCacheUpdate,
  applyOptimisticCreate,
  applyOptimisticDelete,
  applyOptimisticRename,
  rollbackOptimisticCreate,
  rollbackOptimisticDelete,
  rollbackOptimisticRename,
  sortBatchIds,
  templateRecords,
  trashedCount,
  useSelectedNote,
} from "./sidebarState";
export type {
  DeleteSnapshot,
  NoteId,
  RenameSnapshot,
  SidebarState,
  UseSelectedNoteReturn,
} from "./sidebarState";
