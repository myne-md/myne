// Settings shell — modal overlay mounted from `Editor.tsx` when the
// gear button or Cmd+, / Ctrl+, fires. Body is a 2-column flex row:
// left rail (panel chooser) + right content area. Panel rail items are
// focusable buttons; arrow keys ↑/↓ cycle through them, click sets the
// active panel. Account is selected by default.
//
// Design canon: Penpot `🔴 screen------settings--account` (page
// "4 — Desktop UI Kit", `flow--settings` board, frame id
// `9fb59646-2811-8082-8007-fd09e656a37a`).
//
// Carve-out: `decisions.md` 2026-05-08 "Desktop modal carve-out +
// Settings 5-panel taxonomy + disabled-control discipline".
//
// In-flight gating: the AccountPanel raises `childInFlight` during the
// change-password Argon2id window so Esc / backdrop / × all become
// no-ops. The user must wait for the backend response before the modal
// becomes dismissable again.

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
import { Icon } from "./primitives/Icon";
import { AboutPanel } from "./settings/AboutPanel";
import { AccountPanel } from "./settings/AccountPanel";
import { AppearancePanel } from "./settings/AppearancePanel";
import { EditorPanel } from "./settings/EditorPanel";
import { HotkeysPanel } from "./settings/HotkeysPanel";
import { PrivacyPanel } from "./settings/PrivacyPanel";
import { StoragePanel } from "./settings/StoragePanel";
import type { StageVaultStatus, SuspicionReason } from "../lib/stage";

/**
 * Six-panel taxonomy. The Editor panel was added (and Appearance scoped down
 * to purely-visual controls) by the `decisions.md` entry superseding the
 * 2026-05-08 5-panel lock.
 */
type PanelId =
  | "account"
  | "privacy"
  | "editor"
  | "hotkeys"
  | "appearance"
  | "storage"
  | "about";

interface PanelMeta {
  id: PanelId;
  /** i18n leaf under `settings.shell.panels.*` — resolved at render time so a
   *  language switch re-labels the rail (never frozen at module load). */
  labelKey: string;
}

const PANELS: readonly PanelMeta[] = [
  { id: "account", labelKey: "settings.shell.panels.account" },
  { id: "privacy", labelKey: "settings.shell.panels.privacy" },
  { id: "editor", labelKey: "settings.shell.panels.editor" },
  { id: "hotkeys", labelKey: "settings.shell.panels.hotkeys" },
  { id: "appearance", labelKey: "settings.shell.panels.appearance" },
  { id: "storage", labelKey: "settings.shell.panels.storage" },
  { id: "about", labelKey: "settings.shell.panels.about" },
];

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Storage → "Back up vault…" (MYND-56): closes Settings, opens the
   *  export progress modal (engine MYND-32). */
  onBackupVault?: () => void;
  /** Storage → "Restore from backup…" (MYND-56): closes Settings and
   *  routes into the pre-unlock-class restore Stage flow (MYND-218). */
  onRestoreBackup?: () => void;
  /** Storage → Export block "Export…" (MYND-211): closes Settings, opens
   *  the whole-vault markdown export modal at the Editor level. */
  onExportVault?: () => void;
  /**
   * Show a transient post-event toast at the parent's notification
   * surface (Editor's Toast component). Used by AccountPanel after a
   * successful change-password.
   */
  onShowToast?: (message: string) => void;
  /**
   * Out-of-band Stage set used by descendant flows that need to bypass
   * the `transition()` reducer with a fully-known target stage.
   * Threaded from Editor (which receives it from App.tsx's
   * `setStageWithSuspicion` callback). AccountPanel's change-password
   * force-relock arm dispatches this for `InvalidVaultMeta` /
   * `VaultMetaChangedExternally` / `VaultLockedDuringChange`.
   */
  onForceRelock?: (status: StageVaultStatus, reason?: SuspicionReason) => void;
  /**
   * Fired by AccountPanel after a successful `vault_delete` IPC OR
   * after the user clicks Continue on the post-fail banner. Threaded
   * from Editor → App.tsx, where it dispatches
   * `editor.delete-vault-success` to transition Stage to welcome.
   * Editor unmounts; this modal unmounts in cascade. No
   * `onClose()` call needed here — the unmount cascade closes us.
   */
  onDeleteVaultSuccess: () => void;
  /**
   * Open the Obsidian vault import flow (MYND-53). Threaded from Editor →
   * StoragePanel's "Import Obsidian vault…" control; the handler closes Settings
   * and opens the importer modal at the Editor level.
   */
  onImportObsidian?: () => void;
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

const MODAL_STYLE: CSSProperties = {
  width: 720,
  maxWidth: "calc(100vw - var(--space-7))",
  height: 600,
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
};

const HEADER_STYLE: CSSProperties = {
  height: 56,
  padding: "0 var(--space-5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  borderBottom: "1px solid var(--line-1)",
  flex: "0 0 auto",
};

const TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-xl)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "var(--tracking-tight)",
  color: "var(--fg-1)",
  margin: 0,
};

const CLOSE_BUTTON_STYLE: CSSProperties = {
  background: "none",
  border: 0,
  color: "var(--fg-3)",
  cursor: "pointer",
  padding: 6,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "var(--radius-1)",
};

const BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "row",
};

const RAIL_STYLE: CSSProperties = {
  width: 220,
  flex: "0 0 auto",
  background: "var(--paper-2)",
  borderRight: "1px solid var(--line-1)",
  padding: "var(--space-3) 0",
  display: "flex",
  flexDirection: "column",
  gap: 0,
};

const RAIL_ITEM_BASE_STYLE: CSSProperties = {
  width: "100%",
  height: 40,
  padding: "0 var(--space-5)",
  border: 0,
  background: "transparent",
  textAlign: "left",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
};

const RAIL_ITEM_SELECTED_STYLE: CSSProperties = {
  ...RAIL_ITEM_BASE_STYLE,
  background: "var(--paper-3)",
  color: "var(--fg-1)",
};

const CONTENT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--bg-2)",
  padding: "var(--space-5) var(--space-6)",
  overflow: "auto",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "flex-start",
};

export function SettingsModal({
  open,
  onClose,
  onBackupVault,
  onRestoreBackup,
  onExportVault,
  onShowToast,
  onForceRelock,
  onDeleteVaultSuccess,
  onImportObsidian,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<PanelId>("account");
  const [childInFlight, setChildInFlight] = useState(false);
  const itemRefs = useRef<Record<PanelId, HTMLButtonElement | null>>({
    account: null,
    privacy: null,
    editor: null,
    hotkeys: null,
    appearance: null,
    storage: null,
    about: null,
  });

  // Refs so the keydown handler reads current values without re-
  // registering the global listener on every selection or in-flight
  // change.
  const selectedRef = useRef(selected);
  const childInFlightRef = useRef(childInFlight);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    childInFlightRef.current = childInFlight;
  }, [childInFlight]);

  // Esc dismisses + ArrowUp/ArrowDown cycle the rail. Listener mounts
  // once per `open` flip; reads selected/childInFlight from refs.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (childInFlightRef.current) return;
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = PANELS.findIndex((p) => p.id === selectedRef.current);
        const next =
          e.key === "ArrowDown"
            ? (idx + 1) % PANELS.length
            : (idx - 1 + PANELS.length) % PANELS.length;
        const nextId = PANELS[next].id;
        setSelected(nextId);
        itemRefs.current[nextId]?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (childInFlight) return;
      if (e.target === e.currentTarget) onClose();
    },
    [onClose, childInFlight],
  );

  if (!open) return null;

  const panelContent: Record<PanelId, ReactNode> = {
    account: (
      <AccountPanel
        onChangePasswordSuccess={() => {
          onShowToast?.(t("settings.shell.passwordUpdatedToast"));
          onClose();
        }}
        onDeleteVaultSuccess={onDeleteVaultSuccess}
        onInFlightChange={setChildInFlight}
        onForceRelock={onForceRelock}
      />
    ),
    privacy: <PrivacyPanel onShowToast={onShowToast} />,
    editor: <EditorPanel />,
    hotkeys: <HotkeysPanel />,
    appearance: <AppearancePanel />,
    storage: (
      <StoragePanel
        onImportObsidian={onImportObsidian}
        onBackupVault={onBackupVault}
        onRestoreBackup={onRestoreBackup}
        onExportVault={onExportVault}
        onShowToast={onShowToast}
      />
    ),
    about: <AboutPanel />,
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      data-testid="settings.modal"
      style={BACKDROP_STYLE}
      onClick={handleBackdropClick}
    >
      <div style={MODAL_STYLE} onClick={(e) => e.stopPropagation()}>
        <div style={HEADER_STYLE}>
          <h2 id="settings-modal-title" style={TITLE_STYLE}>
            {t("settings.shell.title")}
          </h2>
          <button
            type="button"
            aria-label={t("settings.shell.closeLabel")}
            data-testid="settings.close"
            onClick={onClose}
            disabled={childInFlight}
            style={{
              ...CLOSE_BUTTON_STYLE,
              cursor: childInFlight ? "default" : "pointer",
              opacity: childInFlight ? 0.5 : 1,
            }}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div style={BODY_STYLE}>
          <nav
            aria-label={t("settings.shell.navLabel")}
            role="tablist"
            aria-orientation="vertical"
            style={RAIL_STYLE}
          >
            {PANELS.map((panel) => {
              const isSelected = panel.id === selected;
              return (
                <button
                  key={panel.id}
                  ref={(el) => {
                    itemRefs.current[panel.id] = el;
                  }}
                  type="button"
                  role="tab"
                  data-testid={`settings.tab-${panel.id}`}
                  aria-selected={isSelected}
                  aria-controls={`settings-panel-${panel.id}`}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => {
                    if (panel.id !== selected) setSelected(panel.id);
                  }}
                  style={
                    isSelected ? RAIL_ITEM_SELECTED_STYLE : RAIL_ITEM_BASE_STYLE
                  }
                >
                  {t(panel.labelKey)}
                </button>
              );
            })}
          </nav>

          <div
            role="tabpanel"
            id={`settings-panel-${selected}`}
            aria-labelledby={`settings-panel-${selected}-tab`}
            style={CONTENT_STYLE}
          >
            {panelContent[selected]}
          </div>
        </div>
      </div>
    </div>
  );
}
