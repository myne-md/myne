// Links tab body (right-panel tabs) — two sections under the `backlinks` tab
// ID: "linked from" (incoming, extracted verbatim from the former
// single-purpose RightSidebar) and "links to" (outgoing, MYND-604 task 1).
// Both recompute from the SYNC-5 indices on every index-nonce bump with the
// reference-equality bail (SYNC-5 condition 2). Incoming testids preserved
// exactly (`editor.backlink-row`, `data-source-id`,
// `editor.backlink-archived-badge`) so the existing backlinks E2E keeps
// resolving; outgoing rows carry their own new testids
// (`editor.outgoing-link-row`, `data-target-id`).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/primitives/Icon";
import {
  backlinkRows,
  backlinkRowsEqual,
  outgoingLinkRows,
  outgoingLinkRowsEqual,
  type BacklinkRow,
  type OutgoingLinkRow,
} from "../backlinkRows";
import { useIndexNonce } from "../indexNonce";
import { useSelectedNote } from "../sidebarState";
import { backlinks, forward } from "../vaultIndices";
import { useResolverNotes } from "../resolverNotes";
import { SECTION_HEADING_STYLE, SIDEBAR_CARD_STYLE } from "./sharedStyles";

export function BacklinksTab() {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const notes = useResolverNotes();
  const indexNonce = useIndexNonce();
  const [rows, setRows] = useState<BacklinkRow[]>([]);
  const [outgoingRows, setOutgoingRows] = useState<OutgoingLinkRow[]>([]);

  useEffect(() => {
    const noteId = ctx.selectedId;
    if (noteId === null) {
      setRows((prev) => (prev.length === 0 ? prev : []));
      setOutgoingRows((prev) => (prev.length === 0 ? prev : []));
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
    // Outgoing direction reuses the same per-note forward() query the local
    // graph already calls (no new backend surface) — a separate IPC from
    // backlinks() above, so one direction's failure doesn't blank the other.
    void forward(noteId, notes).then(
      (links) => {
        if (cancelled) return;
        const next = outgoingLinkRows(links, notes, noteId);
        setOutgoingRows((prev) => (outgoingLinkRowsEqual(prev, next) ? prev : next));
      },
      () => {
        if (!cancelled) setOutgoingRows((prev) => (prev.length === 0 ? prev : []));
      },
    );
    return () => {
      cancelled = true;
    };
    // `indexNonce` re-runs the cheap (decrypt-free) re-query on every vault
    // index mutation (SYNC-5); the reference-equal bails above guard renders.
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

      <div style={{ ...SECTION_HEADING_STYLE, marginTop: 16 }}>
        {t("editor.chrome.backlinks.linksTo", { count: outgoingRows.length })}
      </div>
      {outgoingRows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4 }}>
          {t("editor.chrome.backlinks.outgoingEmpty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {outgoingRows.map((row) => (
            <button
              key={row.targetUuid}
              type="button"
              data-testid="editor.outgoing-link-row"
              data-target-id={row.targetUuid}
              onClick={() => void ctx.open(row.targetUuid)}
              style={SIDEBAR_CARD_STYLE}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-1)" }}>
                {row.targetTitle ?? t("editor.chrome.backlinks.untitled")}
              </span>
              {row.count > 1 && (
                <span style={{ fontSize: 12, color: "var(--fg-3)", marginLeft: 6 }}>
                  ({row.count})
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
