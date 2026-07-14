// Conflicts view (MYND-461 / SYNC-11) — the dedicated surface for sync conflict
// copies (the keep-both `conflict:` notes), grouped by the original they forked
// from (`conflict_of:`), with per-conflict reconcile actions. Kept OUT of the
// live feed (dialect §3.6.1 feed-exclusion). Ports the desktop `ConflictsView`
// 1:1 (same three actions, same testid naming). Presentation only — the data
// loading + orchestrator wiring live in the container (src/lib/conflictCopy.ts +
// the sheet host). Direct-to-code; mobile has no i18n → plain strings; titles
// only (no device attribution — SYNC-11 has no such field).

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

/** A conflict-copy row: the note id + its display title (no wall-clock / device). */
export interface ConflictCopyRow {
  noteId: string;
  title: string;
}

const ROOT: CSSProperties = { display: "flex", flexDirection: "column", gap: 16 };
const GROUP: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: 12,
};
const GROUP_TITLE: CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--fg-2)" };
const ROW: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  paddingTop: 8,
  borderTop: "1px solid var(--line-1)",
};
const ROW_TITLE: CSSProperties = { fontSize: 15, fontWeight: 600, color: "var(--fg-1)" };
const ACTIONS: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap" };
const BTN: CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  fontWeight: 600,
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1, 8px)",
  color: "var(--fg-1)",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
};
const EMPTY: CSSProperties = { color: "var(--fg-3)", fontSize: 14, padding: 32, textAlign: "center" };

// Groups whose original UUID could not be resolved hide "Use this version"
// (there is no original to trash). Mirrors the desktop `UNKNOWN_CONFLICT_ORIGINAL`.
export const UNKNOWN_CONFLICT_ORIGINAL = "";

export interface ConflictsViewProps {
  /** Conflict copies grouped by original UUID (`conflict_of:`). */
  groups: Map<string, ConflictCopyRow[]>;
  /** Keep the copy as a separate note (clears its `conflict:` markers). */
  onKeepBoth: (copyId: string) => void;
  /** Discard the copy (the user kept the other side). */
  onDiscard: (copyId: string) => void;
  /** "Use this version" (take theirs): promote this copy, tombstone the original. */
  onTakeTheirs: (copyId: string, originalUuid: string) => void;
}

export function ConflictsView({ groups, onKeepBoth, onDiscard, onTakeTheirs }: ConflictsViewProps) {
  const { t } = useTranslation();
  if (groups.size === 0) {
    return (
      <div style={EMPTY} data-testid="conflicts.empty">
        {t("conflicts.empty")}
      </div>
    );
  }
  return (
    <div style={ROOT} data-testid="conflicts.view">
      {[...groups.entries()].map(([originalUuid, copies]) => (
        <div key={originalUuid || "unknown"} style={GROUP} data-testid="conflicts.group" data-conflict-of={originalUuid}>
          <div style={GROUP_TITLE}>
            {t("conflicts.groupTitle", { count: copies.length })}
            {originalUuid ? t("conflicts.groupTitleOfNote", { hex: originalUuid.slice(0, 8) }) : ""}
          </div>
          {copies.map((c) => (
            <div key={c.noteId} style={ROW} data-testid="conflicts.copy" data-note-id={c.noteId}>
              <span style={ROW_TITLE}>{c.title || t("sync.conflicts.untitled", { hex: c.noteId.slice(0, 6) })}</span>
              <div style={ACTIONS}>
                <button type="button" style={BTN} onClick={() => onKeepBoth(c.noteId)} data-testid="conflicts.keep-both">
                  {t("sync.conflicts.keepAsSeparate")}
                </button>
                <button type="button" style={BTN} onClick={() => onDiscard(c.noteId)} data-testid="sync.conflicts.discard">
                  {t("sync.conflicts.discard")}
                </button>
                {originalUuid !== UNKNOWN_CONFLICT_ORIGINAL && (
                  <button
                    type="button"
                    style={BTN}
                    onClick={() => onTakeTheirs(c.noteId, originalUuid)}
                    data-testid="conflicts.take-this"
                  >
                    {t("sync.conflicts.useThisVersion")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
