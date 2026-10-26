// The seed bindings' COMMAND NAMES (myne-md/myne#915).
//
// A wrong plugin namespace is invisible to TypeScript: `plugin:local_inference|
// seed_memory_status` compiles, the function's return type is whatever the
// caller declared, and the only report is a runtime ACL refusal. It shipped
// once in this branch, was caught by the E2E scenario, and this is the cheap
// pin so the next edit cannot repeat it silently.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../../src/platform/core", () => ({
  invoke,
  Channel: class {
    onmessage: ((value: unknown) => void) | null = null;
  },
}));

import {
  memorySeedApply,
  seedMemoryCancel,
  seedMemoryGenerate,
  seedMemoryPayload,
  seedMemoryStatus,
} from "../../src/lib/seed-memory";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({});
});

describe("the seed bindings reach the right plugin", () => {
  it("uses the hyphenated local-inference namespace for every seed command", async () => {
    await seedMemoryStatus();
    await seedMemoryPayload();
    await seedMemoryGenerate("job-1", false);
    await seedMemoryCancel("job-1");
    const commands = invoke.mock.calls.map((call) => call[0] as string);
    expect(commands).toEqual([
      "plugin:local-inference|seed_memory_status",
      "plugin:local-inference|seed_memory_payload",
      "plugin:local-inference|seed_memory_generate",
      "plugin:local-inference|seed_memory_cancel",
    ]);
  });

  it("names the memory plugin for the batch write", async () => {
    await memorySeedApply(["a"], false);
    expect(invoke).toHaveBeenCalledWith("plugin:memory|memory_seed_apply", {
      candidates: ["a"],
      replaceExisting: false,
    });
  });
});
