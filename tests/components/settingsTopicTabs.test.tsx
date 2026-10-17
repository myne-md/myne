// @vitest-environment jsdom
//
// The in-panel topic tab strip (myne-md/myne#885, requirement 6).
//
// Two things live here, and the second is the one the feature exists for.
//
//   1. The strip's own contract: one tab per topic in roster order, exactly one
//      Tab stop (roving `tabindex`), Left/Right within the strip, Up/Down left
//      to the shell that cycles the rail, the aria wiring between each tab and
//      its panel, and no strip at all for a panel with fewer than two topics.
//   2. The settings SEARCH landing inside the topic that owns the match. An
//      inactive topic's body is not mounted, so before this a hit inside one
//      scrolled to an element that was not in the document and left the user at
//      the top of a tab with no answer. The test drives the real shell, the real
//      registry and the real AI panel, and asserts the topic switched and the
//      anchor is present.
//
// The AI panel is the panel under test and stays real; the other rail panels are
// stubbed, because this is about the strip and the search rather than about them
// (the same reason `SettingsModal.test.tsx` stubs them).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProviderModel } from "../../src/lib/ai-model-store";

const {
  openUrl,
  revealItemInDir,
  openFileDialog,
  loadModelPath,
  saveModelPath,
  setAutoTagEnabled,
  tagModelAvailable,
  loadAiEndpoint,
  saveAiEndpoint,
  listProviderModels,
  aiProviderHasKey,
  listFolderPaths,
} = vi.hoisted(() => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
  openFileDialog: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  loadModelPath: vi.fn((_role?: string): Promise<string | null> => Promise.resolve(null)),
  saveModelPath: vi.fn((_role: string, p: string) => Promise.resolve(p)),
  setAutoTagEnabled: vi.fn((_enabled: boolean) => Promise.resolve()),
  tagModelAvailable: vi.fn((): Promise<boolean> => Promise.resolve(true)),
  loadAiEndpoint: vi.fn(
    (): Promise<{ url: string; model: string } | null> => Promise.resolve(null),
  ),
  saveAiEndpoint: vi.fn(
    (u: string, _m: string): Promise<string | null> => Promise.resolve(u || null),
  ),
  listProviderModels: vi.fn((): Promise<ProviderModel[]> => Promise.resolve([])),
  aiProviderHasKey: vi.fn((): Promise<boolean> => Promise.resolve(false)),
  listFolderPaths: vi.fn((): Promise<{ path: string; label: string }[]> => Promise.resolve([])),
}));

vi.mock("../../src/notes/listFolderPaths", () => ({ listFolderPaths }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl, revealItemInDir }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openFileDialog }));
vi.mock("../../src/lib/ai-model-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ai-model-store")>()),
  loadModelPath,
  saveModelPath,
  loadAiEndpoint,
  saveAiEndpoint,
  listProviderModels,
}));
vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/prefs")>()),
  aiProviderHasKey,
  setAiProvider: vi.fn(() => Promise.resolve()),
  setAiProviderConsent: vi.fn(() => Promise.resolve()),
  setAiProviderKey: vi.fn(() => Promise.resolve()),
  setAiProviderModel: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/lib/ai-capability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ai-capability")>()),
  aiCapabilityReport: () =>
    tagModelAvailable().then((available: boolean) => ({
      compiled: true,
      backendId: "candle",
      backendClass: "in_process_local",
      generation: { available: false, cause: "no_model" },
      transcription: { available: false, cause: "no_model" },
      autoTag: { available, cause: available ? null : "no_model" },
    })),
}));

const setAiEnabled = vi.fn();
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: {
      developer_mode: true,
      ai_enabled: true,
      auto_tag_enabled: false,
      ai_excluded_folders: [],
      ai_provider: null,
      ai_provider_consent: null,
      ai_provider_model: null,
      chat_history_budget: null,
      meeting_ai_prompt: null,
    },
    setDeveloperMode: vi.fn(),
    setAiEnabled,
    setAiExcludedFolders: vi.fn(() => Promise.resolve()),
    setAutoTagEnabled,
    setChatHistoryBudget: vi.fn(() => Promise.resolve()),
    setMeetingAiPrompt: vi.fn(() => Promise.resolve()),
  }),
}));

// The shells this suite is NOT about: stubbed to markers, so a rail switch in a
// test cannot depend on their IPC.
vi.mock("../../src/components/settings/AccountPanel", () => ({
  AccountPanel: () => <div data-testid="panel.account">account</div>,
}));
vi.mock("../../src/components/settings/PrivacyPanel", () => ({
  PrivacyPanel: () => <div data-testid="panel.privacy">privacy</div>,
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
vi.mock("../../src/components/settings/AppearancePanel", () => ({
  AppearancePanel: () => <div data-testid="panel.appearance">appearance</div>,
}));
vi.mock("../../src/components/settings/StoragePanel", () => ({
  StoragePanel: () => <div data-testid="panel.storage">storage</div>,
}));
vi.mock("../../src/components/settings/AboutPanel", () => ({
  AboutPanel: () => <div data-testid="panel.about">about</div>,
}));
vi.mock("../../src/components/settings/NetworkPanel", () => ({
  NetworkPanel: () => <div data-testid="panel.network">network</div>,
}));

import { SettingsModal } from "../../src/components/SettingsModal";
import { SettingsTabs, resetSettingsTopics } from "../../src/components/settings/SettingsTabs";
import {
  AI_PANEL_TOPICS,
  type SettingsTopicMeta,
} from "../../src/components/settings/settingsTopics";

/** Anchors the shell scrolled to. Reset per test, filled by the stub above. */
const scrolledAnchors: string[] = [];

beforeEach(() => {
  resetSettingsTopics();
  loadModelPath.mockClear();
  loadModelPath.mockResolvedValue(null);
  tagModelAvailable.mockClear();
  tagModelAvailable.mockResolvedValue(true);
  listFolderPaths.mockClear();
  listFolderPaths.mockResolvedValue([]);
  // jsdom implements no `scrollIntoView`, and the shell calls it inside a
  // requestAnimationFrame callback, where a missing method is an UNHANDLED error
  // rather than a failed assertion: vitest reported the file red while every
  // assertion in it passed. Stubbed for the whole file rather than in the one
  // test that reads the scroll, because the pending-scroll path is reached by
  // more than one of them (myne#892 review; the same shape `src/AGENTS.md`
  // records for `HTMLCanvasElement.getContext`).
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolledAnchors.push((this as HTMLElement).dataset.settingAnchor ?? "?");
  };
});

afterEach(cleanup);

function renderAiSettings(over: { open?: boolean } = {}) {
  const props = {
    vaultId: null,
    open: over.open ?? true,
    onClose: vi.fn(),
    initialPanel: "ai" as const,
    onDeleteVaultSuccess: vi.fn(),
  };
  return render(<SettingsModal {...props} />);
}

describe("SettingsTabs: the strip's contract", () => {
  it("renders one tab per topic, in roster order, with the first selected", () => {
    renderAiSettings();
    const strip = screen.getByTestId("settings.ai-tabs");
    expect(strip.getAttribute("role")).toBe("tablist");
    const tabs = [...strip.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "General",
      "Models",
      "Limits",
      "Advanced",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
  });

  it("is exactly one Tab stop, and moves within the strip with Left/Right", () => {
    // Roving `tabindex`: the whole strip is one stop, so Tab moves into the
    // panel's controls rather than through four tabs first. Arrow keys then move
    // the selection AND the focus, or the strip would leave its own stop behind.
    //
    // Every read re-queries: a re-render replaces the tab nodes, so a handle
    // captured before a key press is detached and reports the old state (which is
    // how this test failed on its first run).
    renderAiSettings();
    const selected = () =>
      [...screen.getByTestId("settings.ai-tabs").querySelectorAll('[role="tab"]')]
        .filter((tab) => tab.getAttribute("aria-selected") === "true")
        .map((tab) => tab.getAttribute("data-testid"));
    const stops = () =>
      [...screen.getByTestId("settings.ai-tabs").querySelectorAll('[role="tab"]')].map((tab) =>
        tab.getAttribute("tabindex"),
      );
    expect(stops()).toEqual(["0", "-1", "-1", "-1"]);
    expect(selected()).toEqual(["settings.ai-tab-answering"]);

    fireEvent.keyDown(screen.getByTestId("settings.ai-tab-answering"), { key: "ArrowRight" });
    expect(selected()).toEqual(["settings.ai-tab-models"]);
    expect(stops()).toEqual(["-1", "0", "-1", "-1"]);
    // And the focus moved with it: a selected-but-unfocused tab leaves the
    // strip's one Tab stop behind the user.
    expect(document.activeElement?.getAttribute("data-testid")).toBe("settings.ai-tab-models");

    // Wrap-around, the same way the rail's own cycle behaves.
    fireEvent.keyDown(screen.getByTestId("settings.ai-tab-advanced"), { key: "ArrowRight" });
    expect(selected()).toEqual(["settings.ai-tab-answering"]);
    fireEvent.keyDown(screen.getByTestId("settings.ai-tab-answering"), { key: "ArrowLeft" });
    expect(selected()).toEqual(["settings.ai-tab-advanced"]);

    // End/Home jump to the ends.
    fireEvent.keyDown(screen.getByTestId("settings.ai-tab-answering"), { key: "End" });
    expect(selected()).toEqual(["settings.ai-tab-advanced"]);
    fireEvent.keyDown(screen.getByTestId("settings.ai-tab-limits"), { key: "Home" });
    expect(selected()).toEqual(["settings.ai-tab-answering"]);
  });

  it("leaves Up/Down to the shell, because the shell cycles the rail with them", () => {
    // A strip that consumed them would silently break the navigation that
    // already works (the PRD's story 29). The assertion is the OUTCOME rather
    // than the return value of `fireEvent`: the shell's own window handler
    // preventDefaults Up/Down to cycle the rail, so what has to hold is that the
    // strip changed nothing and the rail still moved. `network` is the panel
    // after `ai` in the roster.
    renderAiSettings();
    expect(screen.getByTestId("settings.ai-topic-answering")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("settings.ai-tab-answering"), { key: "ArrowDown" });
    expect(screen.getByTestId("panel.network")).toBeTruthy();
    expect(
      screen.getByTestId("settings.tab-network").getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("wires each tab to its own panel in both directions", () => {
    // The panel is mounted only while its topic is active, so the wiring is
    // asserted from the ACTIVE side after selecting each topic through the strip
    // itself. `aria-controls` pointing at a panel that does not exist is the
    // shape that makes a screen reader announce a tab with nothing behind it.
    renderAiSettings();
    for (const topic of AI_PANEL_TOPICS) {
      fireEvent.click(screen.getByTestId(`settings.ai-tab-${topic.id}`));
      const tab = screen.getByTestId(`settings.ai-tab-${topic.id}`);
      const panel = screen.getByTestId(`settings.ai-topic-${topic.id}`);
      expect(panel.getAttribute("role")).toBe("tabpanel");
      expect(tab.getAttribute("aria-controls")).toBe(panel.getAttribute("id"));
      expect(panel.getAttribute("aria-labelledby")).toBe(tab.getAttribute("id"));
      // Every OTHER topic's body is gone, which is what makes the search's topic
      // step necessary rather than a nicety.
      for (const other of AI_PANEL_TOPICS) {
        if (other.id === topic.id) continue;
        expect(screen.queryByTestId(`settings.ai-topic-${other.id}`)).toBeNull();
      }
    }
  });

  it("renders no strip for a panel with fewer than two topics", () => {
    // The mechanism that keeps every short panel a single screen, without a
    // second, hand-maintained list of which panels are short. The E2E scenario
    // drives the same claim on a real short panel (Files).
    const one: readonly SettingsTopicMeta[] = [AI_PANEL_TOPICS[0]];
    const { container } = render(<SettingsTabs panelId="hotkeys" topics={one} />);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it("keeps the selected topic across a close and a reopen", () => {
    // The rail's own selection is re-derived on every open, and the strip's must
    // survive it: which sub-tab a user was reading is session memory (a
    // `vault.prefs` field would sync it onto the phone). Asserted by closing and
    // reopening the real modal rather than by reading the store, and then by a
    // full unmount, which is the second way the strip goes away.
    const first = renderAiSettings();
    fireEvent.click(screen.getByTestId("settings.ai-tab-limits"));
    expect(screen.getByTestId("settings.ai-topic-limits")).toBeTruthy();

    first.rerender(
      <SettingsModal
        vaultId={null}
        open={false}
        onClose={vi.fn()}
        initialPanel="ai"
        onDeleteVaultSuccess={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("settings.ai-tabs")).toBeNull();
    first.rerender(
      <SettingsModal
        vaultId={null}
        open
        onClose={vi.fn()}
        initialPanel="ai"
        onDeleteVaultSuccess={vi.fn()}
      />,
    );
    expect(screen.getByTestId("settings.ai-tab-limits").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("settings.ai-topic-limits")).toBeTruthy();
    first.unmount();

    renderAiSettings();
    expect(screen.getByTestId("settings.ai-topic-limits")).toBeTruthy();
  });
});

describe("SettingsTabs: the search lands inside the topic", () => {
  it("selects the topic an entry lives in before scrolling to it", async () => {
    // The regression this feature is most likely to ship. `ai.auto-tag` lives in
    // the Models topic (Tagging folded into it, myne-md/myne#867), not the
    // default one, so before the topic step the shell
    // switched the rail panel, found no anchor, and left the user at the top of
    // Answering with no answer.
    renderAiSettings();
    expect(screen.queryByTestId("settings.ai-topic-models")).toBeNull();

    fireEvent.change(screen.getByTestId("settings.search-input"), {
      target: { value: "suggest tags" },
    });

    const row = await waitFor(() => {
      const found = document.querySelector(
        '[data-testid="settings.search-result"][data-setting-id="ai.auto-tag"]',
      );
      if (found === null) throw new Error("the auto-tag result is not listed");
      return found;
    });
    fireEvent.click(row);

    // The query is cleared and the topic that owns the hit is on screen, with the
    // anchor itself present so the scroll has something to land on.
    await waitFor(() =>
      expect(screen.getByTestId("settings.ai-topic-models")).toBeTruthy(),
    );
    expect(screen.queryByTestId("settings.ai-topic-answering")).toBeNull();
    expect(document.querySelector('[data-setting-anchor="ai.auto-tag"]')).not.toBeNull();
  });

  it("still degrades to a plain panel switch for an anchor nothing declares", () => {
    // The deep-link path shares the same channel, and an id the registry does
    // not carry stays a panel switch rather than throwing.
    render(<SettingsModal
      vaultId={null}
      open
      onClose={vi.fn()}
      initialPanel="ai"
      initialAnchor="ai.no-such-setting"
      onDeleteVaultSuccess={vi.fn()}
    />);
    expect(screen.getByTestId("settings.ai-topic-answering")).toBeTruthy();
  });

  it("opens straight into the topic a deep link names, and lands on its row", async () => {
    // The `initialAnchor` path ("Customize ribbon…" and friends) goes through the
    // SAME channel a picked result does, so an anchor inside a non-default topic
    // has to select that topic on this path too. jsdom lays nothing out, so the
    // scroll is captured rather than observed: the claim is WHICH row the shell
    // landed on, plus the topic that made it reachable at all.
    scrolledAnchors.length = 0;
        render(
      <SettingsModal
        vaultId={null}
        open
        onClose={vi.fn()}
        initialPanel="ai"
        initialAnchor="ai.auto-tag"
        onDeleteVaultSuccess={vi.fn()}
      />,
    );
    // The scroll runs in a rAF so the just-mounted topic can lay out first.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(screen.getByTestId("settings.ai-topic-models")).toBeTruthy();
    expect(scrolledAnchors).toEqual(["ai.auto-tag"]);
  });
});
