// @vitest-environment jsdom
//
// Component tests for `src/components/settings/AiPanel.tsx` (ai-ux-surface
// MYND-408 + the model-acquisition "Option A" surface). Focus: the two per-role
// side-load pickers (generation + embedding) and the "Recommended models"
// browser links that open in the user's OWN browser via the opener plugin —
// Myne never downloads a model (SYNC-1/2 no-egress). `openUrl` / the file dialog
// / `ai-model-store` / `usePrefs` / i18n are mocked at their module boundaries.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Hoisted so the mock factories (which run BEFORE module-body consts init) can
// reference these — the canonical vitest pattern for direct factory references.
const { openUrl, openFileDialog, loadModelPath, saveModelPath } = vi.hoisted(() => ({
  openUrl: vi.fn(() => Promise.resolve()),
  openFileDialog: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  loadModelPath: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  saveModelPath: vi.fn((_role: string, p: string) => Promise.resolve(p)),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openFileDialog }));
vi.mock("../../src/lib/ai-model-store", () => ({ loadModelPath, saveModelPath }));

let aiEnabled = true;
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: { ai_enabled: aiEnabled, ai_excluded_folders: [] },
    setAiEnabled: vi.fn(),
    setAiExcludedFolders: vi.fn(),
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { AiPanel } from "../../src/components/settings/AiPanel";
import { AI_TRUST_HEADLINE } from "../../src/lib/load-bearing-copy";

beforeEach(() => {
  aiEnabled = true;
  openUrl.mockClear();
  openFileDialog.mockClear();
  loadModelPath.mockClear();
  saveModelPath.mockClear();
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
