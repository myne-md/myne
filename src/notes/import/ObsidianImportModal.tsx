// Obsidian importer — the active-import + summary surface (MYND-53, tasks 6 + 7).
//
// A single modal that walks three phases over a self-built dimmed-editor
// backdrop (the four-condition desktop modal carve-out — post-unlock, solicited,
// self-contained, dismiss-default; `decisions.md` 2026-05-08):
//
//   setup    → native folder picker (dialog:allow-open, already granted — no new
//              dep) + the SINGLE global SYNC-5 toggle (skip [default] / import as
//              a copy). No per-file modals; "overwrite" is never offered.
//   running  → live "X of N" progress (counts in JetBrains Mono) + Cancel. Cancel
//              keeps the partial import (SYNC-6, no rollback); backdrop/Esc are
//              inert here so a stray click can't abort.
//   summary  → the frozen 8-field SYNC-2 DTO + interactive needs-attention rows +
//              the low-profile transparency line (shown only if > 0).
//
// Design canon: Penpot "4 — Desktop UI Kit", `screen------importer — progress`
// + `screen------importer — summary` (MYND-53). Tokens via CSS vars (no hex);
// Inter for UI, JetBrains Mono for counts/paths.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  pickDirectory,
  pickFileAsTree,
  type PickedTree,
} from "../../platform/filePicker";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { DEFAULT_DUPLICATE_POLICY, type DuplicatePolicy } from "./conflict";
import { truncateMiddle } from "./truncateMiddle";
import type { IllegalSegmentFlag, PreexistingFolder } from "./mapping";
import type { ImportFailure, ImportResult } from "./engine";
import type { UnfollowedLink } from "./source";
import {
  importFailureReason,
  importFailureReasonKey,
} from "../../lib/import-errors";
import type { MediaByType } from "./media";
import { compressionTallyMessage } from "../../editor/attachments/insert";
import { runSourceImport } from "./ports";
import {
  IMPORT_SOURCES,
  type ImportSourceId,
  type ImportSourceSpec,
} from "./sourceCatalog";
import { ImportSourcePicker } from "./ImportSourcePicker";

type Phase = "pick" | "setup" | "running" | "summary" | "error";

interface ObsidianImportModalProps {
  open: boolean;
  onClose: () => void;
  /** Fired once the import resolves (completed or cancelled) so the parent can
   *  refresh the sidebar + surface a toast. */
  onImported?: (result: ImportResult | null) => void;
  /**
   * Which adapter to run (MYND-586). Defaults to `"obsidian"`, so every call site
   * that predates the source picker keeps its exact behaviour — the generalization
   * is additive rather than a breaking signature change.
   */
  source?: ImportSourceId;
}

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const HEADER_STYLE: CSSProperties = {
  minHeight: 56,
  padding: "0 var(--space-5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  borderBottom: "1px solid var(--line-1)",
  flex: "0 0 auto",
};

const TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "var(--tracking-tight)",
  color: "var(--fg-1)",
  margin: 0,
};

const BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: "var(--space-5)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const FOOTER_STYLE: CSSProperties = {
  borderTop: "1px solid var(--line-1)",
  padding: "var(--space-3) var(--space-5)",
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  flex: "0 0 auto",
};

const MONO: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontFeatureSettings: '"ss02","zero","calt"',
};

export function ObsidianImportModal({
  open,
  onClose,
  onImported,
  // Which adapter to run. Defaults to Obsidian so every existing call site keeps
  // its behaviour unchanged across the MYND-586 generalization.
  source: initialSource,
}: ObsidianImportModalProps) {
  // When a caller names a source, the flow starts at that source's setup step; when
  // it does not, the flow opens on the picker. That is what lets all three
  // entry-point surfaces share ONE flow (MYND-586).
  const [source, setSource] = useState<ImportSourceId>(initialSource ?? "obsidian");
  const spec = IMPORT_SOURCES[source];
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Trap + restore focus while open (MYND-93).
  useFocusTrap(dialogRef, { enabled: open });
  const [phase, setPhase] = useState<Phase>(initialSource === undefined ? "pick" : "setup");
  // The picked source, as the ONE type both pick shapes and both platforms
  // produce (phase3-web-client task 71). It used to be the path string
  // `dialog.open` returns — which a browser never gives, so the flow was
  // structurally desktop-only. `PickedTree` carries the root for display plus,
  // where the platform walked it, the entries themselves.
  const [folder, setFolder] = useState<PickedTree | null>(null);
  const [policy, setPolicy] = useState<DuplicatePolicy>(DEFAULT_DUPLICATE_POLICY);
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [result, setResult] = useState<ImportResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // `cancelRef` is read synchronously by the engine's `shouldCancel`; `cancelling`
  // is the UI mirror (a ref mutation alone wouldn't re-render the Cancel button).
  const cancelRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);

  // Reset to a clean setup state every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setPhase(initialSource === undefined ? "pick" : "setup");
    setSource(initialSource ?? "obsidian");
    setFolder(null);
    setPolicy(DEFAULT_DUPLICATE_POLICY);
    setProgress({ done: 0, total: 0 });
    setResult(null);
    setErrorMsg(null);
    cancelRef.current = false;
    setCancelling(false);
  }, [open, initialSource]);

  // `dismissable` gates the header ✕ + the explicit-close handler (everything but
  // mid-import). `casualDismiss` gates backdrop-click + Esc, which fire ONLY in
  // setup — the summary (with its interactive needs-attention rows) and the error
  // report must be closed deliberately via ✕ / Done / Close, never lost to a
  // stray backdrop click or keypress.
  const dismissable = phase !== "running";
  const casualDismiss = phase === "setup" || phase === "pick";

  const handleClose = useCallback(() => {
    if (!dismissable) return;
    onClose();
  }, [dismissable, onClose]);

  // Esc dismisses ONLY in setup (mid-import Cancel is the only exit; summary/error
  // require an explicit button).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && casualDismiss) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, casualDismiss, onClose]);

  const handleBackdrop = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget && casualDismiss) onClose();
    },
    [casualDismiss, onClose],
  );

  const chooseFolder = useCallback(async () => {
    try {
      // Evernote and CSV are SINGLE-FILE sources; the rest are directory trees.
      const picked =
        spec.pick === "directory"
          ? await pickDirectory()
          : await pickFileAsTree(
              spec.filter !== undefined
                ? {
                    extensions: [...spec.filter.extensions],
                    filterLabel: spec.filter.name,
                  }
                : undefined,
            );
      if (picked !== null) setFolder(picked);
    } catch {
      // Picker failure (cancel / unavailable) → leave the prior selection.
    }
  }, [spec]);

  const startImport = useCallback(() => {
    if (folder === null) return;
    cancelRef.current = false;
    setCancelling(false);
    setProgress({ done: 0, total: 0 });
    setPhase("running");
    void runSourceImport(source, folder, policy, {
      onProgress: (done, total) => setProgress({ done, total }),
      shouldCancel: () => cancelRef.current,
    })
      .then((r) => {
        setResult(r);
        setPhase("summary");
        onImported?.(r);
      })
      .catch((err) => {
        // NOT `err instanceof Error`. A backend rejection arrives as the
        // serialized error struct (`{kind:"NotUtf8"}`), never an `Error`, so
        // that test always fell through to the generic string and the screen
        // rendered the literal "Import failed." under a header already saying
        // "Import failed" (myne-md/myne#223). Per-file read failures and a
        // failed write no longer reach here at all — the engine returns those
        // with their tallies — so this path is now genuinely unexpected, and
        // the reason it carries is worth naming.
        setErrorMsg(t(importFailureReasonKey(importFailureReason(err))));
        setPhase("error");
        // Notes may have been created before the hard failure — refresh the
        // sidebar (null = "errored, just refresh") so they don't stay hidden.
        onImported?.(null);
      });
  }, [source, folder, policy, onImported, t]);

  if (!open) return null;

  const title =
    phase === "summary"
      ? t("notes.import.modal.titleComplete")
      : phase === "error"
        ? t("notes.import.modal.titleFailed")
        : phase === "pick"
          ? t("notes.import.modal.titlePick")
          : t("notes.import.modal.titleSetup");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="importer-modal-title"
      style={BACKDROP_STYLE}
      onClick={handleBackdrop}
    >
      <div
        ref={dialogRef}
        style={{
          width: 560,
          maxWidth: "calc(100vw - var(--space-7))",
          maxHeight: "calc(100vh - var(--space-7))",
          background: "var(--bg-2)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-2)",
          boxShadow: "var(--shadow-3)",
          display: "flex",
          flexDirection: "column",
          fontFamily: "var(--font-sans)",
          color: "var(--fg-1)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
        data-testid="import.modal"
        data-phase={phase}
        data-source={source}
      >
        <div style={HEADER_STYLE}>
          <h2 id="importer-modal-title" style={TITLE_STYLE} data-testid="import.title">
            {title}
          </h2>
          {dismissable && (
            <button
              type="button"
              aria-label={t("notes.import.modal.closeAriaLabel")}
              onClick={handleClose}
              data-testid="import.close"
              style={{
                background: "none",
                border: 0,
                color: "var(--fg-3)",
                cursor: "pointer",
                padding: 6,
                display: "inline-flex",
                borderRadius: "var(--radius-1)",
              }}
            >
              <Icon name="x" size={16} />
            </button>
          )}
        </div>

        {phase === "pick" && (
          <ImportSourcePicker
            onPick={(picked) => {
              setSource(picked);
              setFolder(null);
              setPhase("setup");
            }}
            onCancel={onClose}
          />
        )}

        {phase === "setup" && (
          <SetupBody
            spec={spec}
            onBack={initialSource === undefined ? () => setPhase("pick") : undefined}
            folder={folder}
            policy={policy}
            onChooseFolder={chooseFolder}
            onPolicyChange={setPolicy}
            onStart={startImport}
            onCancel={handleClose}
          />
        )}
        {phase === "running" && (
          <RunningBody
            done={progress.done}
            total={progress.total}
            cancelling={cancelling}
            onCancel={() => {
              cancelRef.current = true;
              setCancelling(true);
            }}
          />
        )}
        {phase === "summary" && result !== null && (
          <SummaryBody result={result} onDone={handleClose} />
        )}
        {phase === "error" && (
          <ErrorBody
            message={errorMsg ?? t("notes.import.modal.importFailed")}
            progress={progress}
            onClose={handleClose}
          />
        )}
      </div>
    </div>
  );
}

// ---- setup -------------------------------------------------------------------

function SetupBody({
  spec,
  onBack,
  folder,
  policy,
  onChooseFolder,
  onPolicyChange,
  onStart,
  onCancel,
}: {
  spec: ImportSourceSpec;
  /** Back to the picker. Absent when a caller named the source, since there is
   *  nothing to go back to. */
  onBack?: (() => void) | undefined;
  /** The picked source tree, or `null` before a pick. Only `root` is rendered —
   *  the entries, where the platform supplies them, are the importer's business. */
  folder: PickedTree | null;
  policy: DuplicatePolicy;
  onChooseFolder: () => void;
  onPolicyChange: (p: DuplicatePolicy) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div style={BODY_STYLE}>
        {/* Chosen source — text-only, no brand mark (#183: nominative use of the
            NAME is fine; reproducing third-party logos is a trademark grey area). */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <span
            style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--fg-1)" }}
            data-testid="import.chosen-source"
          >
            {t(spec.labelKey)}
          </span>
          {onBack !== undefined && (
            <button
              type="button"
              onClick={onBack}
              data-testid="import.change-source"
              style={{
                marginInlineStart: "auto",
                background: "none",
                border: 0,
                padding: 0,
                color: "var(--fg-3)",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-xs)",
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              {t("notes.import.modal.changeSource")}
            </button>
          )}
        </div>

        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          {t("notes.import.modal.setupIntro")}
        </p>

        {/* PRE-import fidelity disclosure. Moved here from the picker card: stating
            it before the user commits is the requirement, and this is still before
            — with room to read it. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-1)",
            padding: "var(--space-3)",
            borderRadius: "var(--radius-1)",
            background: "var(--paper-2)",
            border: "1px solid var(--line-1)",
          }}
        >
          <span
            style={{ fontSize: "var(--text-xs)", color: "var(--fg-1)", fontWeight: "var(--weight-medium)" }}
          >
            {t("notes.import.modal.keepsLabel")}
          </span>
          <span
            style={{ fontSize: "var(--text-xs)", color: "var(--fg-2)", lineHeight: 1.5 }}
            data-testid="import.source-survives"
          >
            {t(spec.survivesKey)}
          </span>
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--fg-1)",
              fontWeight: "var(--weight-medium)",
              marginTop: "var(--space-1)",
            }}
          >
            {t("notes.import.modal.losesLabel")}
          </span>
          <span
            style={{ fontSize: "var(--text-xs)", color: "var(--fg-2)", lineHeight: 1.5 }}
            data-testid="import.source-loses"
          >
            {t(spec.losesKey)}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--fg-1)" }}>
            {t("notes.import.modal.vaultFolderLabel")}
          </span>
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "stretch" }}>
            <code
              style={{
                flex: 1,
                ...MONO,
                fontSize: "var(--text-sm)",
                background: "var(--paper-2)",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-2)",
                padding: "8px 12px",
                color: folder === null ? "var(--fg-3)" : "var(--fg-1)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {folder?.root ?? t("notes.import.modal.noFolderChosen")}
            </code>
            <Button
              variant="secondary"
              icon="folder"
              onClick={onChooseFolder}
              data-testid="import.choose-source"
            >
              {t("notes.import.modal.chooseFolder")}
            </Button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--fg-1)" }}>
            {t("notes.import.modal.ifNoteExistsLabel")}
          </span>
          <RadioRow
            checked={policy === "skip"}
            label={t("notes.import.modal.policySkipLabel")}
            hint={t("notes.import.modal.policySkipHint")}
            onSelect={() => onPolicyChange("skip")}
          />
          <RadioRow
            checked={policy === "import-as-copy"}
            label={t("notes.import.modal.policyCopyLabel")}
            hint={t("notes.import.modal.policyCopyHint")}
            onSelect={() => onPolicyChange("import-as-copy")}
          />
        </div>
      </div>
      <div style={FOOTER_STYLE}>
        <Button variant="ghost" onClick={onCancel} data-testid="import.cancel">
          {t("notes.import.modal.cancel")}
        </Button>
        <Button
          variant="primary"
          onClick={onStart}
          disabled={folder === null}
          data-testid="import.start"
        >
          {t("notes.import.modal.import")}
        </Button>
      </div>
    </>
  );
}

function RadioRow({
  checked,
  label,
  hint,
  onSelect,
}: {
  checked: boolean;
  label: string;
  hint: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      style={{
        display: "flex",
        gap: "var(--space-3)",
        alignItems: "flex-start",
        textAlign: "start",
        background: checked ? "var(--accent-soft)" : "transparent",
        border: `1px solid ${checked ? "var(--accent)" : "var(--line-1)"}`,
        borderRadius: "var(--radius-2)",
        padding: "var(--space-3)",
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
      }}
    >
      <span
        aria-hidden
        style={{
          marginTop: 2,
          width: 16,
          height: 16,
          flex: "0 0 auto",
          borderRadius: "var(--radius-pill)",
          border: `2px solid ${checked ? "var(--accent)" : "var(--line-3)"}`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "var(--radius-pill)",
              background: "var(--accent)",
            }}
          />
        )}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--fg-1)" }}>
          {label}
        </span>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>{hint}</span>
      </span>
    </button>
  );
}

// ---- running -----------------------------------------------------------------

function RunningBody({
  done,
  total,
  cancelling,
  onCancel,
}: {
  done: number;
  total: number;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const preparing = total === 0;
  const pct = preparing ? 0 : Math.min(100, Math.round((done / total) * 100));
  return (
    <>
      <div style={BODY_STYLE}>
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          {preparing ? t("notes.import.modal.scanning") : t("notes.import.modal.importing")}
        </p>
        <div
          style={{
            height: 8,
            width: "100%",
            background: "var(--paper-3)",
            borderRadius: "var(--radius-pill)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: preparing ? "30%" : `${pct}%`,
              background: "var(--accent)",
              borderRadius: "var(--radius-pill)",
              transition: "width var(--duration-base) var(--ease-standard)",
            }}
          />
        </div>
        {preparing ? (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
            {t("notes.import.modal.preparing")}
          </div>
        ) : (
          <div style={{ fontSize: "var(--text-md)", color: "var(--fg-1)" }}>
            <span style={{ ...MONO, fontWeight: "var(--weight-semibold)" }}>{done}</span>
            <span style={{ color: "var(--fg-3)" }}>{t("notes.import.modal.progressOf")}</span>
            <span style={MONO}>{total}</span>
            <span style={{ color: "var(--fg-3)" }}>{t("notes.import.modal.progressNotes")}</span>
          </div>
        )}
      </div>
      <div style={FOOTER_STYLE}>
        <Button variant="secondary" onClick={onCancel} disabled={cancelling}>
          {cancelling ? t("notes.import.modal.cancelling") : t("notes.import.modal.cancel")}
        </Button>
      </div>
    </>
  );
}

// ---- summary -----------------------------------------------------------------

function totalByType(t: MediaByType): number {
  return t.image + t.pdf + t.audio + t.video + t.other;
}

function SummaryBody({ result, onDone }: { result: ImportResult; onDone: () => void }) {
  const { t } = useTranslation();
  const mediaIngested = totalByType(result.media.ingested);
  const mediaOmitted = totalByType(result.media.omitted);
  const hasMedia = mediaIngested > 0 || mediaOmitted > 0;
  // Ingest-time image compression ran on the same shared-core path a paste
  // takes, so the summary owes the same disclosure the paste toast gives
  // (`decisions.md` 2026-07-30). `null` when nothing compressed — a notice that
  // fires when nothing happened is how a user learns to stop reading notices.
  const compressionLine = compressionTallyMessage(result.compression);
  const needsAttention =
    result.illegalFlags.length +
    result.preexistingFolders.length +
    result.unfollowedLinks.length +
    result.unreadable.length;

  return (
    <>
      <div style={BODY_STYLE}>
        {/* A write failed and the run stopped. The notes above it landed and
            are safe, so this is the summary with a banner rather than the
            error screen — and it names the count, the file and the reason,
            which is exactly what the error screen could not (#223). */}
        {result.stopped !== null && (
          <div
            data-testid="import.stopped-banner"
            style={{
              display: "flex",
              gap: "var(--space-2)",
              alignItems: "flex-start",
              border: "1px solid var(--warning)",
              background: "var(--warning-soft)",
              borderRadius: "var(--radius-2)",
              padding: "var(--space-3)",
            }}
          >
            <Icon name="circle-alert" size={15} />
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>
                {t("notes.import.modal.stoppedAt", {
                  imported: result.imported,
                  total: result.total,
                })}
              </span>
              <code style={{ ...MONO, fontSize: "var(--text-xs)", color: "var(--fg-2)", wordBreak: "break-all" }}>
                {result.stopped.relPath}
              </code>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                {t(importFailureReasonKey(result.stopped.reason))}
              </span>
            </div>
          </div>
        )}

        {/* hero — imported */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "var(--space-2)",
            paddingBottom: "var(--space-2)",
          }}
        >
          <span style={{ ...MONO, fontSize: "var(--text-3xl)", fontWeight: "var(--weight-semibold)", color: "var(--fg-display)" }}>
            {result.imported}
          </span>
          <span style={{ fontSize: "var(--text-md)", color: "var(--fg-2)" }}>
            {t("notes.import.modal.notesImported", { count: result.imported })}
          </span>
        </div>

        {/* secondary counts */}
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          <StatRow label={t("notes.import.modal.statSkipped")} value={result.skippedExisting} />
          {hasMedia && (
            <StatRow
              label={t("notes.import.modal.statMedia")}
              valueNode={
                <span style={{ ...MONO, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
                  {t("notes.import.modal.mediaImported", { count: mediaIngested })}
                  {mediaOmitted > 0 ? t("notes.import.modal.mediaOmittedSuffix", { count: mediaOmitted }) : ""}
                </span>
              }
            />
          )}
          {compressionLine !== null && (
            <StatRow
              label={t("notes.import.modal.statCompressed")}
              valueNode={
                <span style={{ ...MONO, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
                  {compressionLine}
                </span>
              }
            />
          )}
          <StatRow label={t("notes.import.modal.statCanvasSkipped")} value={result.ignore.canvasSkipped} muted />
          {/* MYND-633: reported, not silently absent — an Excalidraw file used
              to import as a broken note, so the user needs to see it was left
              behind rather than wonder where the drawing went. */}
          <StatRow label={t("notes.import.modal.statExcalidrawSkipped")} value={result.ignore.excalidrawSkipped} muted />
          <StatRow label={t("notes.import.modal.statOtherSkipped")} value={result.ignore.nonMarkdownSkipped} muted />
          <StatRow label={t("notes.import.modal.statEmptyFoldersKept")} value={result.emptyFoldersPreserved} muted />
          {result.cancelled !== null && (
            <StatRow
              label={t("notes.import.modal.statCancelled")}
              valueNode={
                <span style={{ fontSize: "var(--text-sm)", color: "var(--warning)" }}>
                  {t("notes.import.modal.cancelledNotImported", { count: result.cancelled })}
                </span>
              }
            />
          )}
        </div>

        {needsAttention > 0 && (
          <NeedsAttention
            flags={result.illegalFlags}
            preexisting={result.preexistingFolders}
            unfollowedLinks={result.unfollowedLinks}
            unreadable={result.unreadable}
          />
        )}

        {/* transparency line — shown only if > 0 */}
        {result.ignore.hiddenIgnored > 0 && (
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              borderTop: "1px solid var(--line-1)",
              paddingTop: "var(--space-3)",
            }}
          >
            {t("notes.import.modal.hiddenIgnoredPrefix", { count: result.ignore.hiddenIgnored })}
            <span style={MONO}>.obsidian/</span>
            {t("notes.import.modal.hiddenIgnoredSuffix")}
          </p>
        )}
      </div>
      <div style={FOOTER_STYLE}>
        <Button variant="primary" onClick={onDone}>
          {t("notes.import.modal.done")}
        </Button>
      </div>
    </>
  );
}

function StatRow({
  label,
  value,
  valueNode,
  muted,
}: {
  label: string;
  value?: number;
  valueNode?: ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "7px 0",
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      <span style={{ fontSize: "var(--text-sm)", color: muted ? "var(--fg-3)" : "var(--fg-2)" }}>
        {label}
      </span>
      {valueNode ?? (
        <span style={{ ...MONO, fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>{value}</span>
      )}
    </div>
  );
}

/** Resolve the user-facing reason label at call time (NOT a module-frozen map —
 *  it must re-resolve on language switch). `t` is passed from the consuming
 *  component's `useTranslation()` so the subtree re-renders on a language change. */
function illegalReasonLabel(
  reason: IllegalSegmentFlag["reason"],
  t: TFunction,
): string {
  switch (reason) {
    case "illegal-char":
      return t("notes.import.modal.reasonIllegalChar");
    case "segment-too-long":
      return t("notes.import.modal.reasonSegmentTooLong");
    case "path-too-long":
      return t("notes.import.modal.reasonPathTooLong");
  }
}

/** Replace the characters Myne never allows in a path segment with "-" — a
 *  starting suggestion the user edits, NOT an auto-applied rename (C1: the note
 *  was imported byte-for-byte; nothing here mutates it). Deeper auto-resolve
 *  (locate + rename the note) is the MYND-50/51 follow-up this surface shares. */
function suggestName(segment: string): string {
  return segment
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 96)
    .trim();
}

/**
 * Why a link was not followed. Exhaustive over the reason union with a `never`
 * default, and returns a KEY the caller resolves — a `t()` frozen at module
 * level would capture the boot language (`src/CLAUDE.md`).
 */
function unfollowedLinkDetailKey(reason: UnfollowedLink["reason"]): string {
  switch (reason) {
    case "outside":
      return "notes.import.modal.unfollowedLinkOutside";
    case "loop":
      return "notes.import.modal.unfollowedLinkLoop";
    case "broken":
      return "notes.import.modal.unfollowedLinkBroken";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function NeedsAttention({
  flags,
  preexisting,
  unfollowedLinks,
  unreadable,
}: {
  flags: readonly IllegalSegmentFlag[];
  preexisting: readonly PreexistingFolder[];
  /** Links the walk refused (myne-md/myne#223). Named here rather than counted:
   *  what sits behind one is a subtree of unknown size, and a muted "other files
   *  skipped 1" reads like a stray `.png`. */
  unfollowedLinks: readonly UnfollowedLink[];
  /** Files that could not be read. The import continued past each one. */
  unreadable: readonly ImportFailure[];
}) {
  const { t } = useTranslation();
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const markResolved = (key: string) =>
    setResolved((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Icon name="circle-alert" size={15} />
        <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--fg-1)" }}>
          {t("notes.import.modal.needsAttention")}
        </span>
        <span
          style={{
            ...MONO,
            fontSize: "var(--text-xs)",
            color: "var(--warning)",
            background: "var(--warning-soft)",
            borderRadius: "var(--radius-pill)",
            padding: "1px 8px",
          }}
        >
          {flags.length + preexisting.length + unfollowedLinks.length + unreadable.length}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
        {t("notes.import.modal.needsAttentionHelp")}
      </p>

      {unfollowedLinks.map((link, i) => {
        const key = `link-${i}`;
        return (
          <AttentionRow
            key={key}
            path={link.relPath}
            detail={t(unfollowedLinkDetailKey(link.reason))}
            suggestion={null}
            resolved={resolved.has(key)}
            onResolve={() => markResolved(key)}
          />
        );
      })}

      {unreadable.map((failure, i) => {
        const key = `unreadable-${i}`;
        return (
          <AttentionRow
            key={key}
            path={failure.relPath}
            detail={t("notes.import.modal.unreadableDetail", {
              reason: t(importFailureReasonKey(failure.reason)),
            })}
            suggestion={null}
            resolved={resolved.has(key)}
            onResolve={() => markResolved(key)}
          />
        );
      })}

      {flags.map((flag, i) => {
        const key = `flag-${i}`;
        return (
          <AttentionRow
            key={key}
            path={flag.relativePath}
            detail={t("notes.import.modal.flagDetail", {
              kind:
                flag.kind === "folder"
                  ? t("notes.import.modal.flagKindFolder")
                  : t("notes.import.modal.flagKindTitle"),
              segment: truncateMiddle(flag.segment),
              reason: illegalReasonLabel(flag.reason, t),
            })}
            suggestion={suggestName(flag.segment)}
            resolved={resolved.has(key)}
            onResolve={() => markResolved(key)}
          />
        );
      })}

      {preexisting.map((pf, i) => {
        const key = `pf-${i}`;
        return (
          <AttentionRow
            key={key}
            path={pf.derivedFromPath ?? t("notes.import.modal.vaultRoot")}
            detail={t("notes.import.modal.preexistingDetail", {
              existing: truncateMiddle(pf.existing),
            })}
            suggestion={pf.existing}
            resolved={resolved.has(key)}
            onResolve={() => markResolved(key)}
          />
        );
      })}
    </div>
  );
}

function AttentionRow({
  path,
  detail,
  suggestion,
  resolved,
  onResolve,
}: {
  path: string;
  detail: string;
  /** A starting-point value to copy, or `null` when the row has nothing to
   *  offer — a link Myne could not follow is fixed in the filesystem, not by
   *  renaming something, and an empty input invites a fix that does nothing. */
  suggestion: string | null;
  resolved: boolean;
  onResolve: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(suggestion ?? "");
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(draft).then(
      () => setCopied(true),
      () => {
        /* clipboard unavailable — the field is still selectable */
      },
    );
  }, [draft]);

  return (
    <div
      style={{
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-2)",
        padding: "var(--space-3)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        opacity: resolved ? 0.55 : 1,
      }}
    >
      <code
        style={{
          ...MONO,
          fontSize: "var(--text-xs)",
          color: "var(--fg-2)",
          wordBreak: "break-all",
        }}
      >
        {truncateMiddle(path, 96)}
      </code>
      <span
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--fg-3)",
          overflowWrap: "anywhere",
        }}
      >
        {detail}
      </span>
      {resolved ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-1)",
            fontSize: "var(--text-xs)",
            color: "var(--success)",
          }}
        >
          <Icon name="check" size={13} /> {t("notes.import.modal.markedDone")}
        </span>
      ) : suggestion === null ? (
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "stretch" }}>
          <Button variant="ghost" onClick={onResolve}>
            {t("notes.import.modal.markDone")}
          </Button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "stretch" }}>
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setCopied(false);
            }}
            aria-label={t("notes.import.modal.suggestedNameAriaLabel")}
            style={{
              flex: 1,
              ...MONO,
              fontSize: "var(--text-sm)",
              padding: "6px 8px",
              background: "var(--bg-1)",
              color: "var(--fg-1)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--radius-1)",
              outline: "none",
            }}
          />
          <Button variant="secondary" icon={copied ? "check" : "copy"} onClick={copy}>
            {copied ? t("notes.import.modal.copied") : t("notes.import.modal.copy")}
          </Button>
          <Button variant="ghost" onClick={onResolve}>
            {t("notes.import.modal.markDone")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---- error -------------------------------------------------------------------

function ErrorBody({
  message,
  progress,
  onClose,
}: {
  message: string;
  /** How far the run had got. The counter lives in `RunningBody`, which
   *  unmounts on the phase flip — so it was computed, kept in state, and then
   *  never shown on the one screen where it answers the user's first question
   *  ("did any of it land?"). */
  progress: { done: number; total: number };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div style={BODY_STYLE}>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-start" }}>
          <Icon name="circle-alert" size={18} />
          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>
            {t("notes.import.modal.errorBody")}
          </p>
        </div>
        {progress.total > 0 && (
          <p
            data-testid="import.error-progress"
            style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}
          >
            {t("notes.import.modal.stoppedAt", {
              imported: progress.done,
              total: progress.total,
            })}
          </p>
        )}
        <code
          style={{
            ...MONO,
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            background: "var(--paper-2)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-1)",
            padding: "var(--space-2)",
            wordBreak: "break-word",
          }}
        >
          {message}
        </code>
      </div>
      <div style={FOOTER_STYLE}>
        <Button variant="secondary" onClick={onClose}>
          {t("notes.import.modal.close")}
        </Button>
      </div>
    </>
  );
}
