// @vitest-environment jsdom
//
// The diagnostic block's READING half. myne-md/myne#556, the `app.diagnostics`
// bullet:
//
//   > "a real number or an explicit unknown, never blank/zero/NaN" is a
//   > rendered-string assertion, and `collect-diagnostics.ts` funnels a missing
//   > estimate to `unknown` through one catch.
//
// # Why this file exists next to `tests/lib/diagnostics.test.ts`
//
// That one covers `buildDiagnostics`, which is pure and well pinned: the field
// allowlist, the `unknown` rendering, the absence of anything a pasted block
// must never carry. What it cannot cover is where the values come FROM, and the
// split is deliberate — `collect-diagnostics.ts`'s own header says the pure
// module exists "so its allowlist can be tested without a DOM, a build define or
// a storage estimate".
//
// So the reading module had no test at all, and it is the half that meets the
// browser: `navigator.storage.estimate()` is permission- and engine-dependent,
// may be absent, may throw, and returns a number this module then rounds.
//
// # What the block is FOR, which decides what counts as a bug here
//
// It is copy-to-clipboard text a user pastes to a maintainer after something
// failed. Nothing is transmitted. So every field has exactly one job: to be
// read by a person who is trying to work out what went wrong, and a value that
// reads as a fact while being an artefact of formatting is worse than no value
// — they will act on it.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/platform/build-info", () => ({
  servedBuildInfo: async () => ({ commit: "abc1234", bundleHash: "sha256:beef" }),
}));

import { collectDiagnostics } from "../../src/lib/collect-diagnostics";

/** Install a `navigator.storage.estimate` that answers with `impl`. */
function withEstimate(impl: (() => Promise<StorageEstimate>) | null): void {
  Object.defineProperty(navigator, "storage", {
    value: impl === null ? undefined : { estimate: impl },
    configurable: true,
  });
}

/** Whether the block carries a `key: value` line at all. */
function hasField(text: string, key: string): boolean {
  return text.split("\n").some((l) => l.startsWith(`${key}: `));
}

/** The value of one `key: value` line. */
function field(text: string, key: string): string {
  const line = text.split("\n").find((l) => l.startsWith(`${key}: `));
  if (line === undefined) throw new Error(`no ${key} line in:\n${text}`);
  return line.slice(key.length + 2);
}

afterEach(() => {
  Object.defineProperty(navigator, "storage", { value: undefined, configurable: true });
});

describe("the diagnostic block's storage reading (myne-md/myne#556)", () => {
  // The rule is "never a placeholder, never a lie": a reading the client cannot
  // take is ABSENT from the block (issue #970, item 15). It used to print
  // `unknown`, which a maintainer could not tell from a measurement and which a
  // user read as the app failing to read its own state.
  it("drops both storage lines when the estimate throws", async () => {
    withEstimate(() => Promise.reject(new Error("denied")));
    const text = await collectDiagnostics("io-error");
    expect(
      hasField(text, "storageUsedMb"),
      "a rejected estimate still produced a storage line. The catch in " +
        "collect-diagnostics.ts exists so a permission-dependent API cannot turn " +
        "into a failed copy, and the line is dropped rather than filled.",
    ).toBe(false);
    expect(hasField(text, "storageQuotaMb")).toBe(false);
    // And the rest of the block is still there: a dropped reading is not a
    // dropped report.
    expect(hasField(text, "version")).toBe(true);
    expect(text).not.toContain("unknown");
  });

  it("drops both storage lines when the browser has no storage manager at all", async () => {
    withEstimate(null);
    const text = await collectDiagnostics("io-error");
    expect(
      hasField(text, "storageUsedMb"),
      "an absent navigator.storage produced a storage line. This is the " +
        "older-engine path, distinct from the throwing one above, and it reaches " +
        "the same place through `?.` rather than through the catch.",
    ).toBe(false);
  });

  it("reports a real measurement in MB", async () => {
    withEstimate(() =>
      Promise.resolve({ usage: 12 * 1024 * 1024, quota: 10 * 1024 * 1024 * 1024 }),
    );
    const text = await collectDiagnostics("io-error");
    expect(field(text, "storageUsedMb")).toBe("12");
    expect(field(text, "storageQuotaMb")).toBe("10240");
  });

  it("never reports a non-empty store as `0`", async () => {
    // 300 KB — a small but real vault. `Math.round(bytes / 1MiB)` makes that a
    // bare `0`, which a maintainer reads as "nothing is stored" and uses to rule
    // storage out. That is the difference between a rounded figure and a wrong
    // one: the block's whole job is to be acted on.
    withEstimate(() => Promise.resolve({ usage: 300 * 1024, quota: 1024 * 1024 * 1024 }));
    const text = await collectDiagnostics("io-error");
    expect(
      field(text, "storageUsedMb"),
      `a store holding 300 KB reported as "${field(text, "storageUsedMb")}" MB. ` +
        `Zero is not a rounding of "some": it is the one value that says the ` +
        `opposite of what is true, and it is what a maintainer would use to rule ` +
        `storage out of an investigation.`,
    ).not.toBe("0");
  });

  it("never reports NaN", async () => {
    // An engine that answers with a non-finite number is not hypothetical —
    // `estimate()` is under-specified enough that a partial or in-progress
    // reading can arrive. `typeof NaN === "number"` passes the module's guard,
    // and `String(NaN)` is what lands in the pasted text.
    withEstimate(() => Promise.resolve({ usage: Number.NaN, quota: Number.NaN }));
    const text = await collectDiagnostics("io-error");
    expect(
      hasField(text, "storageUsedMb"),
      `the block carries a storage line for a non-finite reading. A field that ` +
        `says NaN is a field that says the app is broken in a way it is not, and ` +
        `the honest answer for an unusable reading is no line at all.`,
    ).toBe(false);
    expect(hasField(text, "storageQuotaMb")).toBe(false);
  });
});
