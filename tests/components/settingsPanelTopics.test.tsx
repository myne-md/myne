// @vitest-environment jsdom
//
// The topic splits of Appearance, Privacy, Account and Sync (myne-md/myne#885
// task 11), proved the way the AI panel's split was proved.
//
// Two claims, and the second is the one a compiler cannot make:
//
//   1. **Every topic a panel declares renders a body, and only its own.** The
//      wrappers are asserted one at a time, and each body is asserted to be
//      NON-EMPTY. That second half is the reason this file exists rather than a
//      diff read: a topic whose only member is gated off on some client renders
//      an empty tab, and the grouping rule this slice applied (a
//      capability-gated block joins a topic rather than getting one) is exactly
//      a claim that no such topic exists.
//   2. **Every `settingsSearchIndex` entry lands in the topic it names.** The
//      registry's `topic` field is a plain string to the type system and the
//      anchor is where the search lands, so a wrong field scrolls the user to an
//      element that is not in the document. This walks every entry of every
//      split panel: select the entry's topic, mount the panel, assert the
//      entry's `data-setting-anchor` (or its `testid` fallback, which is the
//      same order the shell resolves) is present. It therefore fails on a wrong
//      `topic` field as well as on a dropped control.
//
// The panels are the REAL components with their host calls mocked at the module
// boundary, because the thing under test is which body is mounted rather than
// which command answers. The fixtures raise `developer_mode`, which is what puts
// the CLI block in Privacy's `Access` topic and would otherwise make three
// entries look unreachable.
//
// The AI panel's own version of claim 2 lives in `AiPanel.test.tsx`, next to the
// fixture it needs; this file is the other four panels.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const invokeMock = vi.fn();

/** Whether the mounted vault reports itself as a B2B member vault.
 *
 *  Two of the panels read this and they need DIFFERENT answers: the
 *  shared-vault-unlock row in Privacy renders only on a member vault, while the
 *  owner password CTA in Account is REPLACED by a notice there. A single fixture
 *  value would make one of the two walks vacuous. */
const { memberVaultFlag } = vi.hoisted(() => ({ memberVaultFlag: { value: false } }));

/** The capabilities THIS suite's fixture client is missing.
 *
 *  Empty by default, so every walk above runs on the desktop capability set it
 *  was written for. The one test that fills it is the per-client topic drop:
 *  `livePanelTopics` calls `has` at render, so flipping this set changes the
 *  answer without a module reload. */
const { absentCaps } = vi.hoisted(() => ({ absentCaps: new Set<string>() }));

vi.mock("../../src/platform/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform/capabilities")>();
  return {
    ...actual,
    has: (cap: string) => !absentCaps.has(cap) && actual.has(cap as never),
  };
});

vi.mock("../../src/platform/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [])),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// The prefs readers the four panels' trees call. The real module is kept for
// everything else (`mutationFrom` is a pure derivation the panels rely on).
vi.mock("../../src/lib/prefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/prefs")>();
  const view = {
    theme: null,
    custom_theme: null,
    show_note_timestamps: true,
    show_task_marker: true,
    label: "",
    icon: null,
    // Developer mode ON is a fixture requirement, not a preference: the CLI
    // block in Privacy renders only while it is on, and three of that panel's
    // registry entries live on that block.
    developer_mode: true,
    screen_capture_protection: false,
    auto_lock_seconds: 300,
    cli_enabled: false,
    cli_excluded_folders: [],
    cli_rate_limit_disabled: false,
    // The panels the walk for the short tabs mounts (files, transcription,
    // hotkeys). Read through `prefsRead`, so they belong on the same fixture
    // rather than in an `invoke` arm.
    startup_open: "last",
    new_note_location: "root",
    transcription_enabled: true,
    keymap: {},
  };
  const resolved = (): Promise<unknown> => Promise.resolve(view);
  return {
    ...actual,
    prefsRead: resolved,
    setTheme: vi.fn(resolved),
    setCustomTheme: vi.fn(resolved),
    setShowNoteTimestamps: vi.fn(resolved),
    setShowTaskMarker: vi.fn(resolved),
    setRibbonItems: vi.fn(resolved),
    setRibbonVisible: vi.fn(resolved),
    setBarItemsOrder: vi.fn(resolved),
    setHiddenBarItems: vi.fn(resolved),
    setVaultLabel: vi.fn(resolved),
    setVaultIcon: vi.fn(resolved),
  };
});

vi.mock("../../src/lib/theme", () => ({
  applyTheme: vi.fn(),
  applyCustomTheme: vi.fn(),
}));

// Custom themes: the LIST is what the Appearance topic renders, and its own IPC
// is not what this file is about.
vi.mock("../../src/lib/themes", () => ({
  listCustomThemes: () => Promise.resolve([]),
  readCustomTheme: () => Promise.resolve(null),
  exportCustomTheme: () => Promise.resolve(null),
  importCustomTheme: () => Promise.resolve(null),
  deleteCustomTheme: () => Promise.resolve(),
  themePreview: () => ({ paper: "#fff", ink: "#000", accent: "#000", line: "#eee", paper2: "#f4f4f2" }),
}));

vi.mock("../../src/lib/accentColor", () => ({
  readAccent: () => null,
  writeAccent: vi.fn(),
  applyAccent: vi.fn(),
}));

// Account: the clipper section and the member-vault probe, neither of which this
// file's claims reach.
vi.mock("../../src/lib/clipper-pairing", () => ({
  listPairedExtensions: () => Promise.resolve([]),
  revokePairedExtension: () => Promise.resolve(),
  getClipperInstallStatus: () => Promise.resolve({ enabled: false, installed: false }),
  setClipperInstallEnabled: () => Promise.resolve(),
}));
vi.mock("../../src/lib/personAccount", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/personAccount")>()),
  memberVaultStatus: () => Promise.resolve(memberVaultFlag.value),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: () => Promise.resolve("/data"),
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
}));

const { AppearancePanel } = await import("../../src/components/settings/AppearancePanel");
const { PrivacyPanel } = await import("../../src/components/settings/PrivacyPanel");
const { VaultPanel } = await import("../../src/components/settings/VaultPanel");
const { renderSyncPanel } = await import("./_syncPanelHarness");
const { syncPanelCommandRouter } = await import("./_syncPanelHarness");
// The panels no other walk covers (myne-md/myne#885). The union of this file,
// `AiPanel.test.tsx` and `EditorPanel.test.tsx` is every rail panel.
const { FilesPanel } = await import("../../src/components/settings/FilesPanel");
const { TranscriptionPanel } = await import("../../src/components/settings/TranscriptionPanel");
const { HotkeysPanel } = await import("../../src/components/settings/HotkeysPanel");
const { StoragePanel } = await import("../../src/components/settings/StoragePanel");
const { AboutPanel } = await import("../../src/components/settings/AboutPanel");
const { NetworkPanel } = await import("../../src/components/settings/NetworkPanel");
const { SETTINGS_SEARCH_INDEX } = await import(
  "../../src/components/settings/search/settingsSearchIndex"
);
const { SETTINGS_PANEL_TOPICS, livePanelTopics } = await import(
  "../../src/components/settings/settingsTopics"
);
const { SettingsTabs, resetSettingsTopics, setActiveSettingsTopic } = await import(
  "../../src/components/settings/SettingsTabs"
);

/** The screen-privacy reads the panel's rows issue on mount. */
function stubPrivacyIpc() {
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "plugin:prefs|prefs_read":
        return Promise.resolve({ developer_mode: true });
      case "plugin:vault-unlock|vault_active_id":
        // The shared-vault-unlock row resolves the active vault before it can
        // ask whether that vault is a member vault.
        return Promise.resolve(VAULT_ID);
      case "plugin:sync|sync_member_unlock_status":
        return Promise.resolve(null);
      case "plugin:vault-label|hide_vault_names":
        return Promise.resolve({ hidden: false });
      case "plugin:vault-label|vault_label_keychain_status":
        return Promise.resolve({ available: true });
      case "plugin:quick-unlock|quick_unlock_status":
        return Promise.resolve({ configured: false, method: null, available: true });
      case "plugin:screen-capture|screen_capture_override_get":
        return Promise.resolve({ disabled: false, via_flag: false, effective: false });
      default:
        return Promise.reject(new Error(`unstubbed command: ${cmd}`));
    }
  });
}

const VAULT_ID = "00000000-0000-7000-8000-000000000000";

function selectTopic(panelId: string, topicId: string) {
  act(() => {
    resetSettingsTopics();
    setActiveSettingsTopic(panelId, topicId);
  });
}

/** The three panels that mount bare, plus the Sync panel behind its provider. */
const PANELS: ReadonlyArray<{
  panelId: "appearance" | "privacy" | "vault" | "sync";
  mount: () => void;
}> = [
  {
    panelId: "appearance",
    mount: () => {
      render(<AppearancePanel />);
    },
  },
  {
    panelId: "privacy",
    mount: () => {
      // A member vault: the shared-vault-unlock row is one of this panel's
      // registry entries and it renders nowhere else.
      memberVaultFlag.value = true;
      stubPrivacyIpc();
      render(<PrivacyPanel />);
    },
  },
  {
    panelId: "vault",
    mount: () => {
      memberVaultFlag.value = false;
      invokeMock.mockImplementation(() => Promise.resolve(undefined));
      render(
        <VaultPanel
          vaultId={VAULT_ID}
          onChangePasswordSuccess={vi.fn()}
          onDeleteVaultSuccess={vi.fn()}
        />,
      );
    },
  },
  {
    panelId: "sync",
    mount: () => {
      // `not_enrolled` is what renders the enrol form, which is one of this
      // panel's registry entries; the gate withholds it from every other state
      // (`SyncPanel.enrol-gate.test.tsx` owns that behaviour).
      //
      // `publishState` is supplied too, and it is what makes the publish row
      // render: that row exists only where the read answers (`publishState !==
      // null`), so the harness's default `null` would report the registry's
      // `sync.publish` entry as having no home. A device-only state is the
      // ordinary one for a vault that has not been published.
      invokeMock.mockImplementation(
        syncPanelCommandRouter({
          syncState: "not_enrolled",
          // `person_born: false` on purpose: a person-born vault hides the
          // account-number enrol form (its join is the identity code), and this
          // walk needs that form rendered to find `sync.add-device`.
          publishState: {
            published: false,
            namespace_hex: null,
            published_at_ms: null,
            person_born: false,
          },
        }),
      );
      renderSyncPanel();
    },
  },
];

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(cleanup);

describe("every declared topic of the four split panels renders its own body", () => {
  it.each(PANELS)("$panelId: one body at a time, and none of them empty", async ({ panelId, mount }) => {
    const topics = SETTINGS_PANEL_TOPICS[panelId];
    expect(topics, `${panelId} declares no topics`).toBeDefined();
    expect((topics ?? []).length).toBeGreaterThanOrEqual(2);

    for (const topic of topics ?? []) {
      cleanup();
      selectTopic(panelId, topic.id);
      mount();
      // `SettingsTopicPanel` renders nothing at all while its topic is
      // inactive, so the settled DOM is the assertion: this topic's wrapper is
      // in the document, every other topic's is not, and this one has content.
      await act(async () => {
        await Promise.resolve();
      });
      const mine = document.querySelector(`[data-testid="settings.${panelId}-topic-${topic.id}"]`);
      expect(mine, `${panelId} topic ${topic.id} rendered no body`).not.toBeNull();
      expect(
        (mine as HTMLElement).childElementCount,
        `${panelId} topic ${topic.id} rendered an EMPTY body, which is a tab that opens onto nothing`,
      ).toBeGreaterThan(0);
      for (const other of topics ?? []) {
        if (other.id === topic.id) continue;
        expect(
          document.querySelector(`[data-testid="settings.${panelId}-topic-${other.id}"]`),
          `${panelId} rendered topic ${other.id} while ${topic.id} was active`,
        ).toBeNull();
      }
    }
  });
});

// ── A topic whose WHOLE body is gated is not produced on that client ────────
//
// The walk above proves every topic the roster declares renders a non-empty
// body ON DESKTOP. That is only half the rule `settingsTopics.ts` states: the
// topic must be non-empty on EVERY client. Privacy's `Access` is the one topic
// where it is not, because all three of its rows are capability-gated
// (`screenCaptureProtection`, `lockedVaultNames`, `cliAccess`) and the web client
// has all three absent. Before `liveOn` the web client drew an `Access` tab whose
// body was one section title and nothing else, which is exactly the empty tab
// the grouping rule refuses.
//
// Two directions, because a drop that fired everywhere would satisfy the first
// one on its own.

const PRIVACY_ACCESS_CAPABILITIES = [
  "screenCaptureProtection",
  "lockedVaultNames",
  "cliAccess",
] as const;

describe("a topic whose whole body is gated is dropped, not left empty", () => {
  it("privacy: desktop keeps both topics", () => {
    expect(livePanelTopics("privacy").map((topic) => topic.id)).toEqual([
      "access",
      "locking",
    ]);
  });

  it("privacy: no Access topic and no strip where its three capabilities are absent", async () => {
    for (const cap of PRIVACY_ACCESS_CAPABILITIES) absentCaps.add(cap);
    try {
      expect(livePanelTopics("privacy").map((topic) => topic.id)).toEqual(["locking"]);

      // The strip is not rendered at all: one topic is a strip that cannot
      // change anything, which is the same rule the short panels rely on.
      const strip = render(
        <SettingsTabs panelId="privacy" topics={livePanelTopics("privacy")} />,
      );
      expect(strip.container.querySelector('[role="tablist"]')).toBeNull();
      strip.unmount();

      // And the Access body is not mounted even when its id is the remembered
      // one, because the live roster does not carry it: the active topic falls
      // back to the panel's one live concern.
      memberVaultFlag.value = false;
      stubPrivacyIpc();
      selectTopic("privacy", "access");
      render(<PrivacyPanel />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.querySelector('[data-testid="settings.privacy-topic-access"]')).toBeNull();
      expect(
        document.querySelector('[data-testid="settings.privacy-topic-locking"]'),
        "locking is the topic the panel falls to, and it must still render",
      ).not.toBeNull();
    } finally {
      absentCaps.clear();
    }
  });
});

describe("every search entry has exactly one home, and it is the topic it names", () => {
  it.each(PANELS)("$panelId: one home per entry, matching the registry", async ({ panelId, mount }) => {
    const topics = SETTINGS_PANEL_TOPICS[panelId] ?? [];
    const entries = SETTINGS_SEARCH_INDEX.filter((e) => e.panelId === panelId);
    // A filter that matched nothing would make the whole walk vacuous.
    expect(entries.length, `${panelId} has no registry entries`).toBeGreaterThan(0);

    // Which registry targets each topic's body renders, collected topic by
    // topic. Mounting each topic ONCE and reading every entry out of it is what
    // makes "exactly one home" checkable in both directions at a cost of one
    // mount per topic rather than one per entry.
    const homes = new Map<string, Set<string>>();
    for (const topic of topics) {
      cleanup();
      selectTopic(panelId, topic.id);
      mount();
      await act(async () => {
        await Promise.resolve();
      });
      const found = new Set<string>();
      for (const entry of entries) {
        const anchored = document.querySelector(`[data-setting-anchor="${entry.id}"]`);
        // The shell's own resolution order: the anchor first, the testid as the
        // fallback (some rows carry only one of the two).
        const byTestid =
          entry.testid === undefined
            ? null
            : document.querySelector(`[data-testid="${entry.testid}"]`);
        if (anchored !== null || byTestid !== null) found.add(entry.id);
      }
      homes.set(topic.id, found);
    }

    const problems: string[] = [];
    for (const entry of entries) {
      const where = topics.filter((t) => homes.get(t.id)?.has(entry.id) === true).map((t) => t.id);
      if (where.length === 0) {
        problems.push(
          `${entry.id} renders in NO topic, so the search scrolls to an element that is not in the document`,
        );
      } else if (where.length > 1) {
        problems.push(`${entry.id} renders in ${where.length} topics (${where.join(", ")})`);
      } else if (where[0] !== entry.topic) {
        problems.push(
          `${entry.id} renders in topic ${where[0]} but the registry says ${String(entry.topic)}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});

// ── The panels no other walk covers (myne-md/myne#885) ──────────────────────
//
// The one-home walk above proves the four split panels, `EditorPanel.test.tsx`
// proves Editor and `AiPanel.test.tsx` proves AI. That left the six SHORT panels
// with no walk at all, and a real defect lived in exactly that blind spot:
// `storage.clipper` claimed `storage`, but its only render site is
// `ConnectedExtensions`, which AccountPanel alone mounts, so the hit navigated
// to Storage and degraded to a plain panel switch. The old flash-target guard
// could not see it because its check was a substring test over a blob of EVERY
// panel source, which a testid declared anywhere in the tree satisfies.
//
// This is that guard's replacement, and it is the same machinery the walks above
// use rather than a second one: mount the panel an entry CLAIMS and assert the
// entry's target (its `data-setting-anchor`, or its `testid` fallback in the
// shell's own resolution order) is in the document. An entry that renders
// nowhere the registry says now fails here by name.
//
// The six panels are single screens, so there is no topic dimension to walk: one
// mount per panel, and every entry claiming it must render. The union across
// this file and the two panel-specific files is every rail panel, which is what
// makes "for every search index entry" true rather than aspirational.

const VAULT_FOR_WALK = "00000000-0000-7000-8000-000000000000";

/** The mount-time reads these six panels issue. Permissive by design: what this
 *  walk asserts is WHERE an entry's target renders, not what a command answers,
 *  so an unlisted command resolves `undefined` and only the few a panel needs
 *  SHAPED (or it renders nothing at all) are given an arm here. */
function stubShortPanelIpc() {
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "plugin:prefs|prefs_read":
        return Promise.resolve({ developer_mode: true });
      case "plugin:notes|note_list":
        // The folder-path picker derives from this; `undefined` would crash its
        // `.length` read rather than leave an empty picker.
        return Promise.resolve([]);
      case "plugin:vault-unlock|vault_active_id":
        return Promise.resolve(VAULT_FOR_WALK);
      case "plugin:backup|backup_schedule_read":
        // `AutomaticBackupBlock` renders nothing until the schedule resolves, so
        // the `storage.auto-backup` row exists only on a shaped answer.
        return Promise.resolve({
          enabled: false,
          interval: "daily",
          targetFolder: null,
          retentionN: 7,
          lastScheduledSuccessAt: null,
          lastBackupAttemptAt: null,
          lastBackupStatus: "never",
          trackedBackups: 0,
        });
      case "plugin:update|update_get_auto_check":
        // The auto-check row renders only once the read resolves a value.
        return Promise.resolve(false);
      case "plugin:sync|sync_get_tor_state":
        return Promise.resolve({ enabled: false, state: { kind: "stopped" }, exempt: false });
      default:
        return Promise.resolve(undefined);
    }
  });
}

const SHORT_PANELS: ReadonlyArray<{
  panelId: "files" | "transcription" | "hotkeys" | "storage" | "about" | "network";
  mount: () => void;
}> = [
  { panelId: "files", mount: () => render(<FilesPanel />) },
  { panelId: "transcription", mount: () => render(<TranscriptionPanel />) },
  { panelId: "hotkeys", mount: () => render(<HotkeysPanel />) },
  {
    panelId: "storage",
    mount: () =>
      render(
        <StoragePanel
          vaultId={VAULT_FOR_WALK}
          onImportObsidian={vi.fn()}
          onBackupVault={vi.fn()}
          onRestoreBackup={vi.fn()}
          onExportVault={vi.fn()}
          onShowToast={vi.fn()}
        />,
      ),
  },
  { panelId: "about", mount: () => render(<AboutPanel />) },
  { panelId: "network", mount: () => render(<NetworkPanel />) },
];

// Transcription is one section, and the rail entry already names it, so the
// section draws no heading and no accent rule (myne-md/myne#867, on the user's
// read: "one section, but the separator is still there").
describe("the Transcription panel draws no seam", () => {
  it("renders its lone section without a heading or rule", async () => {
    cleanup();
    stubShortPanelIpc();
    render(<TranscriptionPanel />);
    await act(async () => {
      await Promise.resolve();
    });
    const panel = document.querySelector('[data-testid="settings.transcription-panel"]');
    expect(panel?.querySelector("h3")).toBeNull();
    expect(panel?.querySelector("section")?.getAttribute("data-section-alone")).toBe("true");
  });
});

describe("every entry renders in the panel the registry names (the short tabs)", () => {
  it.each(SHORT_PANELS)(
    "$panelId: every entry claiming it has its target on screen",
    async ({ panelId, mount }) => {
      const entries = SETTINGS_SEARCH_INDEX.filter((e) => e.panelId === panelId);
      // A filter that matched nothing would make the whole walk vacuous.
      expect(entries.length, `${panelId} has no registry entries`).toBeGreaterThan(0);

      cleanup();
      stubShortPanelIpc();
      mount();
      await act(async () => {
        await Promise.resolve();
      });

      const missing = entries
        .filter((entry) => {
          const anchored = document.querySelector(`[data-setting-anchor="${entry.id}"]`);
          // The shell's own resolution order: the anchor first, the testid as
          // the fallback (some rows carry only one of the two).
          const byTestid =
            entry.testid === undefined
              ? null
              : document.querySelector(`[data-testid="${entry.testid}"]`);
          return anchored === null && byTestid === null;
        })
        .map((entry) => entry.id);
      expect(
        missing,
        `${panelId}: entries whose target does not render in the panel the registry names`,
      ).toEqual([]);
    },
  );
});
