// Conflicts view (MYND-427 task 4) — the dedicated surface for sync conflict
// copies (the keep-both `conflict:` notes), grouped by the original they forked
// from (`conflict_of:`), with per-conflict reconcile actions. Kept out of the
// main feed (sidebarState `liveCache` excludes `conflict` records); reached via a
// count-badge entry point. Penpot skipped per the owner directive; built against
// design tokens. Mirrors the Trash/Templates panel shape.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import type { DiffLine } from "../../dialect";
import type { TitleRecord } from "../loadNoteBatch";
import { UNKNOWN_CONFLICT_ORIGINAL } from "../sidebarState";
import { DiffView } from "./DiffView";
import { Button } from "../../components/primitives/Button";
import { EmptyState } from "../../components/primitives/EmptyState";

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

// The reconcile actions read as ONE calm cluster, not four equal boxes: a filled
// primary ("Use this version"), an outlined secondary ("Keep as separate"), and
// two low-emphasis ghost actions ("Compare" to inspect, "Discard" in danger
// tone). `flex-wrap` lets the cluster drop to a second line on a narrow panel
// rather than overflow. (MYND-427 / #203 — was four identical flat buttons.)
const ACTIONS: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
};

// Ghost + danger tone for the one destructive action, so it stays low-emphasis
// (not a filled red button) but still reads as "this removes something".
const DISCARD_BTN: CSSProperties = { color: "var(--danger)" };

// --- compare surface ---------------------------------------------------------

const COMPARE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3)",
};

const COMPARE_HEAD: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

const COMPARE_TITLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// The diff pane. Bounded so a long note scrolls inside the compare surface
// instead of pushing the decision buttons off the bottom of the panel.
const COMPARE_BODY: CSSProperties = {
  display: "flex",
  maxHeight: 360,
  minHeight: 120,
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  background: "var(--bg-1)",
  overflow: "hidden",
};

const COMPARE_NOTE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  padding: "var(--space-5)",
  textAlign: "center",
  margin: "auto",
};

/**
 * The comparison currently open in the surface, as the host resolved it.
 *
 * The view never reads a note itself — bodies come from the host already
 * decrypted and normalized (`normalizeConflictPair`), so this stays a pure
 * component and the compare surface cannot become a second IO path.
 */
export type ConflictCompare =
  | { status: "loading"; copyId: string; originalUuid: string }
  | { status: "ready"; copyId: string; originalUuid: string; diff: DiffLine[] }
  /** No original to diff against (`UNKNOWN_CONFLICT_ORIGINAL`) — the copy alone. */
  | { status: "orphan"; copyId: string; originalUuid: string; copyText: string }
  | { status: "error"; copyId: string; originalUuid: string };

export interface ConflictsViewProps {
  /** Conflict copies grouped by original UUID (`conflictRecordsByOriginal`). */
  groups: Map<string, TitleRecord[]>;
  /** Keep the conflict copy as a separate note (clears its `conflict:` markers). */
  onKeepBoth: (copyId: string) => void;
  /** Discard the conflict copy (the user kept the other side). */
  onDiscard: (copyId: string) => void;
  /** "Use this version" (take theirs): promote this remote copy to the surviving
   *  note and send the local original (`originalUuid`) to trash (MYND-452). */
  onTakeTheirs: (copyId: string, originalUuid: string) => void;
  /** Open the compare surface for one copy. Absent → no Compare affordance. */
  onCompare?: (copyId: string, originalUuid: string) => void;
  /** The open comparison, if any. It takes over the surface while open. */
  compare?: ConflictCompare | null;
  /** Leave the compare surface and go back to the grouped list. */
  onCloseCompare?: () => void;
}

function displayTitle(r: TitleRecord): string {
  return r.title && r.title.length > 0
    ? r.title
    : i18n.t("sync.conflicts.untitled", { hex: r.noteUuid.slice(0, 6) });
}

/** Find a copy record across the groups — the compare surface knows only ids. */
function findCopy(
  groups: Map<string, TitleRecord[]>,
  copyId: string,
): TitleRecord | undefined {
  for (const copies of groups.values()) {
    const hit = copies.find((c) => c.noteUuid === copyId);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** An unpaired body rendered through the one diff renderer: every line `same`. */
function asUnchangedLines(text: string): DiffLine[] {
  return text.split("\n").map((line): DiffLine => ({ type: "same", text: line }));
}

/**
 * The three reconcile actions, rendered identically in the list row and in the
 * compare surface — the decision lives wherever the user is looking, and it is
 * the same decision, wired to the same MYND-452 handlers.
 */
function ConflictActions({
  copyId,
  originalUuid,
  onKeepBoth,
  onDiscard,
  onTakeTheirs,
}: {
  copyId: string;
  originalUuid: string;
  onKeepBoth: (copyId: string) => void;
  onDiscard: (copyId: string) => void;
  onTakeTheirs: (copyId: string, originalUuid: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        style={DISCARD_BTN}
        onClick={() => onDiscard(copyId)}
        data-testid="conflicts.discard"
      >
        {t("sync.conflicts.discard")}
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={() => onKeepBoth(copyId)}
        data-testid="conflicts.keep-both"
      >
        {t("sync.conflicts.keepAsSeparate")}
      </Button>
      {originalUuid !== UNKNOWN_CONFLICT_ORIGINAL && (
        <Button
          type="button"
          variant="primary"
          onClick={() => onTakeTheirs(copyId, originalUuid)}
          data-testid="conflicts.take-this"
        >
          {t("sync.conflicts.useThisVersion")}
        </Button>
      )}
    </>
  );
}

function CompareSurface({
  compare,
  groups,
  onKeepBoth,
  onDiscard,
  onTakeTheirs,
  onCloseCompare,
}: {
  compare: ConflictCompare;
  groups: Map<string, TitleRecord[]>;
  onKeepBoth: (copyId: string) => void;
  onDiscard: (copyId: string) => void;
  onTakeTheirs: (copyId: string, originalUuid: string) => void;
  onCloseCompare?: () => void;
}) {
  const { t } = useTranslation();
  const record = findCopy(groups, compare.copyId);
  const title =
    record !== undefined
      ? displayTitle(record)
      : i18n.t("sync.conflicts.untitled", { hex: compare.copyId.slice(0, 6) });

  return (
    <div style={COMPARE} data-testid="conflicts.compare-view" data-note-id={compare.copyId}>
      <div style={COMPARE_HEAD}>
        <span style={COMPARE_TITLE}>
          {t("sync.conflicts.compareTitle", { title })}
        </span>
        {onCloseCompare !== undefined && (
          <Button
            type="button"
            variant="ghost"
            onClick={onCloseCompare}
            data-testid="conflicts.compare-close"
          >
            {t("sync.conflicts.compareClose")}
          </Button>
        )}
      </div>

      <div style={COMPARE_BODY}>
        {compare.status === "loading" && (
          <p style={COMPARE_NOTE} data-testid="conflicts.compare-loading">
            {t("sync.conflicts.compareLoading")}
          </p>
        )}
        {compare.status === "error" && (
          <p style={COMPARE_NOTE} data-testid="conflicts.compare-error">
            {t("sync.conflicts.compareError")}
          </p>
        )}
        {compare.status === "orphan" && (
          <DiffView
            diff={asUnchangedLines(compare.copyText)}
            mode="unified"
            label={t("sync.conflicts.compareOrphan")}
          />
        )}
        {compare.status === "ready" &&
          (compare.diff.every((d) => d.type === "same") ? (
            <p style={COMPARE_NOTE} data-testid="conflicts.compare-identical">
              {t("sync.conflicts.compareIdentical")}
            </p>
          ) : (
            <DiffView
              diff={compare.diff}
              mode="split"
              leftLabel={t("sync.conflicts.compareMine")}
              rightLabel={t("sync.conflicts.compareTheirs")}
            />
          ))}
      </div>

      {compare.status === "orphan" && (
        <p style={{ ...COMPARE_NOTE, margin: 0, padding: 0, textAlign: "start" }}>
          {t("sync.conflicts.compareOrphan")}
        </p>
      )}

      <div style={ACTIONS}>
        <ConflictActions
          copyId={compare.copyId}
          originalUuid={compare.originalUuid}
          onKeepBoth={onKeepBoth}
          onDiscard={onDiscard}
          onTakeTheirs={onTakeTheirs}
        />
      </div>
    </div>
  );
}

export function ConflictsView({
  groups,
  onKeepBoth,
  onDiscard,
  onTakeTheirs,
  onCompare,
  compare,
  onCloseCompare,
}: ConflictsViewProps) {
  const { t } = useTranslation();
  // The comparison takes over the surface: the diff and the decision belong
  // together, and the grouped list behind it is not what the user is reading.
  if (compare !== null && compare !== undefined) {
    return (
      <CompareSurface
        compare={compare}
        groups={groups}
        onKeepBoth={onKeepBoth}
        onDiscard={onDiscard}
        onTakeTheirs={onTakeTheirs}
        onCloseCompare={onCloseCompare}
      />
    );
  }
  if (groups.size === 0) {
    return (
      <EmptyState
        variant="firstRun"
        icon="circle-check"
        size="sm"
        title={t("sync.conflicts.emptyTitle")}
        body={t("sync.conflicts.empty")}
        testId="conflicts.empty"
      />
    );
  }
  return (
    <div style={ROOT} data-testid="conflicts.view">
      {[...groups.entries()].map(([originalUuid, copies]) => (
        <div key={originalUuid} style={GROUP} data-testid="conflicts.group" data-conflict-of={originalUuid}>
          <div style={GROUP_TITLE}>
            {t("sync.conflicts.groupTitle", {
              count: copies.length,
              original: originalUuid.slice(0, 8),
            })}
          </div>
          {copies.map((c) => (
            <div key={c.noteUuid} style={ROW} data-testid="conflicts.copy" data-note-id={c.noteUuid}>
              <span>{displayTitle(c)}</span>
              <div style={ACTIONS}>
                {onCompare !== undefined && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onCompare(c.noteUuid, originalUuid)}
                    data-testid="conflicts.compare"
                  >
                    {t("sync.conflicts.compare")}
                  </Button>
                )}
                <ConflictActions
                  copyId={c.noteUuid}
                  originalUuid={originalUuid}
                  onKeepBoth={onKeepBoth}
                  onDiscard={onDiscard}
                  onTakeTheirs={onTakeTheirs}
                />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
