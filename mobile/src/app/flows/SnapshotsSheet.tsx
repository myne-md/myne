// Per-note version history on the phone (mobile twin of
// `src/notes/components/SnapshotsPanel.tsx`) — the note's encrypted snapshots,
// the DIFF one of them against the current note or against the one before it, and
// an undoable restore. Reads through the shared `myne-core` snapshots plugin.
//
// # Why this is a rewrite, not a reskin
//
// The phone's first version listed timestamps and opened a PLAIN TEXT box. The
// desktop has shown a word-level diff since MYND-334, with a choice of what the
// diff is against, and it names the device a revision came from. Two clients
// showing "the same" version history and answering "what changed" differently is
// the defect this file closes (owner, 2026-11-10).
//
// # What is shared and what is not
//
// Shared: the diff RENDERER (`@myne/diff-view`), the diff COMPUTATION
// (`diffWithSegments` from `@myne/dialect`), the author-label rule
// (`@myne/identity-label`), and the copy (`notes.snapshots.*`, the desktop's own
// keys). Not shared: the shape. Desktop has the width for two panes; a phone gets
// one column and therefore two steps — the list, then the selected revision — which
// is the same idiom every other phone surface here uses.
//
// Colour discipline (`DESIGN.md` "The One Accent Rule") arrives with `DiffView`
// rather than being re-decided here: additions carry the accent, removals are a
// muted recess.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Banner, Button, Icon, Segmented, Sheet, Spinner } from "../../components";
import { snapshotList, snapshotPreview, snapshotRestore, type SnapshotMeta } from "../../lib/snapshots";
import { noteRead } from "../../lib/notes";
import { HAS_TAURI } from "../../lib/app-window";
import { formatBytes } from "../../lib/util";
import { formatRelativeTime } from "../../lib/relative-time";
import { identityLabelText, resolvedIdentityLabel } from "@myne/identity-label";
import { changedLineCount, diffWithSegments, type DiffLine } from "@myne/dialect";
import { DiffView } from "@myne/diff-view";
import { tappable } from "../a11y/tappable";

/** What the selected revision is diffed against (MYND-334, ported). */
type CompareBasis = "current" | "previous";

/**
 * The backend's `SnapshotError` kinds → this client's copy.
 *
 * Kept here rather than shared with the desktop's version, because that one
 * resolves its keys through the desktop `i18n` singleton; the table is the same
 * one, key for key, so a reader comparing the two clients sees one vocabulary.
 */
function errorMessage(err: unknown, t: TFunction): string {
  const kind = (err as { kind?: string } | null)?.kind;
  switch (kind) {
    case "VaultNotUnlocked":
      return t("notes.snapshots.errorVaultLocked");
    case "SnapshotNotFound":
      return t("notes.snapshots.errorNotFound");
    case "CannotDecrypt":
      return t("notes.snapshots.errorCannotDecrypt");
    case "Io":
      return t("notes.snapshots.errorIo");
    case "NotesDirNotADirectory":
      return t("notes.snapshots.errorStorageAccess");
    default:
      return t("notes.snapshots.errorGeneric");
  }
}

export function SnapshotsSheet({
  noteId,
  noteTitle,
  onClose,
  onRestored,
}: {
  noteId: string;
  /** The open note's title, for the header subtitle (display only). */
  noteTitle?: string | null;
  onClose: () => void;
  /** Called after a successful restore, so the shell re-reads the open body. */
  onRestored: () => void;
}) {
  const { t } = useTranslation();
  const [snaps, setSnaps] = useState<SnapshotMeta[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [current, setCurrent] = useState<string>("");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [basis, setBasis] = useState<string | null>(null);
  const [basisError, setBasisError] = useState<string | null>(null);
  const [compareAgainst, setCompareAgainst] = useState<CompareBasis>("current");
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!HAS_TAURI) {
      setSnaps([]);
      return;
    }
    setListError(null);
    void snapshotList(noteId)
      .then(setSnaps)
      .catch((err: unknown) => {
        setSnaps([]);
        setListError(errorMessage(err, t));
      });
  }, [noteId, t]);
  useEffect(() => load(), [load]);

  const openRevision = useCallback(
    async (uuid: string) => {
      setSelected(uuid);
      setPreview(null);
      setDetailError(null);
      setStatus(null);
      setConfirmRestore(false);
      setCompareAgainst("current");
      try {
        const [body, live] = await Promise.all([
          snapshotPreview(noteId, uuid),
          noteRead(noteId).catch(() => ""),
        ]);
        setPreview(body);
        setCurrent(live);
      } catch (err) {
        setDetailError(errorMessage(err, t));
      }
    },
    [noteId, t],
  );

  // The list is newest-first, so the revision the selected one was taken AFTER is
  // the NEXT entry, not the previous one. The oldest has none, and that is a state
  // the surface says out loud rather than rendering an empty diff.
  const previousUuid = useMemo(() => {
    if (selected === null || snaps === null) return null;
    const index = snaps.findIndex((s) => s.snapshot_uuid === selected);
    return index < 0 ? null : (snaps[index + 1]?.snapshot_uuid ?? null);
  }, [snaps, selected]);

  useEffect(() => {
    setBasis(null);
    setBasisError(null);
    if (compareAgainst !== "previous" || previousUuid === null || !HAS_TAURI) return;
    let cancelled = false;
    void snapshotPreview(noteId, previousUuid)
      .then((body) => {
        if (!cancelled) setBasis(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setBasisError(errorMessage(err, t));
      });
    return () => {
      cancelled = true;
    };
  }, [compareAgainst, noteId, previousUuid, t]);

  const diff: DiffLine[] | null = useMemo(() => {
    if (preview === null) return null;
    if (compareAgainst === "previous") {
      return basis === null ? null : diffWithSegments(basis, preview);
    }
    return diffWithSegments(preview, current);
  }, [preview, current, compareAgainst, basis]);

  async function restore(uuid: string) {
    setBusy(true);
    try {
      if (HAS_TAURI) await snapshotRestore(noteId, uuid);
      onRestored();
      setStatus(t("notes.snapshots.restoredStatus"));
      setConfirmRestore(false);
      setSelected(null);
      setPreview(null);
      load();
    } catch (err) {
      setDetailError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  const authorOf = (snap: SnapshotMeta): string => {
    const label = resolvedIdentityLabel(snap.resolved_author);
    return label === null ? t("notes.snapshots.unknownAuthor") : identityLabelText(label, t);
  };

  return (
    <Sheet
      onClose={onClose}
      style={{ maxHeight: "88%", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      {(close) => (
        <>
          <div
            style={{
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              paddingBottom: "var(--space-2)",
            }}
          >
            {selected === null ? (
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>
                  {t("notes.snapshots.title")}
                </span>
                {noteTitle ? (
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--fg-3)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {noteTitle}
                  </span>
                ) : null}
              </span>
            ) : (
              <Button
                variant="ghost"
                full={false}
                onClick={() => {
                  setSelected(null);
                  setPreview(null);
                  setDetailError(null);
                  setConfirmRestore(false);
                }}
                data-testid="snapshots.back"
                style={{ flex: 1, justifyContent: "flex-start", padding: 0, color: "var(--accent)" }}
              >
                <Icon name="arrow-left" size={16} color="var(--accent)" />
                {t("common.back")}
              </Button>
            )}
            <Button variant="ghost" full={false} onClick={close} data-testid="snapshots.done">
              {t("common.done")}
            </Button>
          </div>

          {status !== null ? (
            <div style={{ flex: "none", paddingBottom: "var(--space-2)" }}>
              <Banner kind="success">{status}</Banner>
            </div>
          ) : null}
          {listError !== null && selected === null ? (
            <div style={{ flex: "none", paddingBottom: "var(--space-2)" }}>
              <Banner kind="danger">{listError}</Banner>
            </div>
          ) : null}

          <div style={{ overflowY: "auto", minHeight: 0, flex: "1 1 auto" }}>
            {selected === null ? (
              snaps === null ? (
                <div style={{ display: "flex", justifyContent: "center", padding: 30 }}>
                  <Spinner />
                </div>
              ) : snaps.length === 0 ? (
                <div
                  data-testid="snapshots.empty"
                  style={{
                    textAlign: "center",
                    padding: "30px 20px",
                    color: "var(--fg-3)",
                    fontSize: 14,
                    lineHeight: 1.55,
                  }}
                >
                  {t("notes.snapshots.emptyState")}
                </div>
              ) : (
                <div role="list" aria-label={t("notes.snapshots.listLabel")}>
                  {snaps.map((snap, index) => (
                    <button
                      key={snap.snapshot_uuid}
                      type="button"
                      {...tappable({ onActivate: () => void openRevision(snap.snapshot_uuid) })}
                      data-testid="snapshots.row"
                      data-snapshot-id={snap.snapshot_uuid}
                      data-index={index}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--space-3)",
                        width: "100%",
                        minHeight: 56,
                        border: "none",
                        borderTop: index === 0 ? "none" : "1px solid var(--line-1)",
                        background: "transparent",
                        padding: "10px 0",
                        cursor: "pointer",
                        textAlign: "start",
                        fontFamily: "var(--font-sans)",
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ fontSize: 15, color: "var(--fg-1)" }}>
                          {formatRelativeTime(new Date(snap.captured_at_ms)) || t("common.justnow")}
                        </span>
                        <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                          {formatBytes(snap.size_bytes)}
                          {" · "}
                          <span data-testid="snapshots.author">{authorOf(snap)}</span>
                        </span>
                      </span>
                      <Icon name="chevron-right" size={16} color="var(--line-3)" flip />
                    </button>
                  ))}
                </div>
              )
            ) : (
              // One revision. The diff is the screen's reason to exist, so it takes
              // the space; the comparison choice sits above it because it changes
              // what the diff means.
              <div data-testid="snapshots.detail">
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                    {t("notes.snapshots.compareAgainstLabel")}
                  </span>
                  <Segmented
                    ariaLabel={t("notes.snapshots.compareAgainstLabel")}
                    options={[t("notes.snapshots.compareCurrent"), t("notes.snapshots.comparePrevious")]}
                    active={compareAgainst === "current" ? 0 : 1}
                    onChange={(index) => setCompareAgainst(index === 0 ? "current" : "previous")}
                    testIdPrefix="snapshots.compare-against"
                    optionValues={["current", "previous"]}
                  />
                </div>

                {detailError !== null ? (
                  <div style={{ marginTop: "var(--space-3)" }}>
                    <Banner kind="danger">{detailError}</Banner>
                  </div>
                ) : basisError !== null ? (
                  <div style={{ marginTop: "var(--space-3)" }}>
                    <Banner kind="danger">{basisError}</Banner>
                  </div>
                ) : compareAgainst === "previous" && previousUuid === null ? (
                  <p data-testid="snapshots.no-previous" style={{ margin: "var(--space-3) 0 0", fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
                    {t("notes.snapshots.noPrevious")}
                  </p>
                ) : preview === null ? (
                  <p style={{ margin: "var(--space-3) 0 0", fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
                    {t("notes.snapshots.decrypting")}
                  </p>
                ) : diff === null ? (
                  <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-4)" }}>
                    <Spinner />
                  </div>
                ) : (
                  <>
                    <p style={{ margin: "var(--space-3) 0 var(--space-2)", fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                      {t(
                        compareAgainst === "previous"
                          ? "notes.snapshots.changeCountPrev"
                          : "notes.snapshots.changeCount",
                        { count: changedLineCount(diff) },
                      )}
                    </p>
                    <div
                      data-testid="snapshots.diff"
                      style={{
                        maxHeight: 320,
                        overflowY: "auto",
                        background: "var(--bg-2)",
                        border: "1px solid var(--line-1)",
                        borderRadius: "var(--radius-2)",
                        padding: "var(--space-2)",
                        fontSize: "var(--text-sm)",
                      }}
                    >
                      <DiffView diff={diff} mode="unified" />
                    </div>
                  </>
                )}

                {confirmRestore ? (
                  <div
                    data-testid="snapshots.restore-confirm"
                    style={{ marginTop: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
                  >
                    <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-1)", fontWeight: 500 }}>
                      {t("notes.snapshots.confirmTitle")}
                    </p>
                    <p style={{ margin: 0, fontSize: "var(--text-sm)", lineHeight: 1.55, color: "var(--fg-2)" }}>
                      {t("notes.snapshots.confirmBody")}
                    </p>
                    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                      <Button
                        variant="secondary"
                        full={false}
                        onClick={() => setConfirmRestore(false)}
                        data-testid="snapshots.restore-cancel"
                      >
                        {t("common.cancel")}
                      </Button>
                      <Button
                        variant="danger"
                        full={false}
                        disabled={busy || selected === null}
                        onClick={() => selected !== null && void restore(selected)}
                        data-testid="snapshots.restore-confirm-cta"
                      >
                        {t("notes.snapshots.restoreCta")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={busy || selected === null || preview === null}
                    onClick={() => setConfirmRestore(true)}
                    style={{ marginTop: "var(--space-4)" }}
                    data-testid="snapshots.restore"
                  >
                    {t("notes.snapshots.restore")}
                  </Button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
