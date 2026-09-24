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
import { MyneVaultSetup } from "./MyneVaultSetup";
import { BODY_STYLE, FOOTER_STYLE } from "./modalChrome";
import { runMyneVaultImport, type MyneImportExtras } from "./myneRun";
import { createVaultOnlyPorts } from "./ports";
import {
  asVaultUnlockError,
  importSourceClose,
  importSourceOpen,
} from "../../lib/import-source-vault";
import { activeVaultId } from "../../lib/vault-list";
import type { TFunction } from "i18next";
import {
  pickDirectory,
  pickFileAsTree,
  type PickedTree,
} from "../../platform/filePicker";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useOverlayInert } from "../../hooks/useOverlayInert";
import { copyText } from "../../lib/clipboard";
import { writeText as clipboardWriteText } from "../../platform/clipboardManager";
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
  // The rest of the page goes INERT while this is open (myne-md/myne#728).
  // The focus trap above contains Tab; it does not stop a screen reader's
  // virtual cursor reading the page behind, and `aria-modal` is an assertion
  // some assistive technology ignores. Registered on the BACKDROP, which is
  // the whole overlay: registering the card would inert the backdrop it is in.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, open);
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
    // Cleared alongside `result`, and for the same reason: these rows render
    // on the summary, so a set left over from a previous run claims things
    // about a run that did not happen. Reachable today: a Myne import, then an
    // Obsidian one, rendered the Myne block with the earlier run's numbers.
    setMyneExtras(null);
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
  // The vault being imported INTO. Read once when the modal opens, so the
  // source list can exclude it: a vault cannot be its own import source.
  const [activeVault, setActiveVault] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void activeVaultId().then((id) => {
      if (live) setActiveVault(id);
    });
    return () => {
      live = false;
    };
  }, [open]);

  /** Myne-source-only report rows. Absent for every other source. */
  const [myneExtras, setMyneExtras] = useState<MyneImportExtras | null>(null);

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

  /**
   * Run a Myne vault import.
   *
   * This function OWNS the close, and that is deliberate: the setup step opened
   * the slot, but every exit path from here (success, failure, cancel) is this
   * function's, and a close split across two owners is a close that gets skipped
   * on one of them. The `finally` is the whole mechanism.
   */
  // A retryable credential message shown ON the setup step. Cleared on every
  // fresh submission, so a corrected password does not sit under the old error.
  const [setupError, setSetupError] = useState<string | null>(null);
  // The non-secret setup cells, held HERE so a retryable failure comes back to
  // them. `setPhase("running")` unmounts `MyneVaultSetup`, and the retryable arm
  // mounts a fresh one, so without this every cell resets on the single likeliest
  // failure of this flow (a mistyped source password) and the 20-line comment
  // justifying that arm describes the outcome it produces. The password and the
  // phrase are deliberately NOT here: they stay local to the setup step and die
  // with its unmount.
  const [setupCells, setSetupCells] = useState<{
    chosen: string;
    label: string;
    kind: "password" | "phrase";
  } | null>(null);

  const startMyneImport = useCallback(
    ({
      sourceVaultId,
      importLabel,
      credential,
    }: {
      sourceVaultId: string;
      importLabel: string;
      credential: { password: string } | { recoveryPhrase: string };
    }) => {
      cancelRef.current = false;
      setCancelling(false);
      setSetupError(null);
      // Remember the non-secret cells BEFORE the unmount, so the retryable arm
      // below comes back to a filled form rather than an empty one.
      setSetupCells({
        chosen: sourceVaultId,
        label: importLabel,
        kind: "password" in credential ? "password" : "phrase",
      });
      setProgress({ done: 0, total: 0 });
      setPhase("running");
      void (async () => {
        try {
          // The OPEN happens HERE, inside the same try/finally as the close.
          // It used to happen in the credential step, which left an
          // Argon2id-long gap in which that subtree could be unmounted by Esc
          // or a backdrop click: the derivation still landed, a second vault's
          // root_key and items_key sat resident until the 30-minute TTL swept
          // them, and the import then ran headless behind a closed modal. One
          // owner for the whole slot lifetime makes that unrepresentable.
          await importSourceOpen(sourceVaultId, credential);
          const out = await runMyneVaultImport(
            sourceVaultId,
            policy,
            createVaultOnlyPorts(),
            {
              importLabel,
              onProgress: (done: number, total: number) =>
                setProgress({ done, total }),
              shouldCancel: () => cancelRef.current,
            },
          );
          setMyneExtras(out.extras);
          setResult(out.result);
          setPhase("summary");
          onImported?.(out.result);
        } catch (err) {
          // The credential errors are this function's now that it owns the
          // open, and they are the ones a user can actually act on: a wrong
          // password, a vault already open for another import, or the shared
          // Argon2id permit being held.
          //
          // All three go BACK TO THE SETUP STEP with the message inline, not to
          // the terminal error phase. Two reasons, and the second is the worse
          // one. A mistyped password is the single likeliest outcome of this
          // flow, and dropping the user out of it means re-choosing the vault,
          // re-typing the label and re-opening the modal to fix one character.
          // And the error phase's copy says "Any notes already imported were
          // kept", which for a credential rejection is FALSE: the open failed,
          // so the run never started and nothing was imported. A screen that
          // tells a user their notes are half-imported when they are not is
          // worse than a screen that is merely inconvenient.
          //
          // Everything else is a real import failure and keeps the terminal
          // phase, where that sentence is true.
          const kind = asVaultUnlockError(err)?.kind;
          const retryable =
            kind === "InvalidCredentialOrVault"
              ? t("notes.import.myne.errors.credential")
              : kind === "UnlockInProgress"
                ? t("notes.import.myne.errors.busy")
                : kind === "VaultOpenAsImportSource"
                  ? t("notes.import.myne.errors.alreadyOpen")
                  : null;
          if (retryable !== null) {
            setSetupError(retryable);
            setPhase("setup");
          } else {
            setErrorMsg(t(importFailureReasonKey(importFailureReason(err))));
            setPhase("error");
            onImported?.(null);
          }
        } finally {
          // Idempotent on the host side, so calling it on a path where the slot
          // is already gone (a TTL expiry, a vault lock underneath the run) is a
          // no-op rather than a second error to handle.
          //
          // Its OWN try/catch, and not because a failure here is unimportant.
          // `finally` runs on the success path too, so an `await` that rejects
          // here rejects the whole IIFE, which is `void`-ed: an unhandled
          // promise rejection, after the user has already been shown a completed
          // import, with a second vault's `root_key` and `items_key` still
          // resident. Catching it is what keeps the failure inside this
          // function; what actually bounds the exposure is the pair of
          // reclaimers that do not depend on this call landing at all, the
          // 30-minute TTL swept by the idle timer and `close_all` on every
          // teardown path of the target vault. That is why there is no retry
          // loop here: a second attempt would fail for the same reason and the
          // real backstop is host-side.
          try {
            await importSourceClose(sourceVaultId);
          } catch {
            // Deliberately silent to the USER: they cannot act on it, and the
            // window is already bounded above. Not silent to the developer.
            console.warn("import source close failed; TTL and lock will reclaim");
          }
        }
      })();
    },
    [policy, onImported, t],
  );

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
      ref={backdropRef}
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

        {phase === "setup" && spec.pick === "vault" && (
          // The Myne source picks a VAULT, not a path, so it gets its own setup
          // step: a list of the user's other local vaults, a credential for the
          // chosen one, and the import label. `SetupBody` below is built around
          // a picked folder and has nothing to show here.
          <MyneVaultSetup
            activeVaultId={activeVault}
            onReady={startMyneImport}
            onCancel={handleClose}
            onBack={initialSource === undefined ? () => setPhase("pick") : undefined}
            error={setupError}
            initialChosen={setupCells?.chosen}
            initialLabel={setupCells?.label}
            initialKind={setupCells?.kind}
          />
        )}
        {phase === "setup" && spec.pick !== "vault" && (
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
          <SummaryBody
            result={result}
            myneExtras={myneExtras}
            onDone={handleClose}
          />
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

function SummaryBody({
  result,
  myneExtras,
  onDone,
}: {
  result: ImportResult;
  /** Myne-source-only rows. `null` for every other source. */
  myneExtras?: MyneImportExtras | null;
  onDone: () => void;
}) {
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
          {myneExtras != null && (
            <>
              {/* Every class that did NOT cross gets a count, so the gap is
                  stated here rather than discovered later in the vault. */}
              <StatRow
                label={t("notes.import.myne.report.linksRetargeted")}
                value={myneExtras.linksRetargeted}
              />
              {/* The residual, and it is on screen because the feature's own
                  copy calls it the highest-risk behaviour and says silent is
                  not an option. It was computed, carried through the cancelled
                  path deliberately, and rendered nowhere: no locale key, no
                  StatRow, no test. On a cancelled run SYNC-6 keeps the partial
                  result, so notes really are in the vault carrying links that
                  will not open, and nothing said so. */}
              <StatRow
                label={t("notes.import.myne.report.linksLeftUnresolved")}
                value={myneExtras.linksLeftUnresolved}
                muted
              />
              <StatRow
                label={t("notes.import.myne.report.attachmentsCrossed")}
                value={myneExtras.attachmentsCrossed}
              />
              <StatRow
                label={t("notes.import.myne.report.attachmentsDeduped")}
                value={myneExtras.attachmentsDeduped}
                muted
              />
              <StatRow
                label={t("notes.import.myne.report.attachmentsFailed")}
                value={myneExtras.attachmentsFailed}
                muted
              />
              <StatRow
                label={t("notes.import.myne.report.tombstonedEmbeds")}
                value={myneExtras.tombstonedEmbeds}
                muted
              />
              <StatRow
                label={t("notes.import.myne.report.untitledImported")}
                value={myneExtras.untitledImported}
                muted
              />
              <StatRow
                label={t("notes.import.myne.report.trashedLeftBehind")}
                value={myneExtras.trashedLeftBehind}
                muted
              />
              <StatRow
                label={t("notes.import.myne.report.templatesLeftBehind")}
                value={myneExtras.templatesLeftBehind}
                muted
              />
              <StatRow
                label={t("notes.import.myne.report.dictionaryWordsAdded")}
                value={myneExtras.dictionaryWordsAdded}
                muted
              />
              {myneExtras.dictionaryUnreadable && (
                // "There was nothing to bring" and "we could not look" are
                // different facts, and only the second is worth saying out loud.
                <p
                  style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}
                  data-testid="import-myne.dictionary-unreadable"
                >
                  {t("notes.import.myne.report.dictionaryUnreadable")}
                </p>
              )}
              {/* The two sentences the completion step owes, and the reason it
                  owes them: a user who has just "consolidated" two vaults has a
                  model of what happened, and without these it does not match.
                  Version history stayed behind, and the source vault is
                  untouched and still syncing. No destructive action is offered
                  here: this is exactly the moment a user should not be one
                  click from deleting the original. */}
              <p
                style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}
                data-testid="import-myne.history-stays"
              >
                {t("notes.import.myne.done.historyStays")}
              </p>
              <p
                style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}
                data-testid="import-myne.source-unchanged"
              >
                {t("notes.import.myne.done.sourceUnchanged")}
              </p>
            </>
          )}
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
          {/* myne-md/myne#613: shown only when the reserved byte budget refused
              some of the folders this import created. Silence here would mean
              the user learns about it weeks later, when a folder they emptied
              disappears. Warning-coloured like the cancelled row, because it is
              the same class of fact: the import succeeded, and part of what was
              asked for did not land. */}
          {result.foldersNotPreserved > 0 && (
            <StatRow
              label={t("notes.import.modal.statFoldersNotKept")}
              valueNode={
                <span style={{ fontSize: "var(--text-sm)", color: "var(--warning)" }}>
                  {t("notes.import.modal.foldersNotKeptNote", { count: result.foldersNotPreserved })}
                </span>
              }
            />
          )}
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
        <Button variant="primary" onClick={onDone} data-testid="import.done">
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
 * level would capture the boot language (`src/AGENTS.md`).
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
    // TRANSPORT MIGRATION ONLY (myne-md/myne#390): the pair states today's
    // behaviour, a label swap on success and nothing on refusal. The failure
    // reason is the one that was already written here, kept verbatim.
    void copyText(clipboardWriteText, draft, {
      onSuccess: { kind: "inline", run: () => setCopied(true) },
      onFailure: { kind: "silent", reason: "clipboard unavailable, the field is still selectable" },
    });
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
