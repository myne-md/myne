// @vitest-environment jsdom
//
// Component tests for `src/components/settings/AiPanel.tsx` (ai-ux-surface
// MYND-408 + the model-acquisition "Option A" surface). Focus: the two per-role
// side-load pickers (generation + embedding) and the "Recommended models"
// browser links that open in the user's OWN browser via the opener plugin.
// Since myne-md/myne#805 the panel also fetches a model on explicit user action
// from Myne's own origin (digest-verified), so Myne no longer never downloads a
// model; the side-load path remains for user-sourced files. `openUrl` / the file dialog
// / `ai-model-store` / `usePrefs` / i18n are mocked at their module boundaries.

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
}));
vi.mock("../../src/notes/listFolderPaths", () => ({ listFolderPaths }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl, revealItemInDir }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openFileDialog }));
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
      embedding: { available: false, cause: "no_model" },
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
import {
  AI_TRUST_INVARIANT,
  aiTrustHeadline,
} from "../../src/lib/load-bearing-copy";

beforeEach(() => {
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
});
afterEach(() => cleanup());

describe("AiPanel — models section (Option A: side-load + recommended browser links)", () => {
  it("renders BOTH role pickers (generation + embedding) and the models section", () => {
    render(<AiPanel />);
    expect(screen.getByTestId("ai.models-section")).toBeTruthy();
    // Generation picker (the original testids, preserved).
    expect(screen.getByTestId("ai.model-select")).toBeTruthy();
    expect(screen.getByTestId("ai.model-choose")).toBeTruthy();
    // Embedding picker (the NEW twin — previously missing, blocking search/Q&A).
    expect(screen.getByTestId("ai.model-select-embedding")).toBeTruthy();
    expect(screen.getByTestId("ai.model-choose-embedding")).toBeTruthy();
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

  it("separates its categories with a rule, not a bold label", () => {
    // The group headings were the panel's title style one step DOWN, which made
    // a heading smaller than the row labels it grouped and left nothing marking
    // where one category ended and the next began, so scrolling this panel read
    // as one flat list (myne-md/myne#848). The rule is the claim.
    render(<AiPanel />);
    const groups = screen.getAllByRole("heading", { level: 4 });
    expect(groups.length).toBe(5);
    for (const group of groups) {
      expect(group.style.borderTop, "a category with no rule above it").toContain(
        "var(--line-1)",
      );
      expect(group.style.fontSize).toContain("var(--text-base)");
    }
  });

  it("gives the meeting prompt the panel's own field shape", () => {
    // An unstyled `<textarea>` falls back to the WebView's white default, which
    // is what made this the one control in the panel that did not come from the
    // tokens (myne-md/myne#848).
    render(<AiPanel />);
    const box = screen.getByTestId("ai.meeting-prompt-input");
    expect(box.style.background).toContain("var(--paper-2)");
    expect(box.style.color).toContain("var(--fg-1)");
  });

  it("opens the recommended GENERATION model in the browser (not a Myne fetch)", () => {
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.model-recommend-generation"));
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl.mock.calls[0][0]).toContain("huggingface.co");
    expect(openUrl.mock.calls[0][0]).toContain("Qwen2.5-1.5B-Instruct-GGUF");
  });

  it("opens the recommended EMBEDDING model in the browser", () => {
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.model-recommend-embedding"));
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl.mock.calls[0][0]).toContain("all-MiniLM-L6-v2");
  });

  it("side-loads a picked file per role and never triggers a network download", async () => {
    openFileDialog.mockResolvedValueOnce("/Users/me/models/qwen.gguf");
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
    render(<AiPanel />);
    expect((screen.getByTestId("ai.model-choose") as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByTestId("ai.model-choose-embedding") as HTMLButtonElement).disabled,
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
    render(<AiPanel />);
    const toggle = screen.getByTestId("ai.auto-tag-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(setAutoTagEnabled).toHaveBeenCalledWith(true);
  });

  it("reflects the persisted value when it is already on", () => {
    autoTagEnabled = true;
    render(<AiPanel />);
    expect(screen.getByTestId("ai.auto-tag-toggle").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("ai.auto-tag-toggle"));
    expect(setAutoTagEnabled).toHaveBeenCalledWith(false);
  });

  it("is non-interactive while the AI beta is off (co-gate, not a second switch)", () => {
    aiEnabled = false;
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
    render(<AiPanel />);
    await screen.findByTestId("ai.auto-tag-unavailable");
    expect(tagModelAvailable).toHaveBeenCalledTimes(1);
  });

  it("leaves the switch offerable when a tag model does ship", async () => {
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
    await waitFor(() =>
      expect(screen.getByTestId("ai.provider-model-state").textContent).toBe(
        "settings.ai.providerModelUnfetched",
      ),
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
    // below — a helper that waited for it would make that test unwritable.
    await waitFor(() =>
      expect(screen.getByTestId("ai.provider-model-state").textContent).not.toBe(
        "settings.ai.providerModelUnfetched",
      ),
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
    render(<AiPanel onShowToast={() => {}} />);
    expect(input()).toBeTruthy();
  });

  it("stores a number the user typed", async () => {
    render(<AiPanel onShowToast={() => {}} />);
    fireEvent.change(input(), { target: { value: "500" } });
    fireEvent.blur(input());
    await waitFor(() => expect(setChatHistoryBudget).toHaveBeenCalledWith(500));
  });

  it("clears the override when the field is genuinely empty", async () => {
    chatHistoryBudget = 500;
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
    render(<AiPanel onShowToast={() => {}} />);
    fireEvent.change(input(), { target: { value: "-5" } });
    fireEvent.blur(input());
    await waitFor(() => expect(setChatHistoryBudget).not.toHaveBeenCalled());
  });

  it("is disabled when AI is off, like every other control in this panel", () => {
    aiEnabled = false;
    render(<AiPanel onShowToast={() => {}} />);
    expect((input() as HTMLInputElement).disabled).toBe(true);
    aiEnabled = true;
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

// myne-md/myne#848. The panel is grouped by INTENT, the excluded-folders box
// gained a picker, and an installed model stopped offering a download.
describe("AiPanel: grouped by intent", () => {
  it("renders the five intent headings, in order", () => {
    render(<AiPanel />);
    const headings = screen
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    // The taxonomy the phase settled on. Asserted as a SEQUENCE because the
    // order is the design: a user reads down the panel, and "Privacy and
    // limits" after the model pickers is what makes it read as the controls
    // beside the switch rather than four more things to configure.
    expect(headings).toEqual([
      "settings.ai.groupAutoTag",
      "settings.ai.groupVoice",
      "settings.ai.groupWriting",
      "settings.ai.groupPrivacy",
      "settings.ai.groupAdvanced",
    ]);
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
});

describe("AiPanel: an installed model", () => {
  it("offers no download action, and states which file it is using", async () => {
    loadModelPath.mockImplementation((role?: string) =>
      Promise.resolve(role === "embedding" ? "/models/e5-small.onnx" : null),
    );
    render(<AiPanel />);
    await waitFor(() =>
      expect(screen.queryByTestId("ai.model-provenance-embedding-e5-small")).not.toBeNull(),
    );
    // The row that HAS the model: no download control, and a folder button
    // whose accessible name carries the FILE, the short half of the path, and
    // the half a user recognises (myne-md/myne#848).
    expect(screen.queryByTestId("ai.download-button-embedding-e5-small")).toBeNull();
    const provenance = screen.getByTestId("ai.model-provenance-embedding-e5-small");
    expect(provenance.getAttribute("aria-label")).toContain("e5-small.onnx");
    expect(provenance.hasAttribute("disabled")).toBe(false);
    // The row that does not: the button, and a DISABLED folder button, because
    // there is no location to show.
    expect(screen.getByTestId("ai.download-button-tag")).toBeTruthy();
    expect(
      screen.getByTestId("ai.model-provenance-tag").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("shows the whole location, and the one action it enables, on demand", async () => {
    // The path is what the folder button holds: printed inline it ran past the
    // panel's edge and over the label above it (myne-md/myne#848).
    loadModelPath.mockImplementation((role?: string) =>
      Promise.resolve(role === "embedding" ? "/models/e5-small.onnx" : null),
    );
    render(<AiPanel />);
    const button = await screen.findByTestId("ai.model-provenance-embedding-e5-small");
    expect(screen.queryByTestId("ai.model-provenance-panel-embedding-e5-small")).toBeNull();
    fireEvent.click(button);
    await screen.findByTestId("ai.model-provenance-panel-embedding-e5-small");
    expect(
      screen.getByTestId("ai.model-provenance-panel-embedding-e5-small-path").textContent,
    ).toBe("/models/e5-small.onnx");
    // The action the location enables, and it calls the host's reveal.
    fireEvent.click(
      screen.getByTestId("ai.model-provenance-embedding-e5-small-reveal"),
    );
    expect(revealItemInDir).toHaveBeenCalledWith("/models/e5-small.onnx");
  });
});
