// Conflicts view (MYND-427 task 4) — the dedicated surface for sync conflict
// copies (the keep-both `conflict:` notes), grouped by the original they forked
// from (`conflict_of:`), with per-conflict reconcile actions. Kept out of the
// main feed (sidebarState `liveCache` excludes `conflict` records); reached via a
// count-badge entry point. Penpot skipped per the owner directive; built against
// design tokens. Mirrors the Trash/Templates panel shape.

import type { CSSProperties } from "react";
import type { TitleRecord } from "../loadNoteBatch";

const ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const GROUP: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3)",
};

const GROUP_TITLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
};

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};

const ACTIONS: CSSProperties = { display: "flex", gap: "var(--space-1)" };

const BTN: CSSProperties = {
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-sm)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
  color: "var(--fg-1)",
};

const EMPTY: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
  padding: "var(--space-5)",
  textAlign: "center",
};

export interface ConflictsViewProps {
  /** Conflict copies grouped by original UUID (`conflictRecordsByOriginal`). */
  groups: Map<string, TitleRecord[]>;
  /** Keep the conflict copy as a separate note (clears its `conflict:` markers). */
  onKeepBoth: (copyId: string) => void;
  /** Discard the conflict copy (the user kept the other side). */
  onDiscard: (copyId: string) => void;
}

function displayTitle(r: TitleRecord): string {
  return r.title && r.title.length > 0 ? r.title : `Untitled (${r.noteUuid.slice(0, 6)})`;
}

export function ConflictsView({ groups, onKeepBoth, onDiscard }: ConflictsViewProps) {
  if (groups.size === 0) {
    return (
      <div style={EMPTY} data-testid="conflicts.empty">
        No conflicts — your devices are in sync.
      </div>
    );
  }
  return (
    <div style={ROOT} data-testid="conflicts.view">
      {[...groups.entries()].map(([originalUuid, copies]) => (
        <div key={originalUuid} style={GROUP} data-testid="conflicts.group" data-conflict-of={originalUuid}>
          <div style={GROUP_TITLE}>
            {copies.length === 1
              ? "1 conflicting copy"
              : `${copies.length} conflicting copies`}{" "}
            of {originalUuid.slice(0, 8)}
          </div>
          {copies.map((c) => (
            <div key={c.noteUuid} style={ROW} data-testid="conflicts.copy" data-note-id={c.noteUuid}>
              <span>{displayTitle(c)}</span>
              <div style={ACTIONS}>
                <button
                  type="button"
                  style={BTN}
                  onClick={() => onKeepBoth(c.noteUuid)}
                  data-testid="conflicts.keep-both"
                >
                  Keep as separate
                </button>
                <button
                  type="button"
                  style={BTN}
                  onClick={() => onDiscard(c.noteUuid)}
                  data-testid="conflicts.discard"
                >
                  Discard
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
