// Pure logic for the whole-vault export modal (MYND-211 task 3):
// the three-phase state machine (setup → running → summary), destination
// composition, scope handling, and the summary/progress formatting.
// `VaultExportModal.tsx` is a thin renderer over this module — every
// decision here is Vitest-covered (`tests/notes/vaultExportFlow.test.ts`).
//
// Destination contract (engine, `src/notes/vaultExport.ts`): the path
// passed to `vault_export_markdown` is the NEW tree directory itself and
// must not exist yet. The OS folder dialog hands us a PARENT directory;
// the modal composes `<picked>/<default tree name>` and shows the
// composed path in the recessed display, so what the user reads is
// exactly what the engine will create. The default tree name mirrors the
// backup engine's naming rule (`default_backup_filename`): product name +
// local date, NEVER the vault label (the label is encrypted-only,
// DENY-list discipline) — and the datestamp keeps repeated exports from
// tripping `DestinationAlreadyExists`.

import { deriveFolderTree, type FolderNode } from "../../notes/folderTree";
import { vaultExportErrorMessage } from "../../lib/vault-export-errors";
import { EXPORT_FALLBACK_MESSAGE } from "../../lib/note-export-errors";
import type {
  VaultExportError,
  VaultExportProgress,
  VaultExportSummary,
} from "../../types/vault-export-error";

// ---- destination ---------------------------------------------------------

/**
 * Default name of the new tree directory: `Myne export <YYYY-MM-DD HHMM>`
 * in the user's LOCAL time — the vault-tree sibling of the backup
 * engine's `default_backup_filename` rule (product name + local date,
 * never the vault label).
 */
export function defaultExportTreeName(now: Date = new Date()): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return (
    `Myne export ${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}` +
    `-${pad(now.getDate(), 2)} ${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}`
  );
}

/**
 * Compose the engine destination (the NEW tree directory) from the
 * dialog-picked parent + the tree name. Separator follows the picked
 * path's own convention (`\` only when the path is Windows-shaped), so
 * the composed path stays native without an IPC round trip.
 */
export function composeDestination(pickedDir: string, treeName: string): string {
  const sep = pickedDir.includes("\\") && !pickedDir.includes("/") ? "\\" : "/";
  const base = pickedDir.endsWith(sep) ? pickedDir : pickedDir + sep;
  return base + treeName;
}

// ---- scope ---------------------------------------------------------------

/** Scope selection: whole vault, or one folder subtree (canonical
 *  trailing-slash path; `null` until the user picks one). */
export type VaultExportScope =
  | { kind: "whole" }
  | { kind: "folder"; folder: string | null };

/** The `scope` argument `vault_export_markdown` expects. */
export function scopeArg(scope: VaultExportScope): string | null {
  return scope.kind === "folder" ? scope.folder : null;
}

/**
 * Flatten the sidebar's derived folder tree into the scope dropdown's
 * option list (canonical trailing-slash paths, depth-first in the tree's
 * own folded-name order). Same source the sidebar renders from
 * (`deriveFolderTree`); trashed notes are excluded by the caller's
 * filter. Deliberate-empty-only folders are not offered — an empty
 * subtree exports nothing, so offering it would be noise, not honesty.
 */
export function collectFolderOptions(
  records: Iterable<{ noteUuid: string; folder: string | null; trashed: string | null }>,
): string[] {
  const live: { noteUuid: string; folder: string | null }[] = [];
  for (const r of records) {
    if (r.trashed === null) live.push({ noteUuid: r.noteUuid, folder: r.folder });
  }
  const tree = deriveFolderTree(live, []);
  const out: string[] = [];
  const walk = (nodes: readonly FolderNode[]) => {
    for (const n of nodes) {
      out.push(n.path);
      walk(n.children);
    }
  };
  walk(tree.roots);
  return out;
}

// ---- phase state machine ---------------------------------------------------

export interface VaultExportSetupState {
  phase: "setup";
  /** Parent directory from the OS folder dialog, or null. */
  pickedDir: string | null;
  /** Name of the new tree directory under `pickedDir`. */
  treeName: string;
  scope: VaultExportScope;
  /** Mapped copy from the last failed run (inline error line), or null. */
  error: string | null;
}

export type VaultExportModalState =
  | VaultExportSetupState
  | {
      phase: "running";
      /** Composed engine destination (the new tree directory). */
      destination: string;
      progress: VaultExportProgress | null;
      /** Cancel requested; the engine settles with `Cancelled` shortly. */
      cancelling: boolean;
      // Setup fields carried through so cancel/failure restores them.
      pickedDir: string;
      treeName: string;
      scope: VaultExportScope;
    }
  | {
      phase: "summary";
      /** Published tree directory ("Show in folder" reveals it). */
      destination: string;
      summary: VaultExportSummary;
    };

export type VaultExportModalEvent =
  | { type: "reset"; treeName: string }
  | { type: "pick-dir"; dir: string }
  | { type: "scope-whole" }
  | { type: "scope-folder" }
  | { type: "scope-folder-path"; folder: string }
  /** `destination` is the composed engine path, computed ONCE by the
   *  component (`composedDestination`) and carried here so the reducer
   *  never re-derives it. */
  | { type: "start"; destination: string }
  | { type: "progress"; progress: VaultExportProgress }
  | { type: "cancel-requested" }
  | { type: "failed"; error: VaultExportError }
  | { type: "succeeded"; summary: VaultExportSummary };

export function initialVaultExportState(
  treeName: string = defaultExportTreeName(),
): VaultExportSetupState {
  return {
    phase: "setup",
    pickedDir: null,
    treeName,
    scope: { kind: "whole" },
    error: null,
  };
}

/** Composed destination shown in the recessed display + passed to the
 *  engine (setup phase only — running/summary carry `state.destination`
 *  directly); null until a parent directory has been picked. */
export function composedDestination(
  state: VaultExportSetupState,
): string | null {
  if (state.pickedDir === null) return null;
  return composeDestination(state.pickedDir, state.treeName);
}

/** The primary "Export…" gate: a destination is picked, and a folder
 *  scope (if selected) actually names a folder. */
export function canStart(state: VaultExportModalState): boolean {
  return (
    state.phase === "setup" &&
    state.pickedDir !== null &&
    (state.scope.kind === "whole" || state.scope.folder !== null)
  );
}

/**
 * The reducer. Events that do not apply to the current phase return the
 * state unchanged (same reference) — a late progress event after
 * settlement, a double-click, etc. are all inert by construction.
 *
 * Cancel path: the component fires `vault_export_cancel`; the in-flight
 * invoke then rejects with `Cancelled`, which lands here as `failed` and
 * returns to setup QUIETLY (no error line, picked destination + scope
 * preserved) — the staging tree was discarded, nothing reached the
 * destination, and the user is back exactly where they started.
 */
export function vaultExportReducer(
  state: VaultExportModalState,
  event: VaultExportModalEvent,
): VaultExportModalState {
  switch (event.type) {
    case "reset":
      return initialVaultExportState(event.treeName);
    case "pick-dir":
      if (state.phase !== "setup") return state;
      return { ...state, pickedDir: event.dir, error: null };
    case "scope-whole":
      if (state.phase !== "setup") return state;
      return { ...state, scope: { kind: "whole" }, error: null };
    case "scope-folder":
      if (state.phase !== "setup") return state;
      if (state.scope.kind === "folder") return state;
      return { ...state, scope: { kind: "folder", folder: null }, error: null };
    case "scope-folder-path":
      if (state.phase !== "setup") return state;
      return {
        ...state,
        scope: { kind: "folder", folder: event.folder },
        error: null,
      };
    case "start": {
      // `canStart` is the one gate (the component checks it before
      // dispatching too — same predicate, not a second derivation); the
      // pickedDir null-check only narrows for TS.
      if (!canStart(state) || state.phase !== "setup") return state;
      if (state.pickedDir === null) return state;
      return {
        phase: "running",
        destination: event.destination,
        progress: null,
        cancelling: false,
        pickedDir: state.pickedDir,
        treeName: state.treeName,
        scope: state.scope,
      };
    }
    case "progress":
      if (state.phase !== "running") return state;
      return { ...state, progress: event.progress };
    case "cancel-requested":
      if (state.phase !== "running" || state.cancelling) return state;
      return { ...state, cancelling: true };
    case "failed": {
      if (state.phase !== "running") return state;
      return {
        phase: "setup",
        pickedDir: state.pickedDir,
        treeName: state.treeName,
        scope: state.scope,
        // Cancel is the user's own deliberate exit — quiet return, no
        // error line. Everything else maps to plain copy. The `?.` keeps
        // a null/undefined out-of-contract rejection on the fallback
        // line instead of throwing (never-throws contract).
        error:
          event.error?.kind === "Cancelled"
            ? null
            : vaultExportErrorMessage(event.error) ?? EXPORT_FALLBACK_MESSAGE,
      };
    }
    case "succeeded":
      if (state.phase !== "running") return state;
      return {
        phase: "summary",
        destination: state.destination,
        summary: event.summary,
      };
  }
}

// ---- formatting ------------------------------------------------------------

/** Mono counts line of the running phase: `"42 / 128 notes"` /
 *  `"3 / 14 attachments"`; `"Preparing…"` before the first event. */
export function formatRunningCounts(p: VaultExportProgress | null): string {
  if (p === null || p.total === 0) return "Preparing…";
  return `${p.done} / ${p.total} ${p.phase}`;
}

/** Fill fraction (0..1) of the thin progress bar. */
export function progressFraction(p: VaultExportProgress | null): number {
  if (p === null || p.total === 0) return 0;
  return Math.min(1, p.done / p.total);
}

/** Summary counts line: `"128 notes · 14 attachments · 9 folders"`. */
export function formatSummaryCounts(s: VaultExportSummary): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [
    unit(s.notes, "note"),
    unit(s.attachments, "attachment"),
    unit(s.folders, "folder"),
  ].join(" · ");
}

/**
 * Muted exclusions line under the counts panel, or null when nothing was
 * excluded (the line disappears rather than reporting zeros — the
 * importer's transparency-line precedent).
 */
export function formatExclusionsLine(s: VaultExportSummary): string | null {
  if (s.excluded_trashed > 0) {
    const noun = s.excluded_trashed === 1 ? "trashed note" : "trashed notes";
    // The "version history" clause appears only when snapshots actually
    // existed and were excluded — honesty copy never over-claims.
    return s.excluded_snapshots > 0
      ? `${s.excluded_trashed} ${noun} and version history not included.`
      : `${s.excluded_trashed} ${noun} not included.`;
  }
  if (s.excluded_snapshots > 0) return "Version history not included.";
  return null;
}
