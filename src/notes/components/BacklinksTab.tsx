// Backlinks tab body (right-panel tabs) — extracted verbatim from the former
// single-purpose RightSidebar. Lists the notes that link to the focused note,
// recomputed from the SYNC-5 backlinks index on every index-nonce bump with the
// reference-equality bail (SYNC-5 condition 2). Testids preserved exactly
// (`editor.backlink-row`, `data-source-id`, `editor.backlink-archived-badge`) so
// the existing backlinks E2E keeps resolving once this tab is active.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/primitives/Icon";
import { backlinkRows, backlinkRowsEqual, type BacklinkRow } from "../backlinkRows";
import { useIndexNonce } from "../indexNonce";
import { useSelectedNote } from "../sidebarState";
import { backlinks } from "../vaultIndices";
import { useResolverNotes } from "../resolverNotes";
import { SECTION_HEADING_STYLE, SIDEBAR_CARD_STYLE } from "./sharedStyles";

export function BacklinksTab() {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const notes = useResolverNotes();
  const indexNonce = useIndexNonce();
  const [rows, setRows] = useState<BacklinkRow[]>([]);

  useEffect(() => {
    const noteId = ctx.selectedId;
    if (noteId === null) {
      setRows((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    let cancelled = false;
    void backlinks(noteId, notes).then(
      (groups) => {
        if (cancelled) return;
        const next = backlinkRows(groups, noteId);
        // SYNC-5 condition 2: keep the previous reference when the result is
        // unchanged, so a no-op re-query (e.g. a vault-wide reindex burst)
        // bails the React render.
        setRows((prev) => (backlinkRowsEqual(prev, next) ? prev : next));
      },
      () => {
        // Best-effort — a transient query failure shows the empty state.
        if (!cancelled) setRows((prev) => (prev.length === 0 ? prev : []));
      },
    );
    return () => {
      cancelled = true;
    };
    // `indexNonce` re-runs the cheap (decrypt-free) re-query on every vault
    // index mutation (SYNC-5); the reference-equal bail above guards renders.
  }, [ctx.selectedId, notes, indexNonce]);

  return (
    <>
      <div style={SECTION_HEADING_STYLE}>
        {t("editor.chrome.backlinks.linkedFrom", { count: rows.length })}
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4 }}>
          {t("editor.chrome.backlinks.empty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((row) => (
            <button
              key={row.sourceUuid}
              type="button"
              data-testid="editor.backlink-row"
              data-source-id={row.sourceUuid}
              onClick={() => void ctx.open(row.sourceUuid)}
              style={SIDEBAR_CARD_STYLE}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-1)" }}>
                {row.sourceTitle ?? t("editor.chrome.backlinks.untitled")}
              </span>
              {row.count > 1 && (
                <span style={{ fontSize: 12, color: "var(--fg-3)", marginLeft: 6 }}>
                  ({row.count})
                </span>
              )}
              {/* Archived source (MYND-331): a backlink from an archived note
                  still resolves (archive ≠ soft-trash) — a small badge tells the
                  user the source lives in the Archive, not the working tree. */}
              {ctx.cache.get(row.sourceUuid)?.archived != null && (
                <span
                  data-testid="editor.backlink-archived-badge"
                  title={t("editor.chrome.backlinks.archivedBadge")}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    marginLeft: 6,
                    color: "var(--fg-3)",
                  }}
                >
                  <Icon name="archive" size={12} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
