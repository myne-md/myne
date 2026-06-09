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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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

  const dismissable = phase !== "running";

  const handleClose = useCallback(() => {
    if (!dismissable) return;
    onClose();
  }, [dismissable, onClose]);

  // Esc dismisses except mid-import (where Cancel is the only exit).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismissable, onClose]);

  const handleBackdrop = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) handleClose();
    },
    [handleClose],
  );

  const chooseFolder = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose your Obsidian vault folder",
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
        setErrorMsg(err instanceof Error ? err.message : "Import failed.");
        setPhase("error");
      });
  }, [folder, policy, onImported]);

  if (!open) return null;

  const title =
    phase === "summary"
      ? "Import complete"
      : phase === "error"
        ? "Import failed"
        : "Import Obsidian vault";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="importer-modal-title"
      style={BACKDROP_STYLE}
      onClick={handleBackdrop}
    >
      <div
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
              aria-label="Close"
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
          <ErrorBody message={errorMsg ?? "Import failed."} onClose={handleClose} />
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
  return (
    <>
      <div style={BODY_STYLE}>
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          Point Myne at your existing Obsidian vault folder. Every Markdown note
          is imported and encrypted on the spot — nothing leaves this device, and
          your original files are left untouched.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
            Vault folder
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
              {folder ?? "No folder chosen"}
            </code>
            <Button variant="secondary" icon="folder" onClick={onChooseFolder}>
              Choose folder…
            </Button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
            If a note already exists
          </span>
          <RadioRow
            checked={policy === "skip"}
            label="Skip it"
            hint="Recommended — re-running an import never duplicates or overwrites."
            onSelect={() => onPolicyChange("skip")}
          />
          <RadioRow
            checked={policy === "import-as-copy"}
            label="Import as a copy"
            hint="Bring it in alongside the existing note."
            onSelect={() => onPolicyChange("import-as-copy")}
          />
        </div>
      </div>
      <div style={FOOTER_STYLE}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onStart} disabled={folder === null}>
          Import
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
  const preparing = total === 0;
  const pct = preparing ? 0 : Math.min(100, Math.round((done / total) * 100));
  return (
    <>
      <div style={BODY_STYLE}>
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          {preparing ? "Scanning your vault…" : "Importing your vault…"}
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
            Preparing…
          </div>
        ) : (
          <div style={{ fontSize: "var(--text-md)", color: "var(--fg-1)" }}>
            <span style={{ ...MONO, fontWeight: 600 }}>{done}</span>
            <span style={{ color: "var(--fg-3)" }}> of </span>
            <span style={MONO}>{total}</span>
            <span style={{ color: "var(--fg-3)" }}> notes</span>
          </div>
        )}
      </div>
      <div style={FOOTER_STYLE}>
        <Button variant="secondary" onClick={onCancel} disabled={cancelling}>
          {cancelling ? "Cancelling…" : "Cancel"}
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
            {result.imported === 1 ? "note imported" : "notes imported"}
          </span>
        </div>

        {/* secondary counts */}
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          <StatRow label="Skipped (already exist)" value={result.skippedExisting} />
          {hasMedia && (
            <StatRow
              label="Media"
              valueNode={
                <span style={{ ...MONO, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
                  {mediaIngested} imported
                  {mediaOmitted > 0 ? ` · ${mediaOmitted} omitted` : ""}
                </span>
              }
            />
          )}
          <StatRow label=".canvas files skipped" value={result.ignore.canvasSkipped} muted />
          <StatRow label="Other files skipped" value={result.ignore.nonMarkdownSkipped} muted />
          <StatRow label="Empty folders kept" value={result.emptyFoldersPreserved} muted />
          {result.cancelled !== null && (
            <StatRow
              label="Cancelled"
              valueNode={
                <span style={{ fontSize: "var(--text-sm)", color: "var(--warning)" }}>
                  {result.cancelled} not imported
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
            {result.ignore.hiddenIgnored} config / hidden{" "}
            {result.ignore.hiddenIgnored === 1 ? "item" : "items"} ignored
            (e.g. <span style={MONO}>.obsidian/</span>, dotfiles).
          </p>
        )}
      </div>
      <div style={FOOTER_STYLE}>
        <Button variant="primary" onClick={onDone}>
          Done
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

const ILLEGAL_REASON_LABEL: Record<IllegalSegmentFlag["reason"], string> = {
  "illegal-char": "contains a character Myne can’t use in a name",
  "segment-too-long": "name is longer than Myne allows",
  "path-too-long": "the folder + title path is too long",
};

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
          Needs attention
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
        These notes were imported unchanged. Suggested fixes are starting points
        — copy one, then rename the note when you open it.
      </p>

      {flags.map((flag, i) => {
        const key = `flag-${i}`;
        return (
          <AttentionRow
            key={key}
            path={flag.relativePath}
            detail={`${flag.kind === "folder" ? "Folder" : "Title"} “${flag.segment}” ${ILLEGAL_REASON_LABEL[flag.reason]}.`}
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
            path={pf.derivedFromPath ?? "(vault root)"}
            detail={`This note already had its own folder: “${pf.existing}”, which Myne kept — its folder may differ from where it sat on disk.`}
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
          <Icon name="check" size={13} /> Marked done
        </span>
      ) : (
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "stretch" }}>
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setCopied(false);
            }}
            aria-label="Suggested name"
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
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="ghost" onClick={onResolve}>
            Mark done
          </Button>
        </div>
      )}
    </div>
  );
}

// ---- error -------------------------------------------------------------------

function ErrorBody({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <>
      <div style={BODY_STYLE}>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-start" }}>
          <Icon name="circle-alert" size={18} />
          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>
            The import couldn’t complete. Any notes already imported were kept and
            are safe to keep or delete.
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
          Close
        </Button>
      </div>
    </>
  );
}
