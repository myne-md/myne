// Pick documents for an agent run (myne-md/myne#913).
//
// **A picker, not a scope tree.** The scope control already answers "which
// notes may this run touch", and it is a permission. An attachment is not one:
// the agent reads it, never writes it, and it is not in the vault's tree of
// notes at all. Burying it in the scope menu would say the two are the same kind
// of thing, which is exactly the confusion this surface exists to avoid.
//
// The list is the vault's attachment library, read fresh on every open: the
// catalog moves while the panel is mounted (another pane imports a file, sync
// brings one down), and a cached list would offer a file that no longer exists.
//
// Only the rows the user picked leave here. Reading the chosen files' text is
// the CALLER's job, because it is a vault read that can fail per file, and the
// composer is where a failure has somewhere to be said.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/primitives/ModalShell";
import { Button } from "../../components/primitives/Button";
import { Spinner } from "../../components/Spinner";
import { catalogList, type CatalogEntry } from "../../lib/attachments";
import { AttachmentThumbnail } from "../../components/attachments/AttachmentThumbnail";
import { CAPTION_STYLE } from "./sharedStyles";

/** The most documents one run may carry. Mirrors `MAX_DOCUMENTS` in
 *  `core/src/plugins/agent/prompt.rs`, which is the authority: the host drops a
 *  fifth whatever this surface offers. */
export const MAX_RUN_ATTACHMENTS = 4;

export interface AttachmentPickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the rows the user confirmed. */
  onPick: (entries: readonly CatalogEntry[]) => void;
  /** Ids already attached to this run, so reopening shows the current choice as
   *  the choice rather than as a fresh list. */
  selectedIds?: readonly string[];
  /** Where the rows come from. Defaults to the vault's attachment library; a
   *  test or a story supplies its own so neither needs a vault to render. */
  load?: () => Promise<CatalogEntry[]>;
}

export function AttachmentPickerDialog({
  open,
  onClose,
  onPick,
  selectedIds = [],
  load = catalogList,
}: AttachmentPickerDialogProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<CatalogEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(selectedIds));

  // Re-read on every open, and reset the selection to what the run already has.
  useEffect(() => {
    if (!open) return;
    setPicked(new Set(selectedIds));
    let live = true;
    setRows(null);
    setFailed(false);
    void load()
      .then((entries) => {
        if (live) setRows(entries);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
    // `selectedIds` is a fresh array per render at the call site, so it is
    // deliberately not a dependency: the open transition is what re-seeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const sorted = useMemo(
    () => (rows === null ? [] : [...rows].sort((a, b) => b.created_at - a.created_at)),
    [rows],
  );
  // **The selection as ROWS, which is what this dialog can actually return**
  // (review round five). `picked` is seeded from the run's current ids, and that
  // set can hold a chat-scoped file the library list does not contain; counting
  // `picked.size` made the button promise a file it would not return ("Attach 2
  // files" handing back one) and, because the composer replaced its list with
  // the result, silently dropped the pasted chip.
  const chosen = useMemo(
    () => (rows === null ? [] : rows.filter((row) => picked.has(row.id))),
    [rows, picked],
  );
  const atCap = chosen.length >= MAX_RUN_ATTACHMENTS;

  function toggle(id: string): void {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_RUN_ATTACHMENTS) next.add(id);
      return next;
    });
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={t("agent.attachments.title")}
      labelId="ai-attachment-picker-title"
      width={520}
      closeLabel={t("common.close")}
      testId="ai.attachment-picker"
    >
      <div
        data-testid="ai.attachment-picker-body"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
          padding: "var(--space-4) var(--space-5)",
          maxHeight: 420,
          overflowY: "auto",
        }}
      >
        {failed ? (
          <p data-testid="ai.attachment-picker-failed" style={CAPTION_STYLE}>
            {t("agent.attachments.failed")}
          </p>
        ) : rows === null ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-4)" }}>
            <Spinner size={18} />
          </div>
        ) : sorted.length === 0 ? (
          <p data-testid="ai.attachment-picker-empty" style={CAPTION_STYLE}>
            {t("agent.attachments.empty")}
          </p>
        ) : (
          sorted.map((row) => {
            const on = picked.has(row.id);
            return (
              // `Button` rather than a hand-rolled `<button>`: the row is a
              // list option, but its padding, radius, hover and focus ring are
              // the app's one button design plus a selected state, and
              // re-deriving them here would be a second button in an app that
              // is supposed to have one.
              <Button
                key={row.id}
                variant="ghost"
                type="button"
                data-testid="ai.attachment-option"
                data-attachment-id={row.id}
                data-active={on ? "true" : "false"}
                aria-pressed={on}
                disabled={!on && atCap}
                onClick={() => toggle(row.id)}
                style={{
                  // The ghost variant's own padding is smaller than a list row
                  // wants; everything else here is state, not decoration.
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--space-2)",
                  padding: "var(--space-2) var(--space-3)",
                  textAlign: "left",
                  background: on ? "var(--bg-3)" : "var(--bg-1)",
                  border: `1px solid ${on ? "var(--accent)" : "var(--line-1)"}`,
                  borderRadius: "var(--radius-1)",
                  color: on ? "var(--accent)" : "var(--fg-1)",
                  cursor: on || !atCap ? "pointer" : "not-allowed",
                  opacity: !on && atCap ? 0.5 : 1,
                }}
              >
                {/* **A thumbnail, because a name is not an identity**
                    (myne-md/myne#913). The library routinely holds seven files
                    called `image.webp`, and a list of names asks the user to
                    guess which is which. The primitive is the library's own, so
                    a PDF shows its first page and audio its play tile rather
                    than a second, different notion of "preview". */}
                <span style={{ flexShrink: 0, width: 40, height: 40, borderRadius: "var(--radius-1)", overflow: "hidden" }}>
                  <AttachmentThumbnail
                    id={row.id}
                    contentType={row.content_type}
                    filename={row.filename}
                    size={40}
                  />
                </span>
                <span
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "2px",
                    overflow: "hidden",
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.filename}
                  </span>
                  <span style={{ ...CAPTION_STYLE, color: "var(--fg-3)" }}>
                    {Math.max(1, Math.round(row.size / 1024))} KB
                  </span>
                </span>
              </Button>
            );
          })
        )}
        {/* The cap is stated where it bites, not discovered by a row that stops
            responding. */}
        {atCap ? (
          <p data-testid="ai.attachment-picker-cap" style={CAPTION_STYLE}>
            {t("agent.attachments.cap", { count: MAX_RUN_ATTACHMENTS })}
          </p>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: "var(--space-2)",
          padding: "0 var(--space-5) var(--space-5)",
        }}
      >
        <Button variant="ghost" data-testid="ai.attachment-picker-cancel" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          data-testid="ai.attachment-picker-confirm"
          disabled={chosen.length === 0}
          onClick={() => {
            onPick(chosen);
            onClose();
          }}
        >
          {/* "Attach 0 files" on an empty selection read as a broken control
              (myne-md/myne#913). With nothing picked the button is disabled and
              says what the dialog does, not how many of nothing. */}
          {chosen.length === 0
            ? t("agent.attachments.attach")
            : t("agent.attachments.confirm", { count: chosen.length })}
        </Button>
      </div>
    </ModalShell>
  );
}
