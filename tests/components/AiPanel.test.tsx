// @vitest-environment jsdom
//
// Component tests for `src/components/settings/AiPanel.tsx` (ai-ux-surface
// MYND-408 + the model-acquisition "Option A" surface). Focus: the two per-role
// side-load pickers (generation + embedding) and the "Recommended models"
// browser links that open in the user's OWN browser via the opener plugin —
// Myne never downloads a model (SYNC-1/2 no-egress). `openUrl` / the file dialog
// / `ai-model-store` / `usePrefs` / i18n are mocked at their module boundaries.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Hoisted so the mock factories (which run BEFORE module-body consts init) can
// reference these — the canonical vitest pattern for direct factory references.
const {
  openUrl,
  openFileDialog,
  loadModelPath,
  saveModelPath,
  setAutoTagEnabled,
  tagModelAvailable,
} = vi.hoisted(() => ({
  openUrl: vi.fn(() => Promise.resolve()),
  openFileDialog: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  loadModelPath: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  saveModelPath: vi.fn((_role: string, p: string) => Promise.resolve(p)),
  setAutoTagEnabled: vi.fn((_enabled: boolean) => Promise.resolve()),
  tagModelAvailable: vi.fn((): Promise<boolean> => Promise.resolve(true)),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openFileDialog }));
vi.mock("../../src/lib/ai-model-store", () => ({ loadModelPath, saveModelPath }));
vi.mock("../../src/lib/ai-tags", () => ({ tagModelAvailable }));

let aiEnabled = true;
let autoTagEnabled = false;
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: {
      ai_enabled: aiEnabled,
      auto_tag_enabled: autoTagEnabled,
      ai_excluded_folders: [],
    },
    setAiEnabled: vi.fn(),
    setAiExcludedFolders: vi.fn(),
    setAutoTagEnabled,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { AiPanel } from "../../src/components/settings/AiPanel";
import { AI_TRUST_HEADLINE } from "../../src/lib/load-bearing-copy";

beforeEach(() => {
  aiEnabled = true;
  autoTagEnabled = false;
  openUrl.mockClear();
  openFileDialog.mockClear();
  loadModelPath.mockClear();
  saveModelPath.mockClear();
  setAutoTagEnabled.mockClear();
  setAutoTagEnabled.mockResolvedValue(undefined);
  tagModelAvailable.mockClear();
  tagModelAvailable.mockResolvedValue(true);
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

  it("still renders the load-bearing trust headline verbatim", () => {
    render(<AiPanel />);
    expect(screen.getByTestId("ai.trust-headline").textContent).toBe(AI_TRUST_HEADLINE);
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
