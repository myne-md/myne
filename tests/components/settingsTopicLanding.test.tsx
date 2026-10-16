// @vitest-environment jsdom
//
// The settings search lands INSIDE the topic that owns the hit, on a panel the
// AI suite does not cover (myne-md/myne#885 task 11).
//
// The behaviour itself is `settingsTopicTabs.test.tsx`'s: select the topic an
// index entry names, then scroll to the entry's anchor. The step it drives is
// panel-agnostic, so what this file adds is that the registry's `topic` FIELD
// and the topic a body actually renders in are the same one, seen through the
// real shell rather than through a store a test set by hand.
//
// The failure this exists for: an inactive topic's body is NOT mounted, so a hit
// whose topic is wrong scrolls to an element that is not in the document, and
// the user is left at the top of a tab with no answer. Nothing reports it -
// every compiler and every guard in the tree passes.
//
// Appearance is the panel under test because its `interface` topic is the
// non-default one (`display` is), so a hit there proves the topic step ran.
// Every other rail panel is stubbed to a marker: this is about the landing, not
// about them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("../../src/platform/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [])),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../../src/lib/prefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/prefs")>();
  const view = {
    theme: null,
    custom_theme: null,
    show_note_timestamps: true,
    show_task_marker: true,
    developer_mode: false,
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
  };
});
vi.mock("../../src/lib/theme", () => ({ applyTheme: vi.fn(), applyCustomTheme: vi.fn() }));
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

// The panels this file is not about.
vi.mock("../../src/components/settings/PrivacyPanel", () => ({
  PrivacyPanel: () => <div data-testid="panel.privacy">privacy</div>,
}));
vi.mock("../../src/components/settings/AccountPanel", () => ({
  AccountPanel: () => <div data-testid="panel.account">account</div>,
}));
vi.mock("../../src/components/settings/SyncPanel", () => ({
  SyncPanel: () => <div data-testid="panel.sync">sync</div>,
}));
vi.mock("../../src/components/settings/EditorPanel", () => ({
  EditorPanel: () => <div data-testid="panel.editor">editor</div>,
}));
vi.mock("../../src/components/settings/FilesPanel", () => ({
  FilesPanel: () => <div data-testid="panel.files">files</div>,
}));
vi.mock("../../src/components/settings/TranscriptionPanel", () => ({
  TranscriptionPanel: () => <div data-testid="panel.transcription">transcription</div>,
}));
vi.mock("../../src/components/settings/HotkeysPanel", () => ({
  HotkeysPanel: () => <div data-testid="panel.hotkeys">hotkeys</div>,
}));
vi.mock("../../src/components/settings/StoragePanel", () => ({
  StoragePanel: () => <div data-testid="panel.storage">storage</div>,
}));
vi.mock("../../src/components/settings/AboutPanel", () => ({
  AboutPanel: () => <div data-testid="panel.about">about</div>,
}));
vi.mock("../../src/components/settings/AiPanel", () => ({
  AiPanel: () => <div data-testid="panel.ai">ai</div>,
}));
vi.mock("../../src/components/settings/NetworkPanel", () => ({
  NetworkPanel: () => <div data-testid="panel.network">network</div>,
}));

const { SettingsModal } = await import("../../src/components/SettingsModal");
const { resetSettingsTopics } = await import(
  "../../src/components/settings/SettingsTabs"
);

const VAULT_ID = "00000000-0000-7000-8000-000000000000";

// jsdom implements no layout, so `Element.prototype.scrollIntoView` does not
// exist there. The shell calls it from a rAF after the topic mounts, and under a
// loaded full-suite run that frame lands inside this test and throws, which is
// what made this file pass alone and fail in `pnpm test`. Recording the call
// also lets the test assert the scroll reached the setting rather than only
// that the setting is in the document.
const scrolled: Element[] = [];
const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe("the search lands inside the topic that owns the hit", () => {
  it("selects an inactive Appearance topic before scrolling to its setting", async () => {
    resetSettingsTopics();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "plugin:prefs|prefs_read"
        ? Promise.resolve({ developer_mode: false })
        : Promise.resolve(undefined),
    );
    render(
      <SettingsModal
        open
        vaultId={VAULT_ID}
        initialPanel="appearance"
        onClose={vi.fn()}
        onDeleteVaultSuccess={vi.fn()}
      />,
    );
    // The fixture starts on a topic that does NOT hold the setting under test,
    // or the jump below would pass without the topic step doing anything.
    expect(
      document.querySelector('[data-testid="settings.appearance-topic-interface"]'),
      "the setting under test must start in an INACTIVE topic",
    ).toBeNull();

    fireEvent.change(screen.getByTestId("settings.search-input"), {
      target: { value: "graph appearance" },
    });
    const row = await waitFor(() => {
      const found = document.querySelector(
        '[data-testid="settings.search-result"][data-setting-id="appearance.graph-settings"]',
      );
      if (found === null) throw new Error("the graph-appearance result is not listed");
      return found;
    });
    fireEvent.click(row);

    // The topic that owns the hit is mounted, and the target the shell scrolled
    // to is in the document - which is the half that was impossible before the
    // topic step existed. The target is the entry's `testid` here rather than an
    // anchor, because this row carries only the former; the shell's resolution
    // order is anchor first, testid as the fallback, and the assertion follows
    // the same order.
    await waitFor(() =>
      expect(screen.getByTestId("settings.appearance-topic-interface")).toBeTruthy(),
    );
    const anchor = document.querySelector('[data-setting-anchor="appearance.graph-settings"]');
    const byTestid = document.querySelector('[data-testid="settings.open-graph"]');
    const target = anchor ?? byTestid;
    expect(target).not.toBeNull();
    await waitFor(() => expect(scrolled.length).toBeGreaterThan(0));
    expect(
      scrolled.some((el) => el === target || el.contains(target as Node)),
      "the shell scrolled, but not to the setting the hit names",
    ).toBe(true);
    expect(screen.queryByTestId("settings.appearance-topic-display")).toBeNull();
  });
});
