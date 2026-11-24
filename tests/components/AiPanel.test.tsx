// @vitest-environment jsdom
//
// Component tests for `src/components/settings/AiPanel.tsx` (ai-ux-surface
// MYND-408 + the model-acquisition "Option A" surface). Focus: the per-role
// side-load pickers (generation + transcription + tag) and the "Recommended
// models" browser links that open in the user's OWN browser via the opener
// plugin. Since myne-md/myne#805 the panel also fetches a model on explicit user
// action from Myne's own origin (digest-verified), so Myne no longer never
// downloads a model; the side-load path remains for user-sourced files.
// `openUrl` / the file dialog / `ai-model-store` / `usePrefs` / i18n are mocked
// at their module boundaries.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// Type-only, so it is erased before `vi.hoisted` below runs.
import type { ProviderModel } from "../../src/lib/ai-model-store";

// Hoisted so the mock factories (which run BEFORE module-body consts init) can
// reference these — the canonical vitest pattern for direct factory references.
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
  startModelDownload,
  cancelModelDownloadFor,
} = vi.hoisted(() => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
  openFileDialog: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  loadModelPath: vi.fn(
    (_role?: string): Promise<string | null> => Promise.resolve(null),
  ),
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
  startModelDownload: vi.fn((_artifact: string) => Promise.resolve()),
  cancelModelDownloadFor: vi.fn((_artifact: string) => {}),
}));
vi.mock("../../src/notes/listFolderPaths", () => ({ listFolderPaths }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl, revealItemInDir }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openFileDialog }));
// Partial, and the split is the point: the real `useModelDownload` reads the
// module-scope store, so the catalogue rows behave as they do in production,
// while the two COMMANDS are stubbed so a test can assert the wiring without
// reaching IPC. `AiModelCatalogue.test.tsx` drives the store itself, with a
// controllable state map.
vi.mock("../../src/lib/ai-download-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ai-download-store")>()),
  startModelDownload,
  cancelModelDownloadFor,
}));
// Only the IPC-crossing wrappers are stubbed. `endpointRejectionOf` is a pure
// narrower over the host's wire shape, and stubbing it would leave the thing
// most likely to be wrong — the shape of the error the panel reads — untested.
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
// Partial: `providerLabelOf` moved into this module in #191 task 4 so the chat
// transcript could share the panel's wire → proper-noun table. A full stub
// would leave the real mapping untested while breaking the panel.
vi.mock("../../src/lib/ai-capability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ai-capability")>()),
  // The panel reads the one capability report (SYNC-5) rather than the old
  // per-role probe. Only `autoTag.available` is asserted here; the rest of the
  // report is filled so the shape matches production.
  aiCapabilityReport: () =>
    tagModelAvailable().then((available: boolean) => ({
      compiled: true,
      backendId: "candle",
      // Mutable since myne#466: the panel's "what is answering" caption now
      // reads the HOST's verdict rather than `prefs.ai_provider`, so a test
      // that wants the remote caption has to say the host resolved remote.
      backendClass,
      generation: { available: false, cause: "no_model" },
      transcription: { available: false, cause: "no_model" },
      autoTag: { available, cause: available ? null : "no_model" },
    })),
}));

let aiEnabled = true;
let autoTagEnabled = false;
let aiProvider: string | null = null;
let aiProviderModel: string | null = null;
/** What the HOST says is answering. `in_process_local` is the honest default:
 *  a fresh profile has no provider resolved, whatever the preferences say. */
let backendClass = "in_process_local";
/** The stored budget the panel re-syncs its draft from. `null` is "unset", which
 *  is a third state rather than a zero: zero means seed nothing. */
let chatHistoryBudget: number | null = null;
const setChatHistoryBudget = vi.fn((v: number | null) => {
  chatHistoryBudget = v;
  return Promise.resolve();
});
// MUTABLE, and that is the point (myne-md/myne#613 pr-review). A hard-coded `[]`
// is the state the defect hid in: the panel seeded its textarea and its diff
// baseline from the FIRST render, when `usePrefs` still holds `DEFAULT_PREFS`,
// so a stored exclusion could never be removed through this surface. A test that
// never sees a non-empty stored set cannot tell that from correct behaviour.
let aiExcludedFolders: string[] = [];
const setAiExcludedFoldersMock = vi.fn(
  (_mutation: { add: string[]; remove: string[] }, _folders: string[]): Promise<void> =>
    Promise.resolve(),
);
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: {
      ai_enabled: aiEnabled,
      auto_tag_enabled: autoTagEnabled,
      ai_excluded_folders: aiExcludedFolders,
      ai_provider: aiProvider,
      ai_provider_consent: aiProvider,
      ai_provider_model: aiProviderModel,
      chat_history_budget: chatHistoryBudget,
    },
    setAiEnabled: vi.fn(),
    setAiExcludedFolders: (mutation: { add: string[]; remove: string[] }, folders: string[]) =>
      setAiExcludedFoldersMock(mutation, folders),
    setAutoTagEnabled,
    setChatHistoryBudget,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // `name` and `path` are interpolated so a control's accessible name can be
    // asserted WITH the file in it (myne-md/myne#848) rather than merely that a
    // key rendered, which is the whole claim a location button makes.
    t: (key: string, opts?: { path?: string; name?: string }) =>
      opts?.path !== undefined
        ? `${key}:${opts.path}`
        : opts?.name !== undefined
          ? `${key}:${opts.name}`
          : key,
  }),
}));

import { AiPanel } from "../../src/components/settings/AiPanel";
import { SETTINGS_SEARCH_INDEX } from "../../src/components/settings/search/settingsSearchIndex";
import {
  AI_PANEL_TOPICS,
  type SettingsTopicId,
} from "../../src/components/settings/settingsTopics";
import {
  resetSettingsTopics,
  setActiveSettingsTopic,
} from "../../src/components/settings/SettingsTabs";
import {
  AI_TRUST_INVARIANT,
  aiTrustHeadline,
} from "../../src/lib/load-bearing-copy";

/**
 * Point the AI panel at `topic` before rendering it.
 *
 * The panel shows ONE topic at a time (myne-md/myne#885): an inactive topic's
 * body is not mounted, so a test that reaches a control in another topic has to
 * select that topic first, exactly as a user does. It writes through the same
 * module-scope store the strip writes through, so a test cannot drift from the
 * real navigation path, and it is called BEFORE `render` because a store write
 * with a mounted subscriber would be a state update outside `act()`.
 */
function selectAiTopic(topic: SettingsTopicId): void {
  setActiveSettingsTopic("ai", topic);
}

beforeEach(() => {
  // Every test starts on the panel's first topic. The active topic is session
  // memory in a module-scope store (that IS the feature), so without this a
  // topic selected by one test would leak into the next.
  resetSettingsTopics();
  aiEnabled = true;
  autoTagEnabled = false;
  aiProvider = null;
  aiProviderModel = null;
  backendClass = "in_process_local";
  listProviderModels.mockClear();
  listProviderModels.mockResolvedValue([]);
  aiProviderHasKey.mockClear();
  aiProviderHasKey.mockResolvedValue(false);
  openUrl.mockClear();
  openFileDialog.mockClear();
  loadModelPath.mockClear();
  saveModelPath.mockClear();
  setAutoTagEnabled.mockClear();
  setAutoTagEnabled.mockResolvedValue(undefined);
  tagModelAvailable.mockClear();
  tagModelAvailable.mockResolvedValue(true);
  loadAiEndpoint.mockClear();
  loadAiEndpoint.mockResolvedValue(null);
  saveAiEndpoint.mockClear();
  saveAiEndpoint.mockImplementation((u: string, _m: string) => Promise.resolve(u || null));
  startModelDownload.mockClear();
  startModelDownload.mockImplementation(() => Promise.resolve());
  cancelModelDownloadFor.mockClear();
});
afterEach(() => cleanup());

describe("AiPanel — models section (Option A: side-load + recommended browser links)", () => {
  it("renders the role pickers (generation + transcription + tag) and the models section", () => {
    selectAiTopic("models");
    render(<AiPanel />);
    expect(screen.getByTestId("ai.models-section")).toBeTruthy();
    // Generation picker (the original testids, preserved).
    expect(screen.getByTestId("ai.model-select")).toBeTruthy();
    expect(screen.getByTestId("ai.model-choose")).toBeTruthy();
    // The transcription and tag twins.
    expect(screen.getByTestId("ai.model-select-transcription")).toBeTruthy();
    expect(screen.getByTestId("ai.model-choose-transcription")).toBeTruthy();
    expect(screen.getByTestId("ai.model-select-tag")).toBeTruthy();
    expect(screen.getByTestId("ai.model-choose-tag")).toBeTruthy();
  });

  it("renders the load-bearing invariant and the in-process headline verbatim", () => {
    render(<AiPanel />);
    // The invariant is shown in every state; the headline varies. With no
    // provider and no endpoint stored, the state is in-process.
    expect(screen.getByTestId("ai.trust-invariant").textContent).toBe(AI_TRUST_INVARIANT);
    expect(screen.getByTestId("ai.trust-headline").textContent).toBe(
      aiTrustHeadline({ kind: "in-process" }),
    );
  });

  it("switches the headline to the REMOTE wording once a provider is named", async () => {
    // The regression this whole copy edit exists to prevent: showing "runs
    // entirely on your device" in front of a configured provider.
    aiProvider = "openrouter";
    render(<AiPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("ai.trust-headline").textContent).toBe(
        aiTrustHeadline({ kind: "remote", provider: "openrouter" }),
      ),
    );
    expect(screen.getByTestId("ai.trust-headline").textContent).not.toContain(
      "entirely on your device",
    );
    // …and the invariant is unchanged, because it is true in every state.
    expect(screen.getByTestId("ai.trust-invariant").textContent).toBe(AI_TRUST_INVARIANT);
  });

  it("carries the trust copy in a banner whose glyph follows the state", async () => {
    // **The copy is load-bearing and the FORM is not free** (myne-md/myne#848).
    // Three plain paragraphs in the middle of a settings panel read as one more
    // setting, and the question a user arrives with, does anything of mine
    // leave this machine?, had no answer you could take in without reading.
    // The glyph is the state, so each of the three is driven separately: a
    // banner that painted one glyph for every state would pass a single-state
    // check and be worse than no glyph at all.
    const { unmount } = render(<AiPanel />);
    const banner = screen.getByTestId("ai.trust-banner");
    expect(banner.contains(screen.getByTestId("ai.trust-headline"))).toBe(true);
    expect(banner.contains(screen.getByTestId("ai.active-provider"))).toBe(true);
    expect(screen.getByTestId("ai.trust-glyph").getAttribute("data-state")).toBe(
      "in-process",
    );
    expect(screen.getByTestId("ai.trust-glyph").getAttribute("data-icon")).toBe("cpu");
    unmount();

    aiProvider = "openrouter";
    backendClass = "remote";
    const remote = render(<AiPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("ai.trust-glyph").getAttribute("data-state")).toBe(
        "remote",
      ),
    );
    // A DIFFERENT glyph, not merely a different attribute on the same one.
    expect(screen.getByTestId("ai.trust-glyph").getAttribute("data-icon")).toBe("globe");
    remote.unmount();

    // The provider has to be unset first: a named provider wins over an
    // endpoint, which is the order the panel derives the state in.
    aiProvider = null;
    backendClass = "loopback_local";
    loadAiEndpoint.mockResolvedValue({ url: "http://127.0.0.1:11434", model: "qwen" });
    render(<AiPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("ai.trust-glyph").getAttribute("data-state")).toBe(
        "local-runtime",
      ),
    );
    expect(screen.getByTestId("ai.trust-glyph").getAttribute("data-icon")).toBe(
      "hard-drive",
    );
  });

  it("carries no in-body group heading, because the groups are the topic tabs", () => {
    // The four group headings this panel used to draw (a rule plus a title one
    // step up from the rows it grouped, myne-md/myne#848) are the topic labels in
    // the strip the modal renders above the panel since myne-md/myne#885. An
    // `h4` left behind would only repeat the tab the user just clicked, and it
    // would also be a second section treatment in a tree that is meant to have
    // exactly one (`SettingsSection`). The retired headings are named so the
    // assertion fails by NAME if one comes back, rather than only by count.
    render(<AiPanel />);
    const panel = screen.getByTestId("settings.ai-panel");
    expect(screen.queryAllByRole("heading", { level: 4 })).toEqual([]);
    for (const retired of ["groupAutoTag", "groupVoice", "groupWriting", "groupPrivacy"]) {
      expect(panel.textContent).not.toContain(`settings.ai.${retired}`);
    }
  });

  it("gives the meeting prompt the panel's own field shape", () => {
    // An unstyled `<textarea>` falls back to the WebView's white default, which
    // is what made this the one control in the panel that did not come from the
    // tokens (myne-md/myne#848).
    selectAiTopic("advanced");
    render(<AiPanel />);
    const box = screen.getByTestId("ai.meeting-prompt-input");
    expect(box.style.background).toContain("var(--paper-2)");
    expect(box.style.color).toContain("var(--fg-1)");
  });

  it("opens the recommended GENERATION model in the browser (not a Myne fetch)", () => {
    selectAiTopic("models");
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.model-recommend-generation"));
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl.mock.calls[0][0]).toContain("huggingface.co");
    expect(openUrl.mock.calls[0][0]).toContain("Qwen2.5-1.5B-Instruct-GGUF");
  });

  it("opens the recommended TAG model in the browser", () => {
    selectAiTopic("models");
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.model-recommend-tag"));
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl.mock.calls[0][0]).toContain("Qwen2.5-0.5B-Instruct-GGUF");
  });

  it("side-loads a picked file per role and never triggers a network download", async () => {
    openFileDialog.mockResolvedValueOnce("/Users/me/models/qwen.gguf");
    selectAiTopic("models");
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.model-choose"));
    // The choose path persists via saveModelPath (device-local), NOT a download.
    await Promise.resolve();
    await Promise.resolve();
    expect(saveModelPath).toHaveBeenCalledWith("generation", "/Users/me/models/qwen.gguf");
    expect(openUrl).not.toHaveBeenCalled(); // choosing a file is not a network op
  });

  it("disables the pickers when AI is off", () => {
    aiEnabled = false;
    selectAiTopic("models");
    render(<AiPanel />);
    expect((screen.getByTestId("ai.model-choose") as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByTestId("ai.model-choose-transcription") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("AiPanel — auto-tag toggle (MYND-651)", () => {
  // The switch renders `prefs.auto_tag_enabled` and delegates the write to
  // `usePrefs`, which owns the optimistic-then-converge discipline (and is
  // covered for it in `tests/hooks/usePrefs.test.ts`). What is the PANEL's to
  // get right is that it reads and writes the right pref, and that the co-gate
  // on `ai_enabled` holds.
  it("renders off by default and persists an ON flip", () => {
    selectAiTopic("models");
    render(<AiPanel />);
    const toggle = screen.getByTestId("ai.auto-tag-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(setAutoTagEnabled).toHaveBeenCalledWith(true);
  });

  it("reflects the persisted value when it is already on", () => {
    autoTagEnabled = true;
    selectAiTopic("models");
    render(<AiPanel />);
    expect(screen.getByTestId("ai.auto-tag-toggle").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("ai.auto-tag-toggle"));
    expect(setAutoTagEnabled).toHaveBeenCalledWith(false);
  });

  it("is non-interactive while the AI beta is off (co-gate, not a second switch)", () => {
    aiEnabled = false;
    selectAiTopic("models");
    render(<AiPanel />);
    const toggle = screen.getByTestId("ai.auto-tag-toggle") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(setAutoTagEnabled).not.toHaveBeenCalled();
  });
});

describe("AiPanel — auto-tag on a build with no bundled tag model (MYND-651)", () => {
  // The tag role is bundled-only (`threat-model.md` §7: no override picker), so
  // "no model" is not something the user can fix by side-loading. An offered
  // switch would persist `true` against a host answering `not_ready` forever,
  // with no surface anywhere saying why — the panel has to say it.
  it("disables the switch and states the reason once the probe answers", async () => {
    tagModelAvailable.mockResolvedValue(false);
    selectAiTopic("models");
    render(<AiPanel />);

    // Before the probe resolves the switch must NOT flash through a disabled
    // state — `null` is "unknown", not "unavailable".
    expect((screen.getByTestId("ai.auto-tag-toggle") as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.queryByTestId("ai.auto-tag-unavailable")).toBeNull();

    await screen.findByTestId("ai.auto-tag-unavailable");
    const toggle = screen.getByTestId("ai.auto-tag-toggle") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(setAutoTagEnabled).not.toHaveBeenCalled();
  });

  it("probes independently of the AI beta switch, so turning AI on is not a surprise", async () => {
    aiEnabled = false;
    tagModelAvailable.mockResolvedValue(false);
    selectAiTopic("models");
    render(<AiPanel />);
    await screen.findByTestId("ai.auto-tag-unavailable");
    expect(tagModelAvailable).toHaveBeenCalledTimes(1);
  });

  it("leaves the switch offerable when a tag model does ship", async () => {
    selectAiTopic("models");
    render(<AiPanel />);
    await waitFor(() => expect(tagModelAvailable).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByTestId("ai.auto-tag-toggle") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.queryByTestId("ai.auto-tag-unavailable")).toBeNull();
  });
});

describe("AiPanel — the local model runtime endpoint row (ai-ollama-local task 8)", () => {
  it("ships the field EMPTY, with the conventional address only as placeholder", async () => {
    render(<AiPanel />);
    const input = (await screen.findByTestId("ai.endpoint-input")) as HTMLInputElement;
    // A stored default would be Myne naming an endpoint the user did not —
    // the default-state invariant of `decisions.md` 2026-08-09.
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("http://127.0.0.1:11434");
    expect(saveAiEndpoint).not.toHaveBeenCalled();
  });

  it("shows a persisted endpoint once the host answers", async () => {
    loadAiEndpoint.mockResolvedValue({
      url: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
    });
    render(<AiPanel />);
    await waitFor(() =>
      expect((screen.getByTestId("ai.endpoint-input") as HTMLInputElement).value).toBe(
        "http://127.0.0.1:11434",
      ),
    );
    expect((screen.getByTestId("ai.endpoint-model-input") as HTMLInputElement).value).toBe(
      "nomic-embed-text",
    );
  });

  it("names the runtime, links it through the OS handoff, and discloses generically", () => {
    render(<AiPanel />);
    const link = screen.getByTestId("ai.endpoint-runtime-link");
    expect(link.textContent).toContain("Ollama");
    fireEvent.click(link);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl.mock.calls[0][0]).toBe("https://ollama.com");
    // The disclosure exists and is a separate element from the link, so E2E can
    // assert it independently of the affordance.
    expect(screen.getByTestId("ai.endpoint-third-party")).toBeTruthy();
  });

  it("persists a loopback URL on blur and shows what the host stored", async () => {
    render(<AiPanel />);
    const input = screen.getByTestId("ai.endpoint-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  http://localhost:11434  " } });
    fireEvent.change(screen.getByTestId("ai.endpoint-model-input"), {
      target: { value: "nomic-embed-text" },
    });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(saveAiEndpoint).toHaveBeenCalledWith(
        "http://localhost:11434",
        "nomic-embed-text",
      ),
    );
    expect(screen.queryByTestId("ai.endpoint-error")).toBeNull();
  });

  it("ships the model field empty too — Myne picks no model (SYNC-24)", async () => {
    render(<AiPanel />);
    const model = (await screen.findByTestId(
      "ai.endpoint-model-input",
    )) as HTMLInputElement;
    expect(model.value).toBe("");
  });

  it("stores a URL with no model, so a half-filled row builds no engine", async () => {
    render(<AiPanel />);
    const input = screen.getByTestId("ai.endpoint-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "http://127.0.0.1:11434" } });
    fireEvent.blur(input);
    // The empty model reaches the host, which stores it and reports the arm
    // unusable — better than the panel silently withholding the write, because
    // the user's typed address survives a restart either way.
    await waitFor(() =>
      expect(saveAiEndpoint).toHaveBeenCalledWith("http://127.0.0.1:11434", ""),
    );
  });

  it("surfaces the refusal RULE and never echoes the URL that was refused", async () => {
    // The host's real wire shape (serde `tag = "kind"` / `content = "detail"`),
    // narrowed by the production `endpointRejectionOf` — not a stubbed one.
    saveAiEndpoint.mockRejectedValueOnce({
      kind: "Rejected",
      detail: { reason: "not_loopback" },
    });
    render(<AiPanel />);
    const input = screen.getByTestId("ai.endpoint-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "http://evil.example.com:11434" } });
    fireEvent.blur(input);

    const err = await screen.findByTestId("ai.endpoint-error");
    expect(err.textContent).toBe("settings.ai.endpointRejected.notLoopback");
    // The refused input must not be repeated into the message — a settings
    // field's contents reach screenshots and bug reports.
    expect(err.textContent).not.toContain("evil.example.com");
    expect(input.getAttribute("aria-describedby")).toBe("ai-endpoint-error");
  });

  it("clears a stale refusal as soon as the input changes", async () => {
    saveAiEndpoint.mockRejectedValueOnce({
      kind: "Rejected",
      detail: { reason: "malformed" },
    });
    render(<AiPanel />);
    const input = screen.getByTestId("ai.endpoint-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "not-a-url" } });
    fireEvent.blur(input);
    await screen.findByTestId("ai.endpoint-error");

    // Leaving the old rule up would attach it to a URL it never judged.
    fireEvent.change(input, { target: { value: "http://127.0.0.1:11434" } });
    expect(screen.queryByTestId("ai.endpoint-error")).toBeNull();
  });

  it("treats a non-refusal failure as a toast, not as an inline field error", async () => {
    // An IO failure is not a judgement about this URL, so it must not render
    // under the field as though it were.
    saveAiEndpoint.mockRejectedValueOnce({
      kind: "Io",
      detail: { io_error_kind: "PermissionDenied" },
    });
    const onShowToast = vi.fn();
    render(<AiPanel onShowToast={onShowToast} />);
    fireEvent.blur(screen.getByTestId("ai.endpoint-input"), {});
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith("settings.ai.endpointSaveFailed"),
    );
    expect(screen.queryByTestId("ai.endpoint-error")).toBeNull();
  });

  it("is non-interactive while the AI beta is off (the same co-gate as the pickers)", () => {
    aiEnabled = false;
    render(<AiPanel />);
    expect((screen.getByTestId("ai.endpoint-input") as HTMLInputElement).disabled).toBe(true);
  });
});

// The model chooser (myne#415 task 17, SYNC-24). What is worth asserting here
// is the THREE-STATE distinction: Myne ships no default model, so the panel has
// to say which of "nobody asked", "the provider published none" and "asking was
// refused" it is in. Collapsing any two would tell the user something false.
describe("AiPanel — the provider model chooser", () => {
  beforeEach(() => {
    aiProvider = "openrouter";
  });

  it("starts unfetched, and does not ask the provider merely because the panel opened", async () => {
    render(<AiPanel />);
    // Nothing has been asked for, so the row says nothing beyond itself: the
    // chooser names the stored model and the load button sits beside it. It used
    // to print "Load the list to choose a model." here, which is the button.
    await waitFor(() =>
      expect(screen.queryByTestId("ai.provider-model-state")).toBeNull(),
    );
    // The call is an egress. Opening a settings panel is not a user asking to
    // reach a provider, and a panel that fetched on mount would be sending on
    // nobody's instruction.
    expect(listProviderModels).not.toHaveBeenCalled();
  });

  it("cannot ask before a key is stored — there is nothing to ask with", async () => {
    aiProviderHasKey.mockResolvedValue(false);
    render(<AiPanel />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("ai.provider-model-load") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });

  it("an empty catalogue is its own state, not 'not fetched'", async () => {
    aiProviderHasKey.mockResolvedValue(true);
    listProviderModels.mockResolvedValue([]);
    render(<AiPanel />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("ai.provider-model-load") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId("ai.provider-model-load"));
    await waitFor(() =>
      expect(screen.getByTestId("ai.provider-model-state").textContent).toBe(
        "settings.ai.providerModelEmpty",
      ),
    );
  });

  it("a refusal names the cause from the shared taxonomy, and keeps the list unset", async () => {
    aiProviderHasKey.mockResolvedValue(true);
    listProviderModels.mockRejectedValue({ kind: "Unauthorized" });
    render(<AiPanel />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("ai.provider-model-load") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId("ai.provider-model-load"));
    await waitFor(() =>
      expect(screen.getByTestId("ai.provider-model-state").textContent).toBe(
        "settings.ai.providerError.unauthorized",
      ),
    );
    // Not an empty list: "we could not ask" and "there are none" are different
    // facts and the chooser must not conflate them.
    expect(screen.queryByTestId("ai.provider-model-select")).toBeNull();
  });

  it("renders the provider's own list once fetched, with the stored choice selected", async () => {
    aiProviderHasKey.mockResolvedValue(true);
    aiProviderModel = "qwen/qwen3-30b";
    listProviderModels.mockResolvedValue([
      { id: "meta-llama/llama-3.1-8b", text_capable: true },
      { id: "qwen/qwen3-30b", text_capable: true },
    ]);
    render(<AiPanel />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("ai.provider-model-load") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId("ai.provider-model-load"));
    await waitFor(() =>
      expect(screen.getByTestId("ai.provider-model-state").textContent).toBe(
        "settings.ai.providerModelCount",
      ),
    );
    expect(screen.getByTestId("ai.provider-model-select")).toBeTruthy();
  });
});

// The text-only filter. Myne's remote arm calls nothing but chat/completion, so
// offering a model that cannot read and write text is offering a request that
// fails — on a metered API, after billing. What is worth asserting is that the
// filter HIDES rather than DROPS: every one of these cases turns on a model
// still being reachable, which a hard filter would make untestable because it
// would also be untrue.
describe("AiPanel — only text models are offered", () => {
  /** Open the chooser's option list and read back what it offers. */
  const optionValues = (): string[] => {
    fireEvent.click(screen.getByTestId("ai.provider-model-select"));
    return screen
      .getAllByTestId("ai.provider-model-select-option")
      .map((el) => el.getAttribute("data-value") ?? "");
  };

  const loaded = async (models: ProviderModel[]) => {
    aiProviderHasKey.mockResolvedValue(true);
    listProviderModels.mockResolvedValue(models);
    render(<AiPanel />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("ai.provider-model-load") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId("ai.provider-model-load"));
    // Wait on the state line rather than on the chooser: when the filter leaves
    // nothing to choose from there IS no chooser, and that is one of the cases
    // below — a helper that waited for it would make that test unwritable. The
    // line exists only once a list came back, so its presence IS the signal.
    await waitFor(() =>
      expect(screen.getByTestId("ai.provider-model-state")).not.toBeNull(),
    );
  };

  beforeEach(() => {
    aiProvider = "openrouter";
  });

  it("leaves a non-text model out of the list, and says how many it withheld", async () => {
    await loaded([
      { id: "vendor/chatty", text_capable: true },
      { id: "vendor/painter", text_capable: false },
    ]);
    expect(optionValues()).toEqual(["", "vendor/chatty"]);
    // The count is of what is OFFERED, and the hidden ones are accounted for
    // rather than silently absent — an unexplained short list reads as the
    // provider having fewer models than it does.
    expect(screen.getByTestId("ai.provider-model-state").textContent).toContain(
      "settings.ai.providerModelHidden",
    );
  });

  it("shows the withheld models on request, over the SAME fetch", async () => {
    await loaded([
      { id: "vendor/chatty", text_capable: true },
      { id: "vendor/painter", text_capable: false },
    ]);
    fireEvent.click(screen.getByTestId("ai.provider-model-show-all"));
    expect(optionValues()).toEqual(["", "vendor/chatty", "vendor/painter"]);
    // One egress, not two: revealing what was already fetched must not ask the
    // provider again — the listing call is gated precisely because it is one.
    expect(listProviderModels).toHaveBeenCalledTimes(1);
  });

  it("offers no escape hatch when the filter withheld nothing", async () => {
    await loaded([{ id: "vendor/chatty", text_capable: true }]);
    // A permanent "show all" implies something is being kept back when nothing
    // is.
    expect(screen.queryByTestId("ai.provider-model-show-all")).toBeNull();
  });

  it("keeps a stored non-text model selectable, filter or no filter", async () => {
    // The model a user picked before this filter existed, or wrote via the CLI.
    // It is stored and it is what answers; leaving it out of the options makes
    // the panel summarise an empty selection and report "No model chosen" about
    // a vault that has one.
    aiProviderModel = "vendor/painter";
    await loaded([
      { id: "vendor/chatty", text_capable: true },
      { id: "vendor/painter", text_capable: false },
    ]);
    expect(optionValues()).toContain("vendor/painter");
  });

  it("a catalogue with no text model in it is its own state, not an empty one", async () => {
    await loaded([{ id: "vendor/painter", text_capable: false }]);
    // "This provider published no models" would be false: it published one.
    // The true statement is that none of them are the kind Myne asks for.
    expect(screen.getByTestId("ai.provider-model-state").textContent).toBe(
      "settings.ai.providerModelNoTextModels",
    );
  });
});

// The resting provider caption (#191 task 5, SYNC-13). Two states, and the
// distinction that matters is that "nothing is set up" is a STATE, not an
// error and not an empty string.
describe("AiPanel — what is answering right now", () => {
  it("names the remote provider when one is selected", async () => {
    aiProvider = "openrouter";
    backendClass = "remote";
    render(<AiPanel />);
    // The NAME is in the assertion, not merely the key: the caption's job is to
    // say which provider is answering, and a caption that rendered the key
    // without its name would satisfy a key-only check (myne-md/myne#848).
    await waitFor(() =>
      expect(screen.getByTestId("ai.active-provider").textContent).toBe(
        "settings.ai.providerActive:OpenRouter",
      ),
    );
  });

  it("names the device-local endpoint when one is configured", async () => {
    backendClass = "loopback_local";
    loadAiEndpoint.mockResolvedValue({ url: "http://127.0.0.1:11434", model: "qwen" });
    render(<AiPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("ai.active-provider").textContent).toBe(
        "settings.ai.providerActive:http://127.0.0.1:11434",
      ),
    );
  });

  it("says nothing is set up when neither is", async () => {
    render(<AiPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("ai.active-provider").textContent).toBe(
        "settings.ai.providerNothingAnswering",
      ),
    );
  });

  // myne#466. A provider NAMED is one of the seven conditions
  // `LocalInferenceState::active()` checks; the other six can fail silently,
  // and then every request goes to the local arm. The caption used to read
  // `prefs.ai_provider` alone and claim the provider was answering anyway — so
  // when the local engine failed, the failure looked like the provider's, and
  // the user went looking at an account that had never been contacted.
  it("does not name a provider the host did not actually resolve", async () => {
    aiProvider = "openrouter";
    aiProviderModel = null; // the condition users trip over: no model chosen
    backendClass = "in_process_local"; // …so the host resolved LOCAL
    render(<AiPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("ai.active-provider").textContent).toBe(
        "settings.ai.providerNothingAnswering",
      ),
    );
  });

  // The caption and the trust headline answer different questions, and the
  // asymmetry is the safety direction. Asserting them TOGETHER is the point: a
  // future edit that "tidies" both onto one source breaks exactly one of these
  // two expectations, whichever source it picks.
  it("still warns about egress while declining to claim the provider answered", async () => {
    aiProvider = "openrouter";
    aiProviderModel = null;
    backendClass = "in_process_local";
    render(<AiPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("ai.active-provider").textContent).toBe(
        "settings.ai.providerNothingAnswering",
      ),
    );
    // Over-claiming egress makes a user more careful than they need to be;
    // under-claiming tells them their text stays here while it leaves. This
    // configuration is one keystroke — picking a model — from sending.
    expect(screen.getByTestId("ai.trust-headline").textContent).toBe(
      aiTrustHeadline({ kind: "remote", provider: "openrouter" }),
    );
  });

  it("is a caption, not a control — it adds no setting row", () => {
    aiProvider = "openrouter";
    backendClass = "remote";
    render(<AiPanel />);
    const caption = screen.getByTestId("ai.active-provider");
    expect(caption.tagName).toBe("P");
    // A `SettingRow` would owe a `settingsSearchIndex.ts` entry in the same
    // change (src/AGENTS.md); a caption does not, and this is what keeps that
    // claim true rather than remembered.
    expect(caption.closest("[data-setting-row]")).toBeNull();
  });
});

/**
 * The chat-history budget control (myne-md/myne#617).
 *
 * Four unasserted branches used to sit between a typed number and how much
 * plaintext leaves the device, and one of them was a defect review found: for
 * `type="number"` the value IDL attribute returns "" for anything the control
 * cannot parse, so "abc" took the clear-the-override branch and silently reset
 * the bound to the host default. A control whose whole purpose is a privacy
 * bound owes coverage more than most.
 */
describe("the chat-history budget control", () => {
  const input = () => screen.getByLabelText("settings.ai.historyBudgetLabel");

  beforeEach(() => {
    chatHistoryBudget = null;
    setChatHistoryBudget.mockClear();
  });

  it("has an accessible name, since SettingRow renders its label as a span", () => {
    selectAiTopic("limits");
    render(<AiPanel onShowToast={() => {}} />);
    expect(input()).toBeTruthy();
  });

  it("stores a number the user typed", async () => {
    selectAiTopic("limits");
    render(<AiPanel onShowToast={() => {}} />);
    fireEvent.change(input(), { target: { value: "500" } });
    fireEvent.blur(input());
    await waitFor(() => expect(setChatHistoryBudget).toHaveBeenCalledWith(500));
  });

  it("clears the override when the field is genuinely empty", async () => {
    chatHistoryBudget = 500;
    selectAiTopic("limits");
    render(<AiPanel onShowToast={() => {}} />);
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.blur(input());
    await waitFor(() => expect(setChatHistoryBudget).toHaveBeenCalledWith(null));
  });

  it("does NOT clear the override when the field holds unparseable input", async () => {
    // The defect: jsdom mirrors the browser here, so `value` is "" and
    // `validity.badInput` is what tells the two apart. A user who select-alls,
    // mistypes and tabs away must not have their bound silently reset.
    chatHistoryBudget = 500;
    selectAiTopic("limits");
    render(<AiPanel onShowToast={() => {}} />);
    const el = input() as HTMLInputElement;
    Object.defineProperty(el, "validity", {
      configurable: true,
      value: { badInput: true },
    });
    fireEvent.change(el, { target: { value: "" } });
    fireEvent.blur(el);
    await waitFor(() => expect(el.value).toBe("500"));
    expect(setChatHistoryBudget).not.toHaveBeenCalled();
  });

  it("rejects a negative number rather than coercing it", async () => {
    selectAiTopic("limits");
    render(<AiPanel onShowToast={() => {}} />);
    fireEvent.change(input(), { target: { value: "-5" } });
    fireEvent.blur(input());
    await waitFor(() => expect(setChatHistoryBudget).not.toHaveBeenCalled());
  });

  it("is disabled when AI is off, like every other control in this panel", () => {
    aiEnabled = false;
    selectAiTopic("limits");
    render(<AiPanel onShowToast={() => {}} />);
    expect((input() as HTMLInputElement).disabled).toBe(true);
    aiEnabled = true;
  });

  it("names the default an empty field means (issue #970, item 3)", () => {
    // Unset renders as "": a blank box with a native stepper and no text, which
    // reads as a control that failed to load. The placeholder is greyed by the
    // browser, so it cannot be mistaken for a stored value, and the helper's
    // "leave empty for the default" stops being a promise about a mystery.
    chatHistoryBudget = null;
    selectAiTopic("limits");
    render(<AiPanel onShowToast={() => {}} />);
    const el = input() as HTMLInputElement;
    expect(el.value).toBe("");
    expect(el.placeholder).toBe("3000");
    expect(el.inputMode).toBe("numeric");
    expect(el.step).toBe("1");
  });

  it("does not use the placeholder as a value when the user has set one", () => {
    chatHistoryBudget = 500;
    selectAiTopic("limits");
    render(<AiPanel onShowToast={() => {}} />);
    expect((input() as HTMLInputElement).value).toBe("500");
  });
});

// ---------------------------------------------------------------------------
// myne-md/myne#613 (pr-review): the excluded-folders editor must be able to
// REMOVE.
//
// `ai_excluded_folders` is the control `docs/threat-model.md` A17 rests its
// remote-provider mitigation on. The panel seeded its draft and its diff
// baseline from `usePrefs`, whose first render is `DEFAULT_PREFS`, so both
// captured the empty list and `mutationFrom([], folders)` was add-only. Before
// the add/remove verbs the whole-set write DID remove, destructively but
// effectively, so the fix for this issue took removal away from an egress
// control.
// ---------------------------------------------------------------------------

describe("AiPanel: the excluded-folders editor after the prefs read lands", () => {
  beforeEach(() => {
    aiExcludedFolders = [];
    setAiExcludedFoldersMock.mockReset();
    aiEnabled = true;
  });

  it("shows the stored set once it arrives, not the empty first render", async () => {
    selectAiTopic("limits");
    const { rerender } = render(<AiPanel />);
    // The read lands AFTER the first render, which is what `usePrefs` does.
    aiExcludedFolders = ["Private/", "Money/"];
    rerender(<AiPanel />);
    const box = (await screen.findByTestId(
      "ai.excluded-folders",
    )) as HTMLTextAreaElement;
    expect(box.value).toBe("Private/\nMoney/");
  });

  it("a removal reaches the write as a removal", async () => {
    selectAiTopic("limits");
    const { rerender } = render(<AiPanel />);
    aiExcludedFolders = ["Private/", "Money/"];
    rerender(<AiPanel />);
    const box = (await screen.findByTestId(
      "ai.excluded-folders",
    )) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Private/" } });
    fireEvent.blur(box);
    // THE ASSERTION. Pre-fix the mutation was `{ add: ["Private/"], remove: [] }`,
    // so the folder the user deleted stayed excluded on disk forever.
    const [mutation] = setAiExcludedFoldersMock.mock.calls[0] as [
      { add: string[]; remove: string[] },
      string[],
    ];
    expect(mutation.remove).toEqual(["Money/"]);
    expect(mutation.add).toEqual([]);
  });

  it("does not clobber an edit that started before the read landed", async () => {
    // Why the re-seed is guarded rather than unconditional: a user who began
    // typing into the empty box must not have it replaced under them.
    selectAiTopic("limits");
    const { rerender } = render(<AiPanel />);
    const box = (await screen.findByTestId(
      "ai.excluded-folders",
    )) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "TypedFirst/" } });
    aiExcludedFolders = ["Private/"];
    rerender(<AiPanel />);
    expect(
      (screen.getByTestId("ai.excluded-folders") as HTMLTextAreaElement).value,
    ).toBe("TypedFirst/");
  });
});

// myne-md/myne#848 grouped the panel by INTENT; myne-md/myne#867 took that from
// five headings to four, because three of the five were a heading per control;
// myne-md/myne#885 turned the four into TOPICS, one of which the tag role's own
// model row earned on its own. The excluded-folders box gained a picker, and an
// installed model stopped offering a download.
describe("AiPanel: grouped by intent", () => {
  it("shows exactly one topic's body at a time, and every topic has one", () => {
    // Only the active topic is mounted, which is the mechanism the search's
    // landing depends on (an anchor inside an inactive topic is not in the
    // document) and what makes a topic reachable without scrolling past the
    // others. Asserted as a full cross product, so a body that rendered under
    // two topics or none fails by name.
    for (const active of AI_PANEL_TOPICS) {
      resetSettingsTopics();
      setActiveSettingsTopic("ai", active.id);
      const { unmount } = render(<AiPanel />);
      const panel = screen.getByTestId("settings.ai-panel");
      for (const other of AI_PANEL_TOPICS) {
        const body = panel.querySelector(`[data-testid="settings.ai-topic-${other.id}"]`);
        if (other.id === active.id) {
          expect(body, `the active topic ${other.id} must render`).not.toBeNull();
        } else {
          expect(body, `inactive topic ${other.id} must not be mounted`).toBeNull();
        }
      }
      unmount();
    }
  });

  it("puts the trust card and then the master switch first in the Answering topic", () => {
    // The card says what turning AI on means, so it is read before the switch
    // (myne-md/myne#885 visual pass). Compared on the testids OUTSIDE the card,
    // because the card's own children carry testids of their own.
    render(<AiPanel />);
    const body = screen.getByTestId("settings.ai-topic-answering");
    const banner = screen.getByTestId("ai.trust-banner");
    const order = [...body.querySelectorAll("[data-testid]")]
      .filter((el) => el === banner || !banner.contains(el))
      .map((el) => el.getAttribute("data-testid"));
    expect(order.slice(0, 2)).toEqual(["ai.trust-banner", "ai.enable-toggle"]);
  });
});

describe("AiPanel: the excluded-folders picker", () => {
  beforeEach(() => {
    // **Both, and the seed one is not tidiness.** `aiExcludedFolders` is
    // module-level state the panel seeds its draft from, so a previous test
    // leaving "Private/" in it makes the box contain the expected value before
    // any click, and the assertion below then passes with the picker unwired.
    // The precondition assertion in the test is what makes that visible.
    aiExcludedFolders = [];
    setAiExcludedFoldersMock.mockReset();
  });

  it("appends the picked folder to the box and commits it", async () => {
    listFolderPaths.mockResolvedValue([{ path: "Private/", label: "Private" }]);
    selectAiTopic("limits");
    render(<AiPanel />);
    const picker = await screen.findByTestId("ai.excluded-folders-picker");
    // Precondition: the box starts empty, so what follows is the picker's doing.
    expect((screen.getByTestId("ai.excluded-folders") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(picker);
    fireEvent.click(
      screen
        .getAllByTestId("ai.excluded-folders-picker-option")
        .find((o) => o.getAttribute("data-value") === "Private/")!,
    );
    const box = screen.getByTestId("ai.excluded-folders") as HTMLTextAreaElement;
    expect(box.value).toContain("Private/");
    // Committed, not merely typed: the exclusion is a privacy control, so a
    // picker that only filled the box in would leave the user to blur the field
    // before it took effect.
    expect(setAiExcludedFoldersMock).toHaveBeenCalled();
    expect(setAiExcludedFoldersMock.mock.calls.at(-1)![1]).toEqual(["Private/"]);
  });

  it("keeps the box as the authority: a typed line still works", async () => {
    listFolderPaths.mockResolvedValue([{ path: "Private/", label: "Private" }]);
    selectAiTopic("limits");
    render(<AiPanel />);
    const box = await screen.findByTestId("ai.excluded-folders");
    fireEvent.change(box, { target: { value: "Typed/By/Hand/" } });
    fireEvent.blur(box);
    await waitFor(() =>
      expect(setAiExcludedFoldersMock.mock.calls.at(-1)![1]).toEqual([
        "Typed/By/Hand/",
      ]),
    );
  });

  it("sits in the Excluded folders row's control slot, on the label's own line", async () => {
    // **The requester's own geometry, asserted as DOM shape rather than
    // eyeballed** (myne-md/myne#885): "I want this dropdown aligned with the
    // `Excluded folders` heading, at the far right". jsdom lays nothing out, so
    // the "same line" half is carried by the STRUCTURE `SettingRow` guarantees:
    // the label and the control slot are the two children of one flex row, the
    // control slot is the second (so it is the right-hand cell of a
    // `space-between` row), and the picker is inside it rather than a sibling of
    // the textarea below. The visual half is the AI panel's manual-test roster
    // entry, which names the mechanism jsdom cannot supply.
    listFolderPaths.mockResolvedValue([{ path: "Private/", label: "Private" }]);
    selectAiTopic("limits");
    render(<AiPanel />);
    const picker = await screen.findByTestId("ai.excluded-folders-picker");
    const row = screen.getByTestId("settings.ai-panel").querySelector(
      '[data-setting-anchor="ai.excluded-folders"]',
    );
    expect(row, "the excluded-folders anchor must be on the row").not.toBeNull();
    expect(row!.getAttribute("data-setting-row")).toBe("true");
    const line = row!.firstElementChild as HTMLElement;
    expect(line.children[0]?.textContent).toBe("settings.ai.excludedLabel");
    const slot = line.children[1] as HTMLElement;
    expect(slot, "the row is label then control slot").toBe(line.lastElementChild);
    expect(slot.contains(picker), "the picker is in the control slot").toBe(true);
    // The shared dropdown chrome, which is the other half of "it does not look
    // like our other dropdowns": `.myne-select-trigger` is what `Select` and
    // `SearchableSelect` share.
    expect(picker.className).toContain("myne-select-trigger");
    // And the textarea is NOT on that line: it is a child of the row, below it.
    const box = screen.getByTestId("ai.excluded-folders");
    expect(line.contains(box)).toBe(false);
    expect(row!.contains(box)).toBe(true);
  });

  it("shows the last pick on its trigger rather than staying on the placeholder", async () => {
    // `selected={[]}` made the trigger read "Pick a folder…" even after a pick,
    // which is the same class of defect as a control that does not look like its
    // siblings (myne-md/myne#885).
    listFolderPaths.mockResolvedValue([{ path: "Private/", label: "Private" }]);
    selectAiTopic("limits");
    render(<AiPanel />);
    const picker = await screen.findByTestId("ai.excluded-folders-picker");
    expect(picker.textContent).toBe("settings.ai.excludedPickPlaceholder");
    fireEvent.click(picker);
    fireEvent.click(
      screen
        .getAllByTestId("ai.excluded-folders-picker-option")
        .find((o) => o.getAttribute("data-value") === "Private/")!,
    );
    expect(screen.getByTestId("ai.excluded-folders-picker").textContent).toBe("Private");
  });
});

describe("AiPanel: an installed model in the catalogue", () => {
  // The catalogue is an inline table in the Models topic since myne-md/myne#885,
  // so these tests select the topic and read the table; there is no modal to
  // open and no button to press first. What they assert did not change.
  it("offers no download action, and states which file it is using", async () => {
    loadModelPath.mockImplementation((role?: string) =>
      Promise.resolve(role === "tag" ? "/models/qwen-tag.gguf" : null),
    );
    selectAiTopic("models");
    const { unmount } = render(<AiPanel />);
    await waitFor(() =>
      expect(screen.queryByTestId("ai.model-provenance-tag")).not.toBeNull(),
    );
    // The row that HAS the model: no download control, and a folder button
    // whose accessible name carries the FILE, the short half of the path, and
    // the half a user recognises (myne-md/myne#848).
    expect(screen.queryByTestId("ai.download-button-tag")).toBeNull();
    const provenance = screen.getByTestId("ai.model-provenance-tag");
    expect(provenance.getAttribute("aria-label")).toContain("qwen-tag.gguf");
    expect(provenance.hasAttribute("disabled")).toBe(false);
    unmount();

    // The row that does not, on the same artefact with nothing stored: the
    // download button, and a DISABLED folder button, because there is no
    // location to show.
    loadModelPath.mockImplementation(() => Promise.resolve(null));
    render(<AiPanel />);
    await waitFor(() => expect(screen.queryByTestId("ai.download-button-tag")).not.toBeNull());
    expect(
      screen.getByTestId("ai.model-provenance-tag").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("shows the whole location, and the one action it enables, on demand", async () => {
    // The path is what the folder button holds: printed inline it ran past the
    // panel's edge and over the label above it (myne-md/myne#848).
    loadModelPath.mockImplementation((role?: string) =>
      Promise.resolve(role === "tag" ? "/models/qwen-tag.gguf" : null),
    );
    selectAiTopic("models");
    render(<AiPanel />);
    const button = await screen.findByTestId("ai.model-provenance-tag");
    expect(screen.queryByTestId("ai.model-provenance-panel-tag")).toBeNull();
    fireEvent.click(button);
    await screen.findByTestId("ai.model-provenance-panel-tag");
    expect(
      screen.getByTestId("ai.model-provenance-panel-tag-path").textContent,
    ).toBe("/models/qwen-tag.gguf");
    // The action the location enables, and it calls the host's reveal.
    fireEvent.click(screen.getByTestId("ai.model-provenance-tag-reveal"));
    expect(revealItemInDir).toHaveBeenCalledWith("/models/qwen-tag.gguf");
  });
});

describe("AiPanel: the panel's grouping (myne-md/myne#867, topics since #885)", () => {
  /** The AI panel's own topic ids.
   *
   *  Deliberately NOT `SettingsTopicId`: that union covers every topic in the
   *  tree, so annotating the table with it would demand an entry for Appearance's
   *  and Privacy's topics too. The exhaustiveness worth keeping is "every AI
   *  topic is listed", which is what this names, and the test below holds it to
   *  the roster so the two cannot drift. */
  // The external-access topic moved to the Connections panel (myne-md/myne#1077).
  type AiTopicId = "answering" | "models" | "limits" | "advanced";

  /** Which controls a topic must contain, asserted one topic at a time on the
   *  RENDERED tree. A panel whose JSX sits in the old sequence and is composed
   *  into a new one has the same source order and a different screen, and since
   *  myne-md/myne#885 a control's topic is what decides whether it is on screen
   *  at all. */
  const MEMBERSHIP: Record<AiTopicId, string[]> = {
    answering: [
      "ai.enable-toggle",
      "ai.trust-banner",
      "ai.endpoint-section",
      "ai.provider-section",
    ],
    // Tagging folded into Models (myne-md/myne#867): the switch is a section
    // of this topic and the tag role is a row of the hand-picked table.
    models: [
      "ai.catalogue",
      "ai.models-section",
      "ai.sideload-disclosure",
      "ai.auto-tag-toggle",
      "ai.model-choose-tag",
    ],
    limits: ["ai.excluded-folders", "ai.history-budget-input"],
    // Its own topic since the rework (myne-md/myne#1052). The section itself is
    // absent wherever `externalMcp` is absent, which is why the membership here is
    // the master switch rather than a connection row.
    advanced: ["ai.meeting-prompt"],
  };

  it("lists every topic the AI panel actually declares", () => {
    expect(Object.keys(MEMBERSHIP).sort()).toEqual(
      AI_PANEL_TOPICS.map((topic) => topic.id).sort(),
    );
  });

  it("files every setting's row under the topic that asks its question", () => {
    for (const [topic, testids] of Object.entries(MEMBERSHIP)) {
      resetSettingsTopics();
      setActiveSettingsTopic("ai", topic as SettingsTopicId);
      const { unmount } = render(<AiPanel />);
      const panel = screen.getByTestId("settings.ai-panel");
      for (const testid of testids) {
        expect(
          panel.querySelector(`[data-testid="${testid}"]`),
          `${topic} must hold ${testid}`,
        ).not.toBeNull();
      }
      unmount();
    }
  });

  it("keeps the tag role's row and the switch that uses it together in Models", () => {
    // Tagging folded into Models (myne-md/myne#867, on the user's read: "put
    // tagging inside models"): the tag role is the last row of the
    // hand-picked table, and the switch is a section of the same topic.
    selectAiTopic("models");
    render(<AiPanel />);
    expect(screen.getByTestId("ai.model-select-tag")).toBeTruthy();
    expect(screen.getByTestId("ai.auto-tag-toggle")).toBeTruthy();
    for (const id of ["ai.model-select", "ai.model-select-transcription", "ai.model-select-tag"]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it("renders every AI entry's search target once its topic is selected", () => {
    // A registry `id` IS the `data-setting-anchor` a search hit scrolls to and
    // flashes, with `testid` as the fallback. Since myne-md/myne#885 the target
    // also has to be in the ACTIVE topic: an anchor inside an inactive one is not
    // in the document, so this walks each entry through the topic it names. It
    // therefore fails on a wrong `topic` field as well as on a missing anchor,
    // which is the shape the settings search's landing depends on.
    for (const entry of SETTINGS_SEARCH_INDEX) {
      if (entry.panelId !== "ai") continue;
      expect(entry.topic, `entry ${entry.id} must name its topic`).toBeDefined();
      resetSettingsTopics();
      setActiveSettingsTopic("ai", entry.topic as SettingsTopicId);
      const { unmount } = render(<AiPanel />);
      const panel = screen.getByTestId("settings.ai-panel");
      const anchored = panel.querySelector(`[data-setting-anchor="${entry.id}"]`);
      const byTestid =
        entry.testid === undefined
          ? null
          : panel.querySelector(`[data-testid="${entry.testid}"]`);
      expect(
        anchored ?? byTestid,
        `entry ${entry.id} (topic ${String(entry.topic)})`,
      ).not.toBeNull();
      unmount();
    }
  });

  it("still renders every AI entry's search target with a remote provider named", () => {
    // myne-md/myne#867 review, D7: the local runtime block renders only while no
    // service is named, so with one named the walk is what proves each entry
    // still has something to land on (the endpoint entry falls back to the
    // provider block).
    aiProvider = "openrouter";
    // A registry `id` IS the `data-setting-anchor` a search hit scrolls to and
    // flashes, with `testid` as the fallback. Since myne-md/myne#885 the target
    // also has to be in the ACTIVE topic: an anchor inside an inactive one is not
    // in the document, so this walks each entry through the topic it names. It
    // therefore fails on a wrong `topic` field as well as on a missing anchor,
    // which is the shape the settings search's landing depends on.
    for (const entry of SETTINGS_SEARCH_INDEX) {
      if (entry.panelId !== "ai") continue;
      expect(entry.topic, `entry ${entry.id} must name its topic`).toBeDefined();
      resetSettingsTopics();
      setActiveSettingsTopic("ai", entry.topic as SettingsTopicId);
      const { unmount } = render(<AiPanel />);
      const panel = screen.getByTestId("settings.ai-panel");
      const anchored = panel.querySelector(`[data-setting-anchor="${entry.id}"]`);
      const byTestid =
        entry.testid === undefined
          ? null
          : panel.querySelector(`[data-testid="${entry.testid}"]`);
      expect(
        anchored ?? byTestid,
        `entry ${entry.id} (topic ${String(entry.topic)})`,
      ).not.toBeNull();
      unmount();
    }
  });
});

describe("AiPanel: the model catalogue (myne-md/myne#867, inline since #885)", () => {
  it("renders in the Models topic with no modal and no button to open one", () => {
    selectAiTopic("models");
    render(<AiPanel />);
    // The panel's own download section is gone: fetching a model and assigning
    // one used to be two blocks answering the same question. So is the modal and
    // the icon that opened it (myne-md/myne#885): the list is in front of the
    // user rather than behind a press.
    expect(screen.queryByTestId("ai.downloads-section")).toBeNull();
    expect(screen.queryByTestId("ai.catalogue-button")).toBeNull();
    const catalogue = screen.getByTestId("ai.catalogue");
    expect(catalogue.getAttribute("data-setting-anchor")).toBe("ai.downloads");
    // Not a dialog: the surface it replaced was `role="dialog"` through
    // `ModalShell`, and this is the assertion that would pass on the old shape.
    expect(catalogue.getAttribute("role")).toBeNull();
    expect(catalogue.closest('[role="dialog"]')).toBeNull();
  });

  it("lists every artefact, installed or not, with the action its state enables", async () => {
    selectAiTopic("models");
    loadModelPath.mockImplementation((role?: string) =>
      Promise.resolve(role === "tag" ? "/models/qwen-tag.gguf" : null),
    );
    const { unmount } = render(<AiPanel />);
    // Installed: Remove and no Download. A Download button beside an installed
    // model reads as "this is not installed" on the row saying that it is.
    await waitFor(() =>
      expect(screen.queryByTestId("ai.remove-button-tag")).not.toBeNull(),
    );
    expect(screen.queryByTestId("ai.download-button-tag")).toBeNull();
    expect(screen.getByTestId("ai.download-state-tag").textContent).toBe(
      "settings.ai.downloadInstalled",
    );
    unmount();

    // Not installed, and still listed. A catalogue that shows only what you
    // already have cannot answer "what can I get", which is what it is for.
    loadModelPath.mockImplementation(() => Promise.resolve(null));
    render(<AiPanel />);
    await waitFor(() => expect(screen.getByTestId("ai.download-row-tag")).toBeTruthy());
    expect(screen.getByTestId("ai.download-button-tag")).toBeTruthy();
    expect(screen.getByTestId("ai.download-state-tag").textContent).toBe(
      "settings.ai.downloadNotInstalled",
    );
  });

  it("keeps a started download in flight across a topic change and back", () => {
    // The state machine is not in this component: `ai-download-store.ts` is
    // module scope, and the panel mounts only the active topic's body, so
    // switching topics UNMOUNTS the table. Driving the real store here (this
    // file mocks `invoke`, not the store) is what makes this the assertion about
    // a transfer surviving navigation rather than about a variable.
    selectAiTopic("models");
    const { unmount } = render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.download-button-tag"));
    expect(startModelDownload).toHaveBeenCalledWith("tag");
    unmount();

    selectAiTopic("limits");
    const elsewhere = render(<AiPanel />);
    expect(screen.queryByTestId("ai.download-row-tag")).toBeNull();
    elsewhere.unmount();

    selectAiTopic("models");
    render(<AiPanel />);
    // Back on Models, the row is there again with its own action; the transfer
    // it started was never cancelled by the unmount.
    expect(screen.getByTestId("ai.download-row-tag")).toBeTruthy();
    expect(cancelModelDownloadFor).not.toHaveBeenCalled();
  });

  it("keeps the catalogue's testid contract distinct from the assignment rows", () => {
    // Two surfaces render a model row, and a shared testid would let one stand
    // in for the other in every scenario that reaches either.
    selectAiTopic("models");
    render(<AiPanel />);
    for (const artifact of ["tag"]) {
      expect(screen.getByTestId(`ai.download-row-${artifact}`)).toBeTruthy();
      expect(screen.getByTestId(`ai.download-state-${artifact}`)).toBeTruthy();
    }
    // The panel's assignment rows keep their own ids.
    expect(screen.getByTestId("ai.model-select")).toBeTruthy();
  });
});

describe("AiPanel: the assignment rows (myne-md/myne#867)", () => {
  it("gives every role a row, tag included", () => {
    // The tag role is a real `ModelRole` with a real side-loadable file, and it
    // was the ONE role with no row: reachable only by downloading it, which is
    // what made the block read as if a model were missing from it. Since
    // myne-md/myne#867 every role, tag included, is a row of one table in the
    // Models topic.
    //
    // Listed rather than built from a role suffix: the generation row carries
    // the original bare testids (`ai.model-select`, `ai.model-choose`) because
    // scenarios already reach them, while its recommend link is named like the
    // other roles. Deriving the ids would hide that, which is the kind of
    // tidying that silently breaks a scenario.
    const idsByTopic: Record<string, string[]> = {
      models: [
        "ai.model-select",
        "ai.model-choose",
        "ai.model-recommend-generation",
        "ai.model-select-transcription",
        "ai.model-choose-transcription",
        "ai.model-recommend-transcription",
        "ai.model-select-tag",
        "ai.model-choose-tag",
        "ai.model-recommend-tag",
      ],
    };
    for (const [topic, ids] of Object.entries(idsByTopic)) {
      resetSettingsTopics();
      setActiveSettingsTopic("ai", topic as SettingsTopicId);
      const { unmount } = render(<AiPanel />);
      for (const id of ids) {
        expect(screen.getByTestId(id), `${topic} must hold ${id}`).toBeTruthy();
      }
      unmount();
    }
  });

  it("assigns the tag file the same way as any other role", async () => {
    openFileDialog.mockResolvedValueOnce("/models/qwen-tag.gguf");
    selectAiTopic("models");
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.model-choose-tag"));
    await waitFor(() =>
      expect(saveModelPath).toHaveBeenCalledWith("tag", "/models/qwen-tag.gguf"),
    );
  });

  it("still refuses a file inside the vault tree, and says so", async () => {
    // The host answers `InsideVaultTree` and returns no path. The row keeps what
    // the user picked so the control is not left blank, and the surface says
    // what happened rather than looking like a save: a model copied into the
    // vault would be synced, and the refusal is the whole point of SYNC-1.
    saveModelPath.mockRejectedValueOnce(new Error("InsideVaultTree"));
    openFileDialog.mockResolvedValueOnce("/vault/notes/model.gguf");
    const onShowToast = vi.fn();
    selectAiTopic("models");
    render(<AiPanel onShowToast={onShowToast} />);
    fireEvent.click(screen.getByTestId("ai.model-choose-tag"));
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith("settings.ai.modelSaveFailed"),
    );
  });

  it("keeps the tag file's name off the full path, like every other role", async () => {
    // A path is a paragraph on a real machine; the name is the half a user
    // recognises, and the folder button beside it holds the rest (myne-md/myne#848).
    loadModelPath.mockImplementation((role?: string) =>
      Promise.resolve(
        role === "tag" ? "/Users/me/Library/Application Support/md.myne.desktop/models/qwen-tag.gguf" : null,
      ),
    );
    selectAiTopic("models");
    render(<AiPanel />);
    const shown = await screen.findByTestId("ai.model-select-tag");
    expect(shown.textContent).toBe("qwen-tag.gguf");
  });
});

// The provider choice comes first and decides what follows (myne-md/myne#867,
// on the user's read: "after the switch I pick the provider, local model or
// remote, and then I see the settings for what I picked").
describe("AiPanel: the provider choice decides the rows under it", () => {
  it("shows the local runtime and no remote rows while nothing is named", async () => {
    aiProvider = null;
    render(<AiPanel />);
    await waitFor(() => expect(screen.getByTestId("ai.endpoint-section")).toBeTruthy());
    expect(screen.queryByTestId("ai.provider-remote-section")).toBeNull();
    expect(screen.queryByTestId("ai.provider-key-input")).toBeNull();
  });

  it("shows the key and model rows and hides the local runtime once a service is named", async () => {
    aiProvider = "openrouter";
    render(<AiPanel />);
    await waitFor(() => expect(screen.getByTestId("ai.provider-remote-section")).toBeTruthy());
    expect(screen.getByTestId("ai.provider-key-input")).toBeTruthy();
    expect(screen.queryByTestId("ai.endpoint-section")).toBeNull();
  });

  it("states the stored model in a dropdown that stays locked until the list is loaded", async () => {
    aiProvider = "openrouter";
    aiProviderModel = "deepseek/deepseek-v4.1-flash";
    render(<AiPanel />);
    const current = await screen.findByTestId("ai.provider-model-current");
    expect(current.textContent).toContain("deepseek/deepseek-v4.1-flash");
    expect((current as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("ai.provider-model-select")).toBeNull();
    aiProviderModel = null;
  });
});

// myne-md/myne#867, the last layout pass on the user's read.
describe("AiPanel: the Models table and the Advanced sections", () => {
  it("draws the hand-picked models as a table in the catalogue's columns", () => {
    selectAiTopic("models");
    render(<AiPanel />);
    const row = screen.getByTestId("ai.model-choose-tag-row");
    const table = row.parentElement as HTMLElement;
    expect(table.style.gridTemplateColumns).toBe("minmax(0, 2fr) minmax(0, 1fr) minmax(max-content, 1fr)");
    for (const child of Array.from(table.children) as HTMLElement[]) {
      expect(child.style.gridTemplateColumns).toBe("subgrid");
    }
    // Three roles, three rows, plus the header.
    expect(table.children).toHaveLength(4);
  });

  it("marks each state with a glyph: a cross while no file is chosen", () => {
    selectAiTopic("models");
    render(<AiPanel />);
    const state = screen.getByTestId("ai.model-select-tag");
    expect(state.textContent).toBe("settings.ai.modelNone");
    const wrapper = state.parentElement as HTMLElement;
    expect(wrapper.getAttribute("data-state")).toBe("missing");
    expect(wrapper.querySelector("svg")).not.toBeNull();
  });

  it("splits Advanced into Preferences and Memory, the voice preferences under Preferences", async () => {
    selectAiTopic("advanced");
    render(<AiPanel />);
    const sections = await waitFor(() => {
      const found = Array.from(document.querySelectorAll("section"));
      if (found.length < 2) throw new Error("sections not mounted yet");
      return found;
    });
    const preferences = sections.find(
      (el) => el.getAttribute("aria-label") === "settings.ai.sections.preferences",
    ) as HTMLElement;
    const memory = sections.find(
      (el) => el.getAttribute("aria-label") === "settings.ai.sections.memory",
    ) as HTMLElement;
    expect(preferences.querySelector('[data-testid="ai.meeting-prompt-input"]')).not.toBeNull();
    expect(
      preferences.querySelector('[data-testid="settings.memory.personality-input"]'),
    ).not.toBeNull();
    expect(memory.querySelector('[data-testid="settings.memory-section"]')).not.toBeNull();
    expect(memory.querySelector('[data-testid="settings.memory.personality-input"]')).toBeNull();
  });

  it("keeps the meeting prompt in Preferences while AI is off, with no Memory", () => {
    aiEnabled = false;
    selectAiTopic("advanced");
    render(<AiPanel />);
    const labels = Array.from(document.querySelectorAll("section")).map((el) =>
      el.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["settings.ai.sections.preferences"]);
    expect(screen.getByTestId("ai.meeting-prompt-input")).toBeTruthy();
  });
});

// myne-md/myne#867, on the user's read: "the save and reset buttons look nothing
// alike". Both are now the same control: a square bordered icon on the row.
describe("AiPanel: Preferences rows carry one kind of action", () => {
  it("draws the meeting reset and the voice save as bordered icon buttons", async () => {
    selectAiTopic("advanced");
    render(<AiPanel />);
    const reset = screen.getByTestId("ai.meeting-prompt-reset");
    const save = await screen.findByTestId("settings.memory.personality-save");
    for (const button of [reset, save]) {
      expect(button.getAttribute("data-bordered")).toBe("true");
      expect(button.textContent).toBe("");
      expect(button.getAttribute("aria-label")).toBeTruthy();
    }
  });
});

// myne-md/myne#867, on the user's read: "move tagging to the top of Models".
describe("AiPanel: Tagging leads the Models topic", () => {
  it("renders the Tagging section before the two model tables", () => {
    selectAiTopic("models");
    render(<AiPanel />);
    const labels = Array.from(document.querySelectorAll("section")).map((el) =>
      el.getAttribute("aria-label"),
    );
    expect(labels[0]).toBe("settings.ai.groupTagging");
    expect(labels).toContain("settings.ai.sections.catalogue");
    expect(labels).toContain("settings.ai.sections.outsourced");
  });
});

// myne-md/myne#867 review, D6: four "Choose file…" buttons need their row.
describe("AiPanel: each hand-picked model row names its role to assistive tech", () => {
  it("describes every Choose button by its own role and file requirement", () => {
    selectAiTopic("models");
    render(<AiPanel />);
    for (const id of ["ai.model-choose", "ai.model-choose-transcription", "ai.model-choose-tag"]) {
      const button = screen.getByTestId(id);
      const ids = (button.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
      expect(ids).toHaveLength(2);
      const text = ids.map((x) => document.getElementById(x)?.textContent ?? "").join(" ");
      const row = screen.getByTestId(`${id}-row`);
      // Both described elements live in THIS row, so the description is the row's.
      for (const x of ids) expect(row.contains(document.getElementById(x))).toBe(true);
      expect(text.trim()).not.toBe("");
    }
  });
});
