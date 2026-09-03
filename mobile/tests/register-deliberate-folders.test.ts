// myne-md/myne#613 task 7, mobile half: the retry-and-classify wrapper the
// folder-create surface uses.
//
// The desktop twin is `tests/lib/prefsBindings.test.ts` in the main tree. Both
// exist because the two `prefs.ts` files are twins, not shared code, and a
// wrapper that drifts between them makes the two clients say different things
// about the same failure.
//
// What is under test is the CLASSIFICATION and the ATTEMPT COUNT together.
// Either alone passes for a wrong version: a wrapper that retried a budget
// refusal still returns `budget-full`, and one that gave up on the first hiccup
// still returns a valid outcome.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { registerDeliberateFolders } from "../src/lib/prefs";

beforeEach(() => {
  invoke.mockReset();
});

/** How many times the deliberate-folders command reached `invoke`. */
function attempts(): number {
  return invoke.mock.calls.filter(
    ([cmd]) => cmd === "plugin:prefs|set_deliberate_folders",
  ).length;
}

describe("registerDeliberateFolders: retry the hiccup, report the budget", () => {
  it("a clean write is `ok`, on one attempt", async () => {
    invoke.mockResolvedValue(0);
    await expect(registerDeliberateFolders({ add: ["Ideas/"] })).resolves.toBe("ok");
    expect(attempts()).toBe(1);
  });

  it("a transient failure retries and reports `ok`, saying nothing to the user", async () => {
    invoke.mockRejectedValueOnce(new Error("disk hiccup")).mockResolvedValue(0);
    await expect(registerDeliberateFolders({ add: ["Ideas/"] })).resolves.toBe("ok");
    // The attempt count is the assertion. A version that gave up on the first
    // failure would report a notice for a hiccup the user can do nothing about,
    // which is how a surface teaches people to dismiss it.
    expect(attempts()).toBe(2);
  });

  it("a persistent failure is `failed`, after exactly two attempts", async () => {
    invoke.mockRejectedValue(new Error("disk is gone"));
    await expect(registerDeliberateFolders({ add: ["Ideas/"] })).resolves.toBe("failed");
    expect(attempts()).toBe(2);
  });

  it("a budget refusal is `budget-full` and is NOT retried", async () => {
    invoke.mockResolvedValue(1);
    await expect(registerDeliberateFolders({ add: ["Ideas/"] })).resolves.toBe(
      "budget-full",
    );
    // One attempt, not two. The reserve is full: a second attempt refuses
    // identically, so retrying would only delay a notice the user must act on.
    expect(attempts()).toBe(1);
  });

  it("the retry sends the SAME mutation, not a re-derived one", async () => {
    invoke.mockRejectedValueOnce(new Error("hiccup")).mockResolvedValue(0);
    await registerDeliberateFolders({ add: ["Ideas/"], remove: ["Old/"] });
    const sent = invoke.mock.calls
      .filter(([cmd]) => cmd === "plugin:prefs|set_deliberate_folders")
      .map(([, args]) => (args as { mutation: unknown }).mutation);
    expect(sent).toHaveLength(2);
    // A re-derivation between attempts is this issue's own defect one layer up:
    // the second attempt must not consult anything that could have moved.
    expect(sent[1]).toEqual(sent[0]);
  });
});
