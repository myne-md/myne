// Whole-vault export modal (MYND-211 task 3) — the importer-mirror
// three-phase surface: setup (destination + scope + the one plain egress
// sentence) → running (counts + cooperative Cancel) → summary (counts,
// exclusions, "Show in folder").
//
// Penpot canon: page "4 — Desktop UI Kit", section
// `section------export — vault export modal (MYND-211)`. The frames carry
// the NoteExportModal card anatomy (480px padded card, title inside the
// body, no header hairline / ✕) rather than the ModalShell header chrome —
// implemented accordingly. Dismissal discipline follows the importer:
// setup is casually dismissable (Esc / backdrop / Cancel — a free exit,
// nothing invoked); running is inert except the explicit Cancel (which
// fires `vault_export_cancel`; the engine discards staging and the modal
// returns to setup QUIETLY); the summary closes only via Done /
// Show in folder — never lost to a stray click.
//
// All phase/format decisions live in `vaultExportFlow.ts` (Vitest-pinned);
// this component renders the state machine and wires the IPC edges:
// dialog `open({directory:true})` for the parent folder (the consent
// source), `vaultExportMarkdown` / `vaultExportCancel`, the counts-only
// `export://progress` listener, and `revealItemInDir` on the published
// tree (ACL: `opener:allow-reveal-item-in-dir`).

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "../../platform/dialog";
import { listen } from "../../platform/event";
import { revealItemInDir } from "../../platform/opener";
import { Button } from "../primitives/Button";
// One modal skin (NoteExportModal exports it for its siblings) — only the
// card width differs (480 vs 420) and the sub-panel doubles as the
// summary counts panel.
import {
  BACKDROP_STYLE,
  CARD_STYLE,
  FOOTER_STYLE,
  SENTENCE_STYLE,
  SUB_PANEL_STYLE,
  TITLE_STYLE,
} from "./NoteExportModal";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useOverlayInert } from "../../hooks/useOverlayInert";
import { VAULT_EXPORT_PLAIN_TREE_SENTENCE } from "../../lib/load-bearing-copy";
import { vaultExportCancel, vaultExportMarkdown } from "../../notes/vaultExport";
import {
  VAULT_EXPORT_PROGRESS_EVENT,
  type VaultExportError,
  type VaultExportProgress,
} from "../../types/vault-export-error";
import {
  canStart,
  composedDestination,
  defaultExportTreeName,
  formatExclusionsLine,
  formatRunningCounts,
  formatSummaryCounts,
  initialVaultExportState,
  progressFraction,
  scopeArg,
  vaultExportReducer,
} from "./vaultExportFlow";

interface VaultExportModalProps {
  open: boolean;
  onClose: () => void;
  /** Canonical trailing-slash folder paths for the scope dropdown —
   *  the sidebar's folder-tree source (`collectFolderOptions`). */
  folders: readonly string[];
}

const VAULT_CARD_STYLE: CSSProperties = { ...CARD_STYLE, width: 480 };

const FIELD_LABEL_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-3)",
};

const MONO: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontFeatureSettings: '"ss02","zero","calt"',
};

const PATH_DISPLAY_STYLE: CSSProperties = {
  flex: 1,
  ...MONO,
  fontSize: 12,
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "8px 12px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  // Truncate from the LEFT so the tree name (the part the user chose
  // least directly) stays visible at the right edge.
  direction: "rtl",
  textAlign: "left",
};

const RADIO_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  background: "transparent",
  border: 0,
  padding: "2px 0",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  textAlign: "start",
};

const FOLDER_SELECT_STYLE: CSSProperties = {
  // Indent under the radio circle (14px) + gap so it aligns with the
  // "One folder" label, as in the Penpot frame.
  marginInlineStart: "calc(14px + var(--space-2))",
  height: 32,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "0 var(--space-2)",
};

const ERROR_LINE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  color: "var(--danger)",
};

const TRACK_STYLE: CSSProperties = {
  height: 6,
  width: "100%",
  background: "var(--paper-3)",
  borderRadius: "var(--radius-pill)",
  overflow: "hidden",
};

function RadioRow({
  checked,
  label,
  testId,
  onSelect,
}: {
  checked: boolean;
  label: string;
  testId: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      style={RADIO_ROW_STYLE}
      data-testid={testId}
      data-checked={checked ? "true" : "false"}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          height: 14,
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
              width: 6,
              height: 6,
              borderRadius: "var(--radius-pill)",
              background: "var(--accent)",
            }}
          />
        )}
      </span>
      <span>{label}</span>
    </button>
  );
}

export function VaultExportModal({
  open,
  onClose,
  folders,
}: VaultExportModalProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(
    vaultExportReducer,
    undefined,
    () => initialVaultExportState(),
  );

  // Fresh setup state (new datestamped tree name) on every open.
  useEffect(() => {
    if (open) dispatch({ type: "reset", treeName: defaultExportTreeName() });
  }, [open]);

  // Counts-only progress listener, alive for the whole open span (the
  // reducer ignores events outside the running phase).
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<VaultExportProgress>(VAULT_EXPORT_PROGRESS_EVENT, (event) => {
      dispatch({ type: "progress", progress: event.payload });
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open]);

  // Casual dismiss (Esc / backdrop) only in setup — running is inert
  // (Cancel is the only exit) and the summary must be closed deliberately.
  const casualDismiss = state.phase === "setup";
  useEffect(() => {
    if (!open || !casualDismiss) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, casualDismiss, onClose]);

  const chooseDestination = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("export.vault.chooseDestinationDialogTitle"),
      });
      if (typeof picked === "string") dispatch({ type: "pick-dir", dir: picked });
    } catch {
      // Picker failure (cancel / unavailable) → keep the prior selection.
    }
  }, [t]);

  // StrictMode-safe single-flight: `start` reads the latest state from a
  // ref so the callback identity stays stable across renders.
  const stateRef = useRef(state);
  // Trap + restore focus while open so `aria-modal="true"` is truthful (MYND-93).
  const modalRef = useRef<HTMLDivElement>(null);
  // The rest of the page goes INERT while this is open (myne-md/myne#728).
  // The trap above contains Tab; it does not stop a screen reader's virtual
  // cursor or a click reaching the background. Registered on the BACKDROP,
  // which is the whole overlay.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, open);
  useFocusTrap(modalRef, { enabled: open });
  stateRef.current = state;
  const start = useCallback(() => {
    const s = stateRef.current;
    if (s.phase !== "setup" || !canStart(s)) return;
    // Computed ONCE here and carried in the start event — the reducer
    // never re-derives the destination.
    const destination = composedDestination(s);
    if (destination === null) return;
    const scope = scopeArg(s.scope);
    dispatch({ type: "start", destination });
    void vaultExportMarkdown(null, destination, scope)
      .then((summary) => dispatch({ type: "succeeded", summary }))
      .catch((raw) =>
        dispatch({ type: "failed", error: raw as VaultExportError }),
      );
  }, []);

  const cancelRunning = useCallback(() => {
    dispatch({ type: "cancel-requested" });
    // Cooperative: the in-flight invoke settles with `Cancelled`, which
    // the reducer turns into a quiet return to setup.
    void vaultExportCancel();
  }, []);

  if (!open) return null;

  const destination =
    state.phase === "setup" ? composedDestination(state) : null;
  const exclusionsLine =
    state.phase === "summary" ? formatExclusionsLine(state.summary) : null;

  return (
    <div
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="vault-export-title"
      style={BACKDROP_STYLE}
      onClick={(e) => {
        if (e.target === e.currentTarget && casualDismiss) onClose();
      }}
    >
      <div ref={modalRef} style={VAULT_CARD_STYLE} data-testid="vault-export.modal">
        {state.phase === "setup" && (
          <>
            <h2 id="vault-export-title" style={TITLE_STYLE}>
              {t("export.vault.setup.title")}
            </h2>
            <p
              style={SENTENCE_STYLE}
              data-testid="vault-export.plain-tree-sentence"
            >
              {VAULT_EXPORT_PLAIN_TREE_SENTENCE}
            </p>

            <div
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
            >
              <span style={FIELD_LABEL_STYLE}>
                {t("export.vault.setup.destinationLabel")}
              </span>
              <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "stretch" }}>
                <code
                  style={{
                    ...PATH_DISPLAY_STYLE,
                    color: destination === null ? "var(--fg-3)" : "var(--fg-1)",
                  }}
                  data-testid="vault-export.destination-path"
                  title={destination ?? undefined}
                >
                  {/* LRM guard: the rtl-truncation trick must not reorder
                      leading punctuation of the path itself. */}
                  {destination === null
                    ? t("export.vault.setup.noFolderChosen")
                    : `\u200E${destination}`}
                </code>
                <Button
                  variant="secondary"
                  onClick={() => void chooseDestination()}
                  data-testid="vault-export.choose-destination"
                >
                  {t("export.vault.setup.choose")}
                </Button>
              </div>
            </div>

            <div
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
            >
              <span style={FIELD_LABEL_STYLE}>
                {t("export.vault.setup.scopeLabel")}
              </span>
              <RadioRow
                checked={state.scope.kind === "whole"}
                label={t("export.vault.setup.scopeWhole")}
                testId="vault-export.scope-whole"
                onSelect={() => dispatch({ type: "scope-whole" })}
              />
              <RadioRow
                checked={state.scope.kind === "folder"}
                label={t("export.vault.setup.scopeFolder")}
                testId="vault-export.scope-folder"
                onSelect={() => dispatch({ type: "scope-folder" })}
              />
              <select
                value={state.scope.kind === "folder" ? state.scope.folder ?? "" : ""}
                onChange={(e) => {
                  if (e.target.value !== "") {
                    dispatch({ type: "scope-folder-path", folder: e.target.value });
                  }
                }}
                disabled={state.scope.kind !== "folder" || folders.length === 0}
                aria-label={t("export.vault.setup.folderSelectAriaLabel")}
                style={FOLDER_SELECT_STYLE}
                data-testid="vault-export.scope-folder-select"
              >
                <option value="">
                  {folders.length === 0
                    ? t("export.vault.setup.noFoldersInVault")
                    : t("export.vault.setup.chooseFolder")}
                </option>
                {folders.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            </div>

            {state.error !== null && (
              <p role="alert" style={ERROR_LINE_STYLE} data-testid="vault-export.error">
                {state.error}
              </p>
            )}

            <div style={FOOTER_STYLE}>
              <Button
                variant="secondary"
                onClick={onClose}
                data-testid="vault-export.cancel"
              >
                {t("export.vault.setup.cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={start}
                disabled={!canStart(state)}
                data-testid="vault-export.confirm"
              >
                {t("export.vault.setup.export")}
              </Button>
            </div>
          </>
        )}

        {state.phase === "running" && (
          <>
            <h2 id="vault-export-title" style={TITLE_STYLE}>
              {t("export.vault.running.title")}
            </h2>
            <div
              style={{ ...MONO, fontSize: "var(--text-sm)", color: "var(--fg-1)" }}
              data-testid="vault-export.progress"
            >
              {formatRunningCounts(state.progress)}
            </div>
            <div style={TRACK_STYLE}>
              <div
                style={{
                  height: "100%",
                  width: `${progressFraction(state.progress) * 100}%`,
                  background: "var(--accent)",
                  borderRadius: "var(--radius-pill)",
                  transition: "width var(--duration-base) var(--ease-standard)",
                }}
              />
            </div>
            <div style={FOOTER_STYLE}>
              <Button
                variant="secondary"
                onClick={cancelRunning}
                disabled={state.cancelling}
                data-testid="vault-export.cancel"
              >
                {state.cancelling
                  ? t("export.vault.running.cancelling")
                  : t("export.vault.running.cancel")}
              </Button>
            </div>
          </>
        )}

        {state.phase === "summary" && (
          <>
            <h2 id="vault-export-title" style={TITLE_STYLE}>
              {t("export.vault.summary.title")}
            </h2>
            <div style={SUB_PANEL_STYLE} data-testid="vault-export.summary">
              <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>
                {formatSummaryCounts(state.summary)}
              </span>
              {exclusionsLine !== null && (
                <span
                  style={{ fontSize: 12, color: "var(--fg-3)" }}
                  data-testid="vault-export.exclusions"
                >
                  {exclusionsLine}
                </span>
              )}
            </div>
            <div style={FOOTER_STYLE}>
              <Button
                variant="secondary"
                onClick={() => {
                  // Reveal failure is swallowed — the export itself
                  // already succeeded and the path is on screen.
                  void revealItemInDir(state.destination).catch(() => {});
                }}
                data-testid="vault-export.show-in-folder"
              >
                {t("export.vault.summary.showInFolder")}
              </Button>
              <Button
                variant="primary"
                onClick={onClose}
                data-testid="vault-export.done"
              >
                {t("common.done")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
