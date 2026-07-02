import { describe, expect, it, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { saveModelPath, loadModelPath } from "../../src/lib/ai-model-store";

beforeEach(() => invokeMock.mockReset());

// ai-ux-surface (MYND-408) task 4 — model-path store IPC wrappers.
describe("saveModelPath", () => {
  it("calls the set_model_path command with role + path and returns the accepted path", async () => {
    invokeMock.mockResolvedValue("/Users/x/models/qwen.gguf");
    const out = await saveModelPath("generation", "/Users/x/models/qwen.gguf");
    expect(out).toBe("/Users/x/models/qwen.gguf");
    expect(invokeMock).toHaveBeenCalledWith("plugin:local-inference|set_model_path", {
      role: "generation",
      path: "/Users/x/models/qwen.gguf",
    });
  });
});

describe("loadModelPath", () => {
  it("calls get_model_path with the role and returns the stored path", async () => {
    invokeMock.mockResolvedValue("/Users/x/models/qwen.gguf");
    const out = await loadModelPath("generation");
    expect(out).toBe("/Users/x/models/qwen.gguf");
    expect(invokeMock).toHaveBeenCalledWith("plugin:local-inference|get_model_path", {
      role: "generation",
    });
  });

  it("returns null when no path is set", async () => {
    invokeMock.mockResolvedValue(null);
    expect(await loadModelPath("generation")).toBeNull();
  });
});
