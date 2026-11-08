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
// In-flight gating: the VaultPanel raises `childInFlight` during the
// change-password Argon2id window so Esc / backdrop / × all become
// no-ops. The user must wait for the backend response before the modal
// becomes dismissable again.
//
// Child-dialog gating: a panel that puts a surface of its own on screen (the AI
// provider consent, the beta terms, the Appearance accent picker) raises
// `childDialogOpen`. This shell listens for Esc on `window` and each child
// listens on `window` or `document`; none of them stops propagation, so ungated
// one press would close the child AND this modal under it. It gates Esc and the
// backdrop only —
// NOT the × the way `childInFlight` does, because the child's own backdrop
// already covers the header and a greyed close button would be claiming a
// restriction that isn't one.

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
import {
  HOVER_TRANSITION,
} from "./primitives/hoverSurface";
import { interactiveSurface } from "./primitives/interactiveSurface";
import type { IconName } from "../lib/icons";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useOverlayInert } from "../hooks/useOverlayInert";
import { SettingsSearch } from "./settings/search/SettingsSearch";
import { SettingsSearchResults } from "./settings/search/SettingsSearchResults";
import { searchSettings } from "./settings/search/searchSettings";
import {
  flattenGroups,
  groupResultsByPanel,
} from "./settings/search/resultsGrouping";
import {
  SETTINGS_SEARCH_INDEX,
  type SettingsIndexEntry,
} from "./settings/search/settingsSearchIndex";
import {
  SettingsCompactContext,
  useSettingsCompactObserver,
} from "./settings/settingsCompact";
import {
  SettingsTabs,
  setActiveSettingsTopic,
  useActiveSettingsTopic,
} from "./settings/SettingsTabs";
import { livePanelTopics } from "./settings/settingsTopics";
import { AboutPanel } from "./settings/AboutPanel";
import { DiagnosticsPanel } from "./settings/DiagnosticsPanel";
import { AccountPanel } from "./settings/AccountPanel";
import { BrowserExtensionsPanel } from "./settings/BrowserExtensionsPanel";
import { VaultPanel } from "./settings/VaultPanel";
import * as capabilities from "../platform/capabilities";
import { AiPanel } from "./settings/AiPanel";
import { AppearancePanel } from "./settings/AppearancePanel";
import { CliPanel } from "./settings/CliPanel";
import { EditorPanel } from "./settings/EditorPanel";
import { FilesPanel } from "./settings/FilesPanel";
import { TranscriptionPanel } from "./settings/TranscriptionPanel";
import { HotkeysPanel } from "./settings/HotkeysPanel";
import { NetworkPanel } from "./settings/NetworkPanel";
import { PrivacyPanel } from "./settings/PrivacyPanel";
import { StoragePanel } from "./settings/StoragePanel";
import { SyncPanel } from "./settings/SyncPanel";
import { usePrefs } from "../hooks/usePrefs";
import { memberVaultStatus } from "../lib/personAccount";
import type { StageVaultStatus, SuspicionReason } from "../lib/stage";

/**
 * Panel taxonomy. The Editor panel was added (and Appearance scoped down to
 * purely-visual controls) by the `decisions.md` entry superseding the
 * 2026-05-08 5-panel lock; the Files panel (note-storage + startup behaviour,
 * MYND-462) was added by a further superseding `decisions.md` entry; the CLI
 * panel (`decisions/ui/0678`) by another, which is also what moved the
 * terminal-access block out of Privacy.
 */
export type PanelId =
  | "account"
  | "vault"
  | "privacy"
  | "sync"
  // The browser clipper's own surface, split out of Account on myne-md/myne#960.
  | "extensions"
  | "ai"
  | "network"
  | "cli"
  | "editor"
  | "files"
  | "transcription"
  | "hotkeys"
  | "appearance"
  | "storage"
  | "about"
  // The diagnostics surface, split out of About on 2026-10-25: "what is this build"
  // and "what is going wrong" are different questions asked at different moments.
  | "diagnostics";

/** Rail sections. `core` is the standard settings set; `developer` groups the
 *  panels that leave the path Myne vouches for, under a divider header
 *  (developer-mode feature, MYND-593 — supersedes the `labs` group). Ordering
 *  below places every `core` panel before the single `developer` panel so the
 *  divider renders once at the boundary. */
type PanelGroup = "core" | "developer";

interface PanelMeta {
  id: PanelId;
  /** i18n leaf under `settings.shell.panels.*` — resolved at render time so a
   *  language switch re-labels the rail (never frozen at module load). */
  labelKey: string;
  /** Leading rail glyph (MYND-206), Obsidian-style. A functional-icon name from
   *  `ICON_PATHS`; the AI panel uses `cpu` (on-device compute), never a
   *  sparkle/magic glyph — PRODUCT.md bans hype AI framing. */
  icon: IconName;
  /** Rail section. Omitted → `core`. */
  group?: PanelGroup;
  /** The capability this panel's contents need. Omitted → unconditional. An
   *  absent capability filters the panel OUT of the rail rather than greying
   *  it: a greyed panel is an offer the platform cannot honour. */
  capability?: capabilities.Capability;
}

// The `developer` group sits LAST: Developer mode is where the user leaves the
// path Myne vouches for (prd.md "Solution"), and its members are squarely that —
// local AI (user-supplied weights, an in-process runtime, no isolation
// guarantee yet), Tor routing (MYND-650: a bundled Tor client Myne does not
// operate, over a volunteer relay network nobody here controls), and terminal
// access (the `myne` sidecar opens the unlocked vault to any program running as
// the same OS user, with no identity gatekeeper in front of the socket).
// Keeping PANELS_BASE a single flat array preserves the ArrowUp/ArrowDown cycle
// + `itemRefs` logic unchanged — the Developer divider is a non-focusable
// presentation row inserted at the group edge.
//
// **Capability gating (MYND-574 task 27).** All three are absent on web: the
// on-device LLM needs multi-GiB weights and a CPU thread pool, Tor routing
// needs a subprocess and a raw socket, and terminal access needs a Unix socket
// no page can host — none of which a Worker has. They are
// filtered OUT of the rail rather than rendered disabled: a greyed panel is an
// offer the platform cannot honour, and `decisions.md` 2026-07-26 makes omission
// normative rather than a UX preference.
//
// **Developer-mode gating (MYND-593).** The whole group is ALSO filtered out
// whenever the `developer_mode` preference is off, for the same reason: its
// point is that its contents are things Myne does not vouch for, and the rail
// must not offer a door onto that unless the user has deliberately opened it in
// About. Both gates apply, neither substitutes for the other — a panel needs its
// capability AND (if it is in this group) the preference.
//
// Filtering the ARRAY (rather than hiding a row at render time) is what keeps
// the ArrowUp/ArrowDown cycle and `itemRefs` correct: a hidden-but-present entry
// would still be a keyboard stop, which is exactly the "unreachable by menu,
// reachable by shortcut" gap MYND-593 exists to close. Filtering every member of
// the group out also removes the group itself — the divider only renders when a
// panel in that group survives the filter, so "no Developer group" is derived
// rather than a second, separately-maintained condition (see the
// `opensDeveloper` computation in the render below).
const PANELS_BASE: readonly PanelMeta[] = [
  { id: "account", labelKey: "settings.shell.panels.account", icon: "id-card" },
  // The vault's own controls, split out of Account: the panel named after the
  // account held nothing but vault actions, and the account itself had no
  // surface after unlock. `key-round`: the vault is what this key opens.
  { id: "vault", labelKey: "settings.shell.panels.vault", icon: "key-round" },
  { id: "privacy", labelKey: "settings.shell.panels.privacy", icon: "lock" },
  { id: "sync", labelKey: "settings.shell.panels.sync", icon: "refresh-cw" },
  // The browser clipper, split out of Account (myne-md/myne#960). A capability
  // gate, not a developer gate: clipping pages is a normal user's feature, and
  // the web client cannot host a native-messaging endpoint at all, so the rail
  // omits the door rather than greying it (`decisions.md` 2026-07-26).
  {
    id: "extensions",
    labelKey: "settings.shell.panels.extensions",
    icon: "link",
    capability: "clipper",
  },
  { id: "editor", labelKey: "settings.shell.panels.editor", icon: "pencil" },
  { id: "files", labelKey: "settings.shell.panels.files", icon: "folder" },
  {
    id: "transcription",
    labelKey: "settings.shell.panels.transcription",
    icon: "mic",
  },
  { id: "hotkeys", labelKey: "settings.shell.panels.hotkeys", icon: "command" },
  {
    id: "appearance",
    labelKey: "settings.shell.panels.appearance",
    icon: "palette",
  },
  { id: "storage", labelKey: "settings.shell.panels.storage", icon: "hard-drive" },
  { id: "about", labelKey: "settings.shell.panels.about", icon: "info" },
  // After About and NOT in the developer group, deliberately: the gate hides
  // capabilities a normal user does not configure, and this is the front door of a
  // feature built for the user who has hit a bug (`DiagnosticsPanel`'s header).
  { id: "diagnostics", labelKey: "settings.shell.panels.diagnostics", icon: "circle-help" },
  {
    id: "ai",
    labelKey: "settings.shell.panels.ai",
    icon: "cpu",
    group: "developer",
    capability: "localAi",
  },
  {
    id: "network",
    labelKey: "settings.shell.panels.network",
    icon: "globe",
    group: "developer",
    capability: "torRouting",
  },
  {
    id: "cli",
    labelKey: "settings.shell.panels.cli",
    icon: "code",
    group: "developer",
    capability: "cliAccess",
  },
] as const satisfies readonly PanelMeta[];

interface SettingsModalProps {
  /**
   * The active vault's id, threaded from Editor (#250). `null` while a
   * post-reload editor is still resolving it. Panels that TARGET a vault (the
   * danger-zone delete, the automatic-backup schedule) take it from here rather
   * than re-deriving it from the best-effort last-unlock cache, which named the
   * wrong vault after a quick-unlock or a recovery.
   */
  vaultId: string | null;
  open: boolean;
  onClose: () => void;
  /**
   * Panel to select when the modal opens. Used by the left ribbon's
   * "Customize ribbon…" entry to land on Appearance. Absent means Account.
   * Re-applied on every open, so a gear reopen after a rail reopen starts from
   * this value again (or Account when undefined). */
  initialPanel?: PanelId;
  /**
   * A `SETTINGS_SEARCH_INDEX` id to scroll to and flash once that panel has
   * mounted — the same landing the settings SEARCH performs when a result is
   * picked, offered to the entry points that already know what they are for.
   *
   * Landing on the panel alone is not landing on the setting. "Customize
   * ribbon…" opened Appearance at the top and left the user to find the ribbon
   * block among nine others, which is the failure a deep link exists to
   * prevent; the machinery to finish the job was already here and had one
   * caller, the search box (myne-md/myne#773).
   *
   * An id nothing in the index carries is ignored, so this degrades to the
   * plain panel switch rather than throwing.
   */
  initialAnchor?: string;
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
   * surface (Editor's Toast component). Used by VaultPanel after a
   * successful change-password.
   */
  onShowToast?: (message: string) => void;
  /**
   * Out-of-band Stage set used by descendant flows that need to bypass
   * the `transition()` reducer with a fully-known target stage.
   * Threaded from Editor (which receives it from App.tsx's
   * `setStageWithSuspicion` callback). VaultPanel's change-password
   * force-relock arm dispatches this for `InvalidVaultMeta` /
   * `VaultMetaChangedExternally` / `VaultLockedDuringChange`.
   */
  onForceRelock?: (status: StageVaultStatus, reason?: SuspicionReason) => void;
  /**
   * Fired by VaultPanel after a successful `vault_delete` IPC OR
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
   * Open the graph tab (MYND-604). Threaded from Editor → AppearancePanel's
   * pointer row; the handler closes Settings and opens the graph, whose own
   * floating panel holds the graph appearance + physics controls.
   */
  onOpenGraph?: () => void;
}

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--scrim)",
  display: "flex",
  alignItems: "stretch",
  justifyContent: "center",
  // A padded, centred card (#206). The 48px top inset clears the macOS overlay
  // traffic lights (tauri.conf.json `trafficLightPosition` y:20) so the header
  // never collides with them; the side/bottom insets hold the card off the
  // window edges.
  padding: "48px 24px 24px",
  animation: "settings-backdrop-in var(--duration-fast) var(--ease-standard)",
  zIndex: 1000,
};

// The Settings modal is a SINGLE large card (#206) — a padded, centred surface
// that fills most of the window up to a capped width, not a windowed↔full
// toggle. The content INSIDE is width-capped and centred (`CONTENT_STYLE` +
// `CONTENT_INNER_STYLE`) so controls and the vault-icon grid keep a comfortable
// reading column instead of stretching.
const MODAL_STYLE: CSSProperties = {
  width: "100%",
  maxWidth: 1080,
  height: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-3)",
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-sans)",
  color: "var(--fg-1)",
  overflow: "hidden",
  animation: "settings-modal-in var(--duration-base) var(--ease-standard)",
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
  borderInlineEnd: "1px solid var(--line-1)",
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
  textAlign: "start",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  // Gap between the leading panel glyph (MYND-206) and its label.
  gap: "var(--space-3)",
  transition: HOVER_TRANSITION,
};

const RAIL_ITEM_SELECTED_STYLE: CSSProperties = {
  ...RAIL_ITEM_BASE_STYLE,
  background: "var(--paper-3)",
  color: "var(--fg-1)",
};

// Non-focusable divider heading that opens the Developer section in the rail.
// Not a tab (no `role="tab"`, absent from `itemRefs`), so ↑/↓ tab cycling
// skips it.
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
  minHeight: 0,
  padding: "var(--space-5) var(--space-6)",
  overflow: "auto",
  display: "flex",
  alignItems: "flex-start",
  // Centre the capped content column in the (now full-window) content area so
  // it reads as a deliberate column rather than hugging the left edge with a
  // huge empty gap on a wide screen (#206).
  justifyContent: "center",
};

// The content column: the in-panel topic strip (when the selected panel has one)
// above the scrolling pane. Split out of `CONTENT_STYLE` by myne-md/myne#885 so
// the strip can be the column's FIRST ROW - outside the scroll container, which
// is what keeps it in place while the panel scrolls and puts its bottom hairline
// on the line the rail's search row already draws.
const CONTENT_COLUMN_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-2)",
};

// Width cap for the panel content inside the full-window modal. Centred in the
// content area, it keeps inputs, buttons and the vault-icon grid at a
// comfortable reading width rather than stretching across the whole surface
// (#206 — the icon grid was the worst offender at full width).
const CONTENT_INNER_STYLE: CSSProperties = {
  width: "100%",
  maxWidth: 840,
};

export function SettingsModal({
  vaultId,
  open,
  onClose,
  initialPanel,
  initialAnchor,
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
  const { prefs } = usePrefs();
  // Whether the ACTIVE VAULT is a B2B member vault (myne-md/myne#885). The
  // settings search runs against the static registry, so it cannot see that the
  // shared-vault-unlock row renders only on a member vault. This is the runtime
  // per-vault fact the `memberVaultGated` gate needs, resolved once per open
  // rather than by mounting a panel to look. `false` while unresolved and on any
  // failure, which HIDES the entry: a hidden setting is a smaller failure than
  // one the user is sent to and cannot find.
  const [memberVault, setMemberVault] = useState(false);
  useEffect(() => {
    if (!open || vaultId === null) {
      setMemberVault(false);
      return;
    }
    let alive = true;
    void memberVaultStatus(vaultId)
      .then((isMember) => {
        if (alive) setMemberVault(isMember === true);
      })
      .catch(() => {
        if (alive) setMemberVault(false);
      });
    return () => {
      alive = false;
    };
  }, [open, vaultId]);
  // The rail roster, re-filtered whenever Developer mode flips (About panel,
  // task 6) so the group appears/disappears immediately per the PRD's "no
  // restart, no confirmation dialog" requirement — no separate effect needed,
  // this just re-derives on every render `prefs.developer_mode` changes.
  const panels = useMemo(
    () =>
      PANELS_BASE.filter(
        (p) =>
          (p.capability === undefined || capabilities.has(p.capability)) &&
          (p.group !== "developer" || prefs.developer_mode),
      ),
    [prefs.developer_mode],
  );
  const [selected, setSelected] = useState<PanelId>(initialPanel ?? "account");
  // Apply the requested panel each time the modal opens (the ribbon's
  // "Customize ribbon…" passes "appearance").
  useEffect(() => {
    if (open) setSelected(initialPanel ?? "account");
  }, [open, initialPanel]);
  // If the selected panel drops out of the roster (Developer mode turned off
  // while its group was open), fall back to Account rather than stranding the
  // content pane on a panel no longer reachable from the rail.
  useEffect(() => {
    if (!panels.some((p) => p.id === selected)) setSelected("account");
  }, [panels, selected]);
  const [childInFlight, setChildInFlight] = useState(false);
  const [childDialogOpen, setChildDialogOpen] = useState(false);
  // Settings search (MYND-536). A non-empty query swaps the content pane from
  // the active panel to a flat, panel-grouped results list built off the static
  // search index — so filtering never mounts the other nine panels.
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Narrow-dialog restack (#391): watch the content area's width and let every
  // panel's rows (and the Editor preview column) respond via context.
  // `open` is passed because the content div does not exist while the dialog is
  // closed, and a ref filling in does not re-render — see the parameter's own
  // doc (myne-md/myne#556). Without it the observer was never attached.
  const compact = useSettingsCompactObserver(contentRef, open);
  // The setting to scroll to + flash once the target panel has mounted (a result
  // was selected). Held across the panel switch; consumed by the effect below.
  const [pendingScroll, setPendingScroll] = useState<SettingsIndexEntry | null>(
    null,
  );
  // A deep link (`initialAnchor`) is the same request a picked search result
  // makes, so it goes through the same one channel rather than growing a second
  // scroll path beside it. Re-armed on every open, so a second visit from the
  // same entry point lands in the same place instead of only the first.
  useEffect(() => {
    if (!open || initialAnchor === undefined) return;
    const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === initialAnchor);
    if (entry !== undefined) {
      // Same topic step a picked result takes, for the same reason: an anchor
      // inside a topic that is not the active one is not mounted, so landing on
      // it also means selecting the topic that owns it.
      if (entry.topic !== undefined) {
        setActiveSettingsTopic(entry.panelId, entry.topic);
      }
      setPendingScroll(entry);
    }
  }, [open, initialAnchor]);
  // A topic change starts the new topic at the top, the way a rail change does
  // (#206): a strip that swapped the body under a scroll position the user had
  // scrolled would land them mid-way through the topic they just picked. This
  // runs BEFORE the pending-scroll effect below, so a search jump still ends on
  // its anchor - that scroll is scheduled on the next frame, after this reset.
  const activeTopic = useActiveSettingsTopic(selected, livePanelTopics(selected));
  useEffect(() => {
    if (contentRef.current !== null) contentRef.current.scrollTop = 0;
  }, [activeTopic, selected]);
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
        ? flattenGroups(
            groupResultsByPanel(
              searchSettings(query, t, prefs.developer_mode, memberVault),
            ),
          )
        : [],
    [searching, query, t, prefs.developer_mode, memberVault],
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
  // The rest of the page goes INERT while this is open (myne-md/myne#728).
  // The focus trap above contains Tab; it does not stop a screen reader's
  // virtual cursor reading the page behind, and `aria-modal` is an assertion
  // some assistive technology ignores. Registered on the BACKDROP, which is
  // the whole overlay: registering the card would inert the backdrop it is in.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, open);
  useFocusTrap(modalRef, { enabled: open });
  const itemRefs = useRef<Record<PanelId, HTMLButtonElement | null>>({
    account: null,
    vault: null,
    privacy: null,
    sync: null,
    extensions: null,
    ai: null,
    network: null,
    cli: null,
    editor: null,
    files: null,
    transcription: null,
    hotkeys: null,
    appearance: null,
    storage: null,
    about: null,
    diagnostics: null,
  });

  // Refs so the keydown handler reads current values without re-
  // registering the global listener on every selection or in-flight
  // change.
  const selectedRef = useRef(selected);
  const childInFlightRef = useRef(childInFlight);
  const childDialogOpenRef = useRef(childDialogOpen);
  const queryRef = useRef(query);
  const panelsRef = useRef(panels);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    childInFlightRef.current = childInFlight;
  }, [childInFlight]);
  useEffect(() => {
    childDialogOpenRef.current = childDialogOpen;
  }, [childDialogOpen]);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

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
      // A panel's own dialog is up: stand down entirely. Not just Esc — "/"
      // would pull focus to the search box behind the dialog and the arrows
      // would cycle a rail the user cannot see.
      if (childDialogOpenRef.current) return;
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
        const currentPanels = panelsRef.current;
        const idx = currentPanels.findIndex((p) => p.id === selectedRef.current);
        const next =
          e.key === "ArrowDown"
            ? (idx + 1) % currentPanels.length
            : (idx - 1 + currentPanels.length) % currentPanels.length;
        const nextId = currentPanels[next].id;
        setSelected(nextId);
        itemRefs.current[nextId]?.focus();
        // Start the new panel at the top on tab change (#206).
        if (contentRef.current !== null) contentRef.current.scrollTop = 0;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (childInFlight || childDialogOpen) return;
      if (e.target === e.currentTarget) onClose();
    },
    [onClose, childInFlight, childDialogOpen],
  );

  // Selecting a result jumps to the owning panel, clears the query (so the
  // content pane returns to the panel view), and arms the scroll+flash of the
  // target setting for after the panel mounts. **It also selects the topic the
  // entry lives in** (myne-md/myne#885 task 5): an inactive topic's body is not
  // mounted, so without this the anchor is not in the document at all and the
  // jump degrades to a panel switch with no answer on screen.
  const handleSelectResult = useCallback((entry: SettingsIndexEntry) => {
    setSelected(entry.panelId);
    if (entry.topic !== undefined) {
      setActiveSettingsTopic(entry.panelId, entry.topic);
    }
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
          // Flash the whole setting ROW, not just the sub-control a `testid`
          // fallback landed on — so the highlight reads as "this setting" (#206).
          const row =
            (el.closest("[data-setting-row]") as HTMLElement | null) ?? el;
          row.scrollIntoView({ block: "center" });
          row.setAttribute("data-setting-flash", "true");
          window.setTimeout(
            () => row.removeAttribute("data-setting-flash"),
            1200,
          );
        }
      }
      setPendingScroll(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingScroll, searching, selected]);

  if (!open) return null;

  const panelContent: Record<PanelId, ReactNode> = {
    account: <AccountPanel vaultId={vaultId} />,
    diagnostics: <DiagnosticsPanel />,
    vault: (
      <VaultPanel
        vaultId={vaultId}
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
    extensions: <BrowserExtensionsPanel />,
    sync: (
      <SyncPanel
        vaultId={vaultId}
        onDialogOpenChange={setChildDialogOpen}
      />
    ),
    ai: <AiPanel onShowToast={onShowToast} onDialogOpenChange={setChildDialogOpen} />,
    network: <NetworkPanel />,
    cli: <CliPanel onShowToast={onShowToast} />,
    editor: <EditorPanel onShowToast={onShowToast} focusAnchorId={pendingScroll?.id} />,
    files: <FilesPanel />,
    transcription: <TranscriptionPanel />,
    hotkeys: <HotkeysPanel />,
    appearance: (
      <AppearancePanel onOpenGraph={onOpenGraph} onDialogOpenChange={setChildDialogOpen} />
    ),
    storage: (
      <StoragePanel
        vaultId={vaultId}
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
      ref={backdropRef}
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
            {...interactiveSurface({ disabled: childInFlight })}
            style={{
              ...CLOSE_BUTTON_STYLE,
              cursor: childInFlight ? "default" : "pointer",
              opacity: childInFlight ? 0.5 : 1,
              transition: HOVER_TRANSITION,
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
              {panels.map((panel, i) => {
              const isSelected = panel.id === selected;
              // Insert the Developer divider once, at the core→developer
              // boundary. Because `panels` is already filtered, this only
              // fires when a developer-group panel survived the filter — an
              // empty group renders no divider and no header, derived rather
              // than asserted (task 5 acceptance).
              const opensDeveloper =
                panel.group === "developer" &&
                (i === 0 || panels[i - 1].group !== "developer");
              return (
                <Fragment key={panel.id}>
                  {opensDeveloper && (
                    <div
                      role="presentation"
                      data-testid="settings.developer-group"
                      style={RAIL_GROUP_HEADER_STYLE}
                    >
                      {t("settings.shell.groups.developer")}
                    </div>
                  )}
                  <button
                    ref={(el) => {
                      itemRefs.current[panel.id] = el;
                    }}
                    type="button"
                    role="tab"
                    // The content pane's `aria-labelledby` has pointed at this id
                    // since the rail landed; nothing set it, so the pane was
                    // announced unlabelled. Set here rather than left dangling
                    // beside the topic panel's own (correct) wiring one level
                    // down (myne-md/myne#885).
                    id={`settings-panel-${panel.id}-tab`}
                    data-testid={`settings.tab-${panel.id}`}
                    aria-selected={isSelected}
                    aria-controls={`settings-panel-${panel.id}`}
                    tabIndex={isSelected ? 0 : -1}
                    {...interactiveSurface({
                      restBg: isSelected ? "var(--paper-3)" : "transparent",
                      // A selected tab already reads as current; hover only needs
                      // to answer "is this row live?" for the unselected ones.
                      hoverBg: isSelected ? "var(--paper-3)" : "var(--bg-3)",
                    })}
                    onClick={() => {
                      // Clicking a rail tab exits search back to the panel view,
                      // and starts the new panel at the TOP — a tab change must
                      // not inherit the previous panel's scroll position (#206).
                      setQuery("");
                      if (panel.id !== selected) setSelected(panel.id);
                      if (contentRef.current !== null) {
                        contentRef.current.scrollTop = 0;
                      }
                    }}
                    style={
                      isSelected ? RAIL_ITEM_SELECTED_STYLE : RAIL_ITEM_BASE_STYLE
                    }
                  >
                    <Icon name={panel.icon} size={18} />
                    {t(panel.labelKey)}
                  </button>
                </Fragment>
              );
              })}
            </nav>
          </div>

          <div style={CONTENT_COLUMN_STYLE}>
            <SettingsCompactContext.Provider value={compact}>
              {/* The in-panel topic strip (myne-md/myne#885). It renders nothing
                  for a panel with fewer than two topics, which is how a short
                  panel stays a single screen, and nothing while a search query
                  owns the pane (the results list is not a topic of any panel). */}
              {searching ? null : (
                <SettingsTabs
                  panelId={selected}
                  topics={livePanelTopics(selected)}
                />
              )}
              <div
                ref={contentRef}
                role="tabpanel"
                id={`settings-panel-${selected}`}
                aria-labelledby={`settings-panel-${selected}-tab`}
                style={CONTENT_STYLE}
              >
                <div style={CONTENT_INNER_STYLE}>
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
            </SettingsCompactContext.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}
