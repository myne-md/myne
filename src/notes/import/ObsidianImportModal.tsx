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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { DEFAULT_DUPLICATE_POLICY, type DuplicatePolicy } from "./conflict";
import type { IllegalSegmentFlag, PreexistingFolder } from "./mapping";
import type { ImportResult } from "./engine";
import type { MediaByType } from "./media";
import { runVaultImport } from "./ports";

type Phase = "setup" | "running" | "summary" | "error";

interface ObsidianImportModalProps {
  open: boolean;
  onClose: () => void;
  /** Fired once the import resolves (completed or cancelled) so the parent can
   *  refresh the sidebar + surface a toast. */
  onImported?: (result: ImportResult) => void;
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

export function ObsidianImportModal({ open, onClose, onImported }: ObsidianImportModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Trap + restore focus while open (MYND-93).
  useFocusTrap(dialogRef, { enabled: open });
  const [phase, setPhase] = useState<Phase>("setup");
  const [folder, setFolder] = useState<string | null>(null);
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
    setPhase("setup");
    setFolder(null);
    setPolicy(DEFAULT_DUPLICATE_POLICY);
    setProgress({ done: 0, total: 0 });
    setResult(null);
    setErrorMsg(null);
    cancelRef.current = false;
    setCancelling(false);
  }, [open]);

  // `dismissable` gates the header ✕ + the explicit-close handler (everything but
  // mid-import). `casualDismiss` gates backdrop-click + Esc, which fire ONLY in
  // setup — the summary (with its interactive needs-attention rows) and the error
  // report must be closed deliberately via ✕ / Done / Close, never lost to a
  // stray backdrop click or keypress.
  const dismissable = phase !== "running";
  const casualDismiss = phase === "setup";

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
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("notes.import.modal.folderPickerTitle"),
      });
      if (typeof picked === "string") setFolder(picked);
    } catch {
      // Picker failure (cancel / unavailable) → leave the prior selection.
    }
  }, []);

  const startImport = useCallback(() => {
    if (folder === null) return;
    cancelRef.current = false;
    setCancelling(false);
    setProgress({ done: 0, total: 0 });
    setPhase("running");
    void runVaultImport(folder, policy, {
      onProgress: (done, total) => setProgress({ done, total }),
      shouldCancel: () => cancelRef.current,
    })
      .then((r) => {
        setResult(r);
        setPhase("summary");
        onImported?.(r);
      })
      .catch((err) => {
        setErrorMsg(err instanceof Error ? err.message : t("notes.import.modal.importFailed"));
        setPhase("error");
      });
  }, [folder, policy, onImported, t]);

  if (!open) return null;

  const title =
    phase === "summary"
      ? t("notes.import.modal.titleComplete")
      : phase === "error"
        ? t("notes.import.modal.titleFailed")
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
      >
        <div style={HEADER_STYLE}>
          <h2 id="importer-modal-title" style={TITLE_STYLE}>
            {title}
          </h2>
          {dismissable && (
            <button
              type="button"
              aria-label={t("notes.import.modal.closeAriaLabel")}
              onClick={handleClose}
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

        {phase === "setup" && (
          <SetupBody
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
          <ErrorBody message={errorMsg ?? t("notes.import.modal.importFailed")} onClose={handleClose} />
        )}
      </div>
    </div>
  );
}

// ---- setup -------------------------------------------------------------------

function SetupBody({
  folder,
  policy,
  onChooseFolder,
  onPolicyChange,
  onStart,
  onCancel,
}: {
  folder: string | null;
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
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          {t("notes.import.modal.setupIntro")}
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
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
                borderRadius: 6,
                padding: "8px 12px",
                color: folder === null ? "var(--fg-3)" : "var(--fg-1)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {folder ?? t("notes.import.modal.noFolderChosen")}
            </code>
            <Button variant="secondary" icon="folder" onClick={onChooseFolder}>
              {t("notes.import.modal.chooseFolder")}
            </Button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
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
        <Button variant="ghost" onClick={onCancel}>
          {t("notes.import.modal.cancel")}
        </Button>
        <Button variant="primary" onClick={onStart} disabled={folder === null}>
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
        textAlign: "left",
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
        <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
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
            <span style={{ ...MONO, fontWeight: 600 }}>{done}</span>
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
  const needsAttention = result.illegalFlags.length + result.preexistingFolders.length;

  return (
    <>
      <div style={BODY_STYLE}>
        {/* hero — imported */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "var(--space-2)",
            paddingBottom: "var(--space-2)",
          }}
        >
          <span style={{ ...MONO, fontSize: "var(--text-3xl)", fontWeight: 600, color: "var(--fg-display)" }}>
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
          <StatRow label={t("notes.import.modal.statCanvasSkipped")} value={result.ignore.canvasSkipped} muted />
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

function NeedsAttention({
  flags,
  preexisting,
}: {
  flags: readonly IllegalSegmentFlag[];
  preexisting: readonly PreexistingFolder[];
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
        <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--fg-1)" }}>
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
          {flags.length + preexisting.length}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
        {t("notes.import.modal.needsAttentionHelp")}
      </p>

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
              segment: flag.segment,
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
            detail={t("notes.import.modal.preexistingDetail", { existing: pf.existing })}
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
  suggestion: string;
  resolved: boolean;
  onResolve: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(suggestion);
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
        {path}
      </code>
      <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>{detail}</span>
      {resolved ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: "var(--text-xs)",
            color: "var(--success)",
          }}
        >
          <Icon name="check" size={13} /> {t("notes.import.modal.markedDone")}
        </span>
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

function ErrorBody({ message, onClose }: { message: string; onClose: () => void }) {
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
