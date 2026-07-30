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
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./primitives/Icon";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { SettingsSearch } from "./settings/search/SettingsSearch";
import { SettingsSearchResults } from "./settings/search/SettingsSearchResults";
import { searchSettings } from "./settings/search/searchSettings";
import {
  flattenGroups,
  groupResultsByPanel,
} from "./settings/search/resultsGrouping";
import type { SettingsIndexEntry } from "./settings/search/settingsSearchIndex";
import { AboutPanel } from "./settings/AboutPanel";
import { AccountPanel } from "./settings/AccountPanel";
import * as capabilities from "../platform/capabilities";
import { AiPanel } from "./settings/AiPanel";
import { BetaBadge } from "./settings/BetaBadge";
import { AppearancePanel } from "./settings/AppearancePanel";
import { EditorPanel } from "./settings/EditorPanel";
import { FilesPanel } from "./settings/FilesPanel";
import { HotkeysPanel } from "./settings/HotkeysPanel";
import { PrivacyPanel } from "./settings/PrivacyPanel";
import { StoragePanel } from "./settings/StoragePanel";
import { SyncPanel } from "./settings/SyncPanel";
import type { StageVaultStatus, SuspicionReason } from "../lib/stage";

/**
 * Panel taxonomy. The Editor panel was added (and Appearance scoped down to
 * purely-visual controls) by the `decisions.md` entry superseding the
 * 2026-05-08 5-panel lock; the Files panel (note-storage + startup behaviour,
 * MYND-462) was added by a further superseding `decisions.md` entry.
 */
export type PanelId =
  | "account"
  | "privacy"
  | "sync"
  | "ai"
  | "editor"
  | "files"
  | "hotkeys"
  | "appearance"
  | "storage"
  | "about";

/** Rail sections. `core` is the standard settings set; `labs` groups
 *  experimental / beta features under a divider header (local-ai epic
 *  MYND-408). Ordering below places every `core` panel before the single
 *  `labs` panel so the divider renders once at the boundary. */
type PanelGroup = "core" | "labs";

interface PanelMeta {
  id: PanelId;
  /** i18n leaf under `settings.shell.panels.*` — resolved at render time so a
   *  language switch re-labels the rail (never frozen at module load). */
  labelKey: string;
  /** Rail section. Omitted → `core`. */
  group?: PanelGroup;
  /** Render a small "Beta" badge next to the rail label. */
  beta?: boolean;
}

// `ai` sits LAST, in the `labs` group: it ships in the default build but is a
// runtime beta opt-in (decisions.md 2026-07-02). Keeping PANELS a single flat
// array preserves the ArrowUp/ArrowDown cycle + `itemRefs` logic unchanged — the
// Labs divider is a non-focusable presentation row inserted at the group edge.
//
// **Capability gating (MYND-574 task 27).** `ai` is absent on web — the on-device
// LLM needs multi-GiB weights and a CPU thread pool, neither of which a Worker
// has. It is filtered OUT of the rail rather than rendered disabled: a greyed
// panel is an offer the platform cannot honour, and `decisions.md` 2026-07-26
// makes omission normative rather than a UX preference.
//
// Filtering the ARRAY (rather than hiding a row at render time) is what keeps
// the ArrowUp/ArrowDown cycle and `itemRefs` correct: a hidden-but-present entry
// would still be a keyboard stop, which is exactly the "unreachable by menu,
// reachable by shortcut" gap this task exists to close.
const PANELS: readonly PanelMeta[] = (
  [
  { id: "account", labelKey: "settings.shell.panels.account" },
  { id: "privacy", labelKey: "settings.shell.panels.privacy" },
  { id: "sync", labelKey: "settings.shell.panels.sync" },
  { id: "editor", labelKey: "settings.shell.panels.editor" },
  { id: "files", labelKey: "settings.shell.panels.files" },
  { id: "hotkeys", labelKey: "settings.shell.panels.hotkeys" },
  { id: "appearance", labelKey: "settings.shell.panels.appearance" },
  { id: "storage", labelKey: "settings.shell.panels.storage" },
  { id: "about", labelKey: "settings.shell.panels.about" },
  { id: "ai", labelKey: "settings.shell.panels.ai", group: "labs", beta: true },
  ] as const satisfies readonly PanelMeta[]
).filter((p) => p.id !== "ai" || capabilities.has("localAi"));

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
   * from Editor → App.tsx, where it triggers a `reprobe()`; boot
   * routing then selects the return surface by remaining vault count
   * (picker at ≥2, unlock at 1, welcome at 0). Editor unmounts; this
   * modal unmounts in cascade. No `onClose()` call needed here — the
   * unmount cascade closes us.
   */
  onDeleteVaultSuccess: () => void;
  /**
   * Open the Obsidian vault import flow (MYND-53). Threaded from Editor →
   * StoragePanel's "Import Obsidian vault…" control; the handler closes Settings
   * and opens the importer modal at the Editor level.
   */
  onImportObsidian?: () => void;
  /**
   * Open the graph tab (MYND-635). Threaded from Editor → AppearancePanel's
   * pointer row; the handler closes Settings and opens the graph, whose own
   * floating panel holds the graph appearance + physics controls.
   */
  onOpenGraph?: () => void;
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

// The rail is a column: the search box sits at the top (MYND-536), the panel
// tab list below it.
const RAIL_STYLE: CSSProperties = {
  width: 220,
  flex: "0 0 auto",
  background: "var(--paper-2)",
  borderRight: "1px solid var(--line-1)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

// The tab list, beneath the search box. Scrolls independently if the panel set
// ever outgrows the rail height.
const RAIL_NAV_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 0,
  padding: "var(--space-3) 0",
  overflowY: "auto",
  flex: 1,
  minHeight: 0,
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

// Non-focusable divider heading that opens the Labs section in the rail. Not a
// tab (no `role="tab"`, absent from `itemRefs`), so ↑/↓ tab cycling skips it.
const RAIL_GROUP_HEADER_STYLE: CSSProperties = {
  padding: "var(--space-4) var(--space-5) var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
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
  onOpenGraph,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<PanelId>("account");
  const [childInFlight, setChildInFlight] = useState(false);
  // Settings search (MYND-536). A non-empty query swaps the content pane from
  // the active panel to a flat, panel-grouped results list built off the static
  // search index — so filtering never mounts the other nine panels.
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // The setting to scroll to + flash once the target panel has mounted (a result
  // was selected). Held across the panel switch; consumed by the effect below.
  const [pendingScroll, setPendingScroll] = useState<SettingsIndexEntry | null>(
    null,
  );
  const searching = query.trim() !== "";
  // Order the matches into the SAME panel-clustered sequence the results list
  // renders (group-then-flatten). The scorer (fuzzyFilter, via searchSettings)
  // orders by relevance, NOT by panel, so its raw output can interleave panels;
  // the rendered list re-groups by panel. Aligning both here means keyboard ↑/↓
  // over `results[activeIndex]` walks the rows in the exact on-screen order
  // instead of jumping between panel groups. MYND-536.
  const results = useMemo(
    () =>
      searching
        ? flattenGroups(groupResultsByPanel(searchSettings(query, t)))
        : [],
    [searching, query, t],
  );
  // Keyboard-highlighted result (arrow keys move it; Enter opens it). Reset to
  // the top whenever the query changes so the highlight never points past the
  // new result set.
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  useEffect(() => {
    setActiveResultIndex(0);
  }, [query]);
  const activeIndex =
    results.length > 0 ? Math.min(activeResultIndex, results.length - 1) : 0;
  const activeId = searching ? results[activeIndex]?.id : undefined;
  // Carve-out modal: trap focus directly (not via ModalShell, which would
  // strip the rail's arrow-key nav + in-flight dismiss gating). MYND-93.
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, { enabled: open });
  const itemRefs = useRef<Record<PanelId, HTMLButtonElement | null>>({
    account: null,
    privacy: null,
    sync: null,
    ai: null,
    editor: null,
    files: null,
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
  const queryRef = useRef(query);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    childInFlightRef.current = childInFlight;
  }, [childInFlight]);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // Global modal keys (MYND-536 extends the original rail nav):
  //   "/"          → focus the search box (unless already typing in a field)
  //   Escape       → clear an active query first, else close (in-flight gated)
  //   ↑/↓          → cycle the rail, BUT only when not searching / not in the
  //                  search box (there, arrows drive the results list — handled
  //                  on the input via `onSearchKeyDown`)
  // Listener mounts once per `open` flip; reads live values from refs.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const inSearchBox = activeEl === searchInputRef.current;
      const inTextField =
        activeEl instanceof HTMLElement &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.isContentEditable);

      if (e.key === "/" && !inTextField) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        if (childInFlightRef.current) return;
        // Clear an active query first; only dismiss when nothing to clear.
        if (queryRef.current.trim() !== "") {
          setQuery("");
          return;
        }
        onClose();
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // While searching or focused in the box, the results list owns arrows.
        if (queryRef.current.trim() !== "" || inSearchBox) return;
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

  // Selecting a result jumps to the owning panel, clears the query (so the
  // content pane returns to the panel view), and arms the scroll+flash of the
  // target setting for after the panel mounts.
  const handleSelectResult = useCallback((entry: SettingsIndexEntry) => {
    setSelected(entry.panelId);
    setPendingScroll(entry);
    setQuery("");
  }, []);

  // Arrow/Enter navigation over the results, handled on the search input (which
  // holds focus while the user types + navigates). Escape is left to the global
  // handler above so its clear-then-close semantics stay in one place.
  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!searching || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveResultIndex((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveResultIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      const entry = results[activeIndex];
      if (entry) {
        e.preventDefault();
        handleSelectResult(entry);
      }
    }
  };

  // Once the query is cleared and the target panel is rendered, scroll the
  // setting into view and flash it. The target is located by
  // `data-setting-anchor` (its registry id), falling back to a registered
  // `data-testid`; a rAF lets the just-mounted panel lay out first. If the
  // anchor is absent the jump degrades to a plain panel switch (already done).
  useEffect(() => {
    if (!pendingScroll || searching) return;
    const target = pendingScroll;
    const raf = requestAnimationFrame(() => {
      const root = contentRef.current;
      if (root) {
        let el = root.querySelector<HTMLElement>(
          `[data-setting-anchor="${target.id}"]`,
        );
        if (!el && target.testid) {
          el = root.querySelector<HTMLElement>(
            `[data-testid="${target.testid}"]`,
          );
        }
        if (el) {
          el.scrollIntoView({ block: "center" });
          el.setAttribute("data-setting-flash", "true");
          window.setTimeout(() => el?.removeAttribute("data-setting-flash"), 1200);
        }
      }
      setPendingScroll(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingScroll, searching, selected]);

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
    sync: <SyncPanel />,
    ai: <AiPanel onShowToast={onShowToast} />,
    editor: <EditorPanel />,
    files: <FilesPanel />,
    hotkeys: <HotkeysPanel />,
    appearance: <AppearancePanel onOpenGraph={onOpenGraph} />,
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
      <div
        ref={modalRef}
        style={MODAL_STYLE}
        onClick={(e) => e.stopPropagation()}
      >
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
          <div style={RAIL_STYLE}>
            <SettingsSearch
              ref={searchInputRef}
              query={query}
              onQueryChange={setQuery}
              onKeyDown={onSearchKeyDown}
              activeDescendantId={
                activeId ? `settings-search-result-${activeId}` : undefined
              }
            />
            <nav
              aria-label={t("settings.shell.navLabel")}
              role="tablist"
              aria-orientation="vertical"
              style={RAIL_NAV_STYLE}
            >
              {PANELS.map((panel, i) => {
              const isSelected = panel.id === selected;
              // Insert the Labs divider once, at the core→labs boundary.
              const opensLabs =
                panel.group === "labs" &&
                (i === 0 || PANELS[i - 1].group !== "labs");
              return (
                <Fragment key={panel.id}>
                  {opensLabs && (
                    <div
                      role="presentation"
                      data-testid="settings.labs-group"
                      style={RAIL_GROUP_HEADER_STYLE}
                    >
                      {t("settings.shell.groups.labs")}
                    </div>
                  )}
                  <button
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
                      // Clicking a rail tab exits search back to the panel view.
                      setQuery("");
                      if (panel.id !== selected) setSelected(panel.id);
                    }}
                    style={
                      isSelected ? RAIL_ITEM_SELECTED_STYLE : RAIL_ITEM_BASE_STYLE
                    }
                  >
                    {t(panel.labelKey)}
                    {panel.beta && <BetaBadge testId="settings.rail-ai-beta" />}
                  </button>
                </Fragment>
              );
              })}
            </nav>
          </div>

          <div
            ref={contentRef}
            role="tabpanel"
            id={`settings-panel-${selected}`}
            aria-labelledby={`settings-panel-${selected}-tab`}
            style={CONTENT_STYLE}
          >
            {searching ? (
              <SettingsSearchResults
                results={results}
                query={query}
                activeId={activeId}
                onSelect={handleSelectResult}
              />
            ) : (
              panelContent[selected]
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
