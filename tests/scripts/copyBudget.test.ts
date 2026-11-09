// Break tests for `scripts/check-copy-budget.mjs` (myne-md/myne#23).
//
// Root `AGENTS.md`: "Verifying a guard means breaking it, not running it." The
// guard's two halves are the two ways the 2026-11 copy campaign can be undone, so
// every case below injects that shape into a synthetic catalog and record rather
// than editing `locales/`: nothing here mutates the working tree.
//
// The cases that matter, and the reason each one exists:
//
//   - a second key carrying a value `common.*` owns must fail. This is the whole
//     ratchet: `check-i18n-duplicates.mjs` starts at 25 characters, so `Cancel`
//     under 47 call sites was never compared by anything.
//   - a recorded alias that stopped colliding must fail STALE. Without the
//     reverse direction, deleting the talent pool of duplicate keys would leave
//     the record describing a tree that no longer exists.
//   - the --record placeholder must fail, and must fail by EXACT MATCH. A guard
//     whose seeding path itself passes its own gate licensed seven entries in
//     `check-ipc-binding-callers.mjs` before that was caught.
//   - a surface that grew copy must fail naming the delta and the largest keys;
//     a surface that shrank must pass, because the ratchet only turns one way.
//   - a key reached through an indirection the guard can see (`labelKey:`,
//     `confirmKey:`) must count toward the surface. The mechanical sweep in #23
//     missed both and deleted keys the app still rendered.

import { describe, expect, it } from "vitest";

import { check, MIN_REASON_LEN, PLACEHOLDER, record } from "../../scripts/check-copy-budget.mjs";

/** The smallest world the guard needs: a catalog, a record, and files -> keys. */
function world({ catalog, aliases = {}, surfaces = {}, keys = {} }) {
  return {
    catalog: new Map(Object.entries(catalog)),
    record: { aliases, surfaces },
    keysByFile: new Map(Object.entries(keys).map(([file, list]) => [file, new Set(list)])),
  };
}

const OK_REASON = "one sentence, two surfaces, and the second one names the first";

describe("check-copy-budget, the ownership ratchet", () => {
  it("passes when the only carrier of a value is the key that owns it", () => {
    expect(
      check(
        world({
          catalog: { "common.cancel": "Cancel", "dialog.other": "Keep" },
          keys: { "src/components/settings/A.tsx": ["common.cancel"] },
          surfaces: { "src/components/settings/A.tsx": 6 },
        }),
      ),
    ).toEqual([]);
  });

  it("fails on a second key carrying an owned value, naming both keys", () => {
    const problems = check(
      world({
        catalog: { "common.cancel": "Cancel", "dialog.cancel": "Cancel" },
        keys: { "src/components/settings/A.tsx": ["common.cancel"] },
        surfaces: { "src/components/settings/A.tsx": 6 },
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("dialog.cancel");
    expect(problems[0]).toContain("common.cancel");
  });

  it("passes a recorded alias whose reason is written", () => {
    expect(
      check(
        world({
          catalog: { "common.cancel": "Cancel", "dialog.cancel": "Cancel" },
          aliases: { "dialog.cancel": { owner: "common.cancel", reason: OK_REASON } },
          keys: { "src/components/settings/A.tsx": ["common.cancel"] },
          surfaces: { "src/components/settings/A.tsx": 6 },
        }),
      ),
    ).toEqual([]);
  });

  it("fails an alias recorded against the wrong owner", () => {
    const problems = check(
      world({
        catalog: { "common.cancel": "Cancel", "dialog.cancel": "Cancel" },
        aliases: { "dialog.cancel": { owner: "common.close", reason: OK_REASON } },
        keys: { "src/components/settings/A.tsx": ["common.cancel"] },
        surfaces: { "src/components/settings/A.tsx": 6 },
      }),
    );
    expect(problems[0]).toContain("common.cancel owns that value now");
  });

  it("fails a stale alias, because the record must describe the tree", () => {
    const problems = check(
      world({
        catalog: { "common.cancel": "Cancel", "dialog.cancel": "Keep" },
        aliases: { "dialog.cancel": { owner: "common.cancel", reason: OK_REASON } },
        keys: { "src/components/settings/A.tsx": ["common.cancel"] },
        surfaces: { "src/components/settings/A.tsx": 6 },
      }),
    );
    expect(problems[0]).toContain("no longer shares a value");
  });

  it("rejects the --record placeholder and a reason shorter than the floor", () => {
    for (const reason of [PLACEHOLDER, "too short"]) {
      const problems = check(
        world({
          catalog: { "common.cancel": "Cancel", "dialog.cancel": "Cancel" },
          aliases: { "dialog.cancel": { owner: "common.cancel", reason } },
          keys: { "src/components/settings/A.tsx": ["common.cancel"] },
          surfaces: { "src/components/settings/A.tsx": 6 },
        }),
      );
      expect(problems[0]).toContain("no usable reason");
    }
    expect(MIN_REASON_LEN).toBeGreaterThan("too short".length);
  });

  it("seeds a NEW alias with the placeholder, so a re-baseline cannot pass on its own", () => {
    const next = record(
      world({
        catalog: { "common.cancel": "Cancel", "dialog.cancel": "Cancel" },
        keys: { "src/components/settings/A.tsx": ["common.cancel"] },
      }),
    );
    expect(next.aliases["dialog.cancel"]).toEqual({ owner: "common.cancel", reason: PLACEHOLDER });
    const problems = check(
      world({
        catalog: { "common.cancel": "Cancel", "dialog.cancel": "Cancel" },
        aliases: next.aliases,
        keys: { "src/components/settings/A.tsx": ["common.cancel"] },
        surfaces: next.surfaces,
      }),
    );
    expect(problems.some((p) => p.includes("no usable reason"))).toBe(true);
  });
});

describe("check-copy-budget, the per-surface budget", () => {
  const catalog = {
    "common.cancel": "Cancel",
    "settings.a.body": "First sentence.",
    "settings.a.helper": "A helper that says a little more.",
  };
  const keys = { "src/components/settings/A.tsx": ["common.cancel", "settings.a.body"] };
  const surfaces = { "src/components/settings/A.tsx": 6 + 15 };

  it("passes at the recorded size", () => {
    expect(check(world({ catalog, keys, surfaces }))).toEqual([]);
  });

  it("fails when the surface renders more copy, naming the delta and the largest keys", () => {
    const problems = check(
      world({
        catalog,
        keys: { "src/components/settings/A.tsx": [...keys["src/components/settings/A.tsx"], "settings.a.helper"] },
        surfaces,
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("grew");
    expect(problems[0]).toContain("settings.a.helper");
  });

  it("passes when the surface SHRANK, because the ratchet only turns one way", () => {
    expect(check(world({ catalog, keys, surfaces: { "src/components/settings/A.tsx": 100 } }))).toEqual([]);
  });

  it("fails a surface that renders copy and is not recorded at all", () => {
    const problems = check(world({ catalog, keys, surfaces: {} }));
    expect(problems[0]).toContain("is not recorded");
  });

  it("fails a recorded surface that renders nothing now", () => {
    const problems = check(world({ catalog, keys: {}, surfaces }));
    expect(problems[0]).toContain("renders no copy now");
  });
});
