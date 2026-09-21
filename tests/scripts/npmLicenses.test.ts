// The npm license gate's own spec (myne-md/myne#515).
//
// The gate had none, and that is most of how #515 happened: it failed on every
// CI run for months while nothing exercised the paths it takes when it cannot
// evaluate. Root `AGENTS.md`: "Verifying a guard means breaking it, not running
// it. Inject the exact defect the guard now claims to catch, watch it name that
// defect, then restore."
//
// Every case below is an injection. The two that matter most are the ones with
// no observable symptom in production:
//
//   - an EMPTY payload used to print the tick and exit 0, so the gate reported
//     success while checking nothing. That is worse than #515, which was loud.
//   - an `error` payload at exit 0 would have thrown "is not iterable", a stack
//     trace wearing the costume of a license finding.
//
// It also pins the SPDX evaluator in the direction its own comment says the
// anchoring exists for: `GPL-3.0-or-later` must not be split on its lowercase
// `or`. That is the case a future "simplification" to a case-insensitive regex
// breaks, and it would break it silently, by making a copyleft license pass.
import { describe, expect, it } from "vitest";

import {
  GateCannotRun,
  assertNotVacuous,
  classify,
  declaredDirectDeps,
  isAllowed,
} from "../../scripts/check-npm-licenses.mjs";

/** One package under one license key, in the shape pnpm emits. */
const pkg = (name: string, versions = ["1.0.0"]) => ({ name, versions });

describe("the allowlist", () => {
  it("accepts a plain allowed id and rejects a plain disallowed one", () => {
    // The non-vacuity floor: a spec where nothing can fail proves nothing.
    expect(isAllowed("MIT")).toBe(true);
    expect(isAllowed("GPL-3.0")).toBe(false);
  });

  it("passes an OR expression when ANY operand is allowed", () => {
    expect(isAllowed("GPL-3.0 OR MIT")).toBe(true);
  });

  it("fails an AND expression when ANY operand is disallowed", () => {
    expect(isAllowed("MIT AND GPL-3.0")).toBe(false);
    expect(isAllowed("Apache-2.0 AND MIT")).toBe(true);
  });

  it("strips the outer parens pnpm sometimes emits", () => {
    expect(isAllowed("(MPL-2.0 OR Apache-2.0)")).toBe(true);
    expect(isAllowed("(MIT AND Zlib)")).toBe(true);
  });

  it("does not treat a LOWERCASE `or` as the SPDX operator", () => {
    // The trap the uppercase anchoring exists for, and the case that actually
    // distinguishes the two implementations.
    //
    // `GPL-3.0-or-later` alone does NOT distinguish them: split case-
    // insensitively it becomes `GPL-3.0-` and `-later`, neither of which is on
    // the allowlist, so both versions answer false. Asserting only that id is a
    // break test that catches nothing, which is the first thing this one was.
    //
    // A malformed lowercase EXPRESSION is where the difference lands, and it
    // lands in the unsafe direction: `MIT or GPL-3.0` is not a valid SPDX
    // expression (the spec mandates uppercase operators), so the strict
    // evaluator rejects the whole string and reports a violation. A case-
    // insensitive split accepts it on the `MIT` operand and waves the GPL half
    // through.
    expect(isAllowed("MIT or GPL-3.0")).toBe(false);
    expect(isAllowed("MIT and GPL-3.0")).toBe(false);
    // And the real id stays rejected, since it is genuinely not on the list.
    expect(isAllowed("GPL-3.0-or-later")).toBe(false);
  });
});

describe("classification", () => {
  it("names the package and its versions when a license is not allowed", () => {
    const { violations } = classify({ "GPL-3.0": [pkg("copyleft-thing", ["2.0.0", "2.1.0"])] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("copyleft-thing@2.0.0,2.1.0");
    expect(violations[0]).toContain("GPL-3.0");
  });

  it("reports nothing when every license is allowed", () => {
    const { violations, seen } = classify({ MIT: [pkg("a"), pkg("b")], ISC: [pkg("c")] });
    expect(violations).toEqual([]);
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
  });

  it("suppresses the EXCEPT package and NOTHING else under the same key", () => {
    // `khroma` is load-bearing today: it is the single `Unknown` entry in the
    // real payload, so removing it from EXCEPT turns the gate red. What must
    // not happen is the exception widening to cover the key it sits under.
    const { violations } = classify({ Unknown: [pkg("khroma"), pkg("some-other-pkg")] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("some-other-pkg");
    expect(violations[0]).not.toContain("khroma");
  });
});

describe("the gate refuses to evaluate rather than passing", () => {
  it("rejects an EMPTY payload instead of printing the tick", () => {
    // The silent version of #515. Before this, `{}` meant zero iterations,
    // zero violations, and a green exit 0.
    const { violations, seen } = classify({});
    expect(violations).toEqual([]);
    expect(seen.size).toBe(0);
    expect(() => assertNotVacuous(seen, new Set(["react"]))).toThrow(GateCannotRun);
  });

  it("names which declared dependencies are missing from the payload", () => {
    const seen = new Set(["react"]);
    expect(() => assertNotVacuous(seen, new Set(["react", "vitest", "typescript"]))).toThrow(
      /missing 2 of 3 .*typescript/s,
    );
  });

  it("passes the floor when every declared dependency is present", () => {
    expect(() =>
      assertNotVacuous(new Set(["react", "vitest"]), new Set(["react"])),
    ).not.toThrow();
  });

  it("rejects a pnpm error payload rather than iterating it as a license", () => {
    // Would have thrown `TypeError: pkgs is not iterable`, i.e. a crash the
    // reader has to decode, at the exit code reserved for a real finding.
    expect(() =>
      classify({ error: { code: "ERR_PNPM_MISSING_PACKAGE_INDEX_FILE", message: "…" } }),
    ).toThrow(/ERR_PNPM_MISSING_PACKAGE_INDEX_FILE/);
  });

  it("rejects a payload that is not an object of arrays", () => {
    expect(() => classify(null)).toThrow(GateCannotRun);
    expect(() => classify([])).toThrow(/an array/);
    expect(() => classify({ MIT: "not-an-array" })).toThrow(/not an array/);
  });
});

describe("the computed denominator", () => {
  it("counts direct deps across every workspace package.json", () => {
    const files: Record<string, unknown> = {
      "/root/package.json": { dependencies: { react: "19.0.0" }, devDependencies: { vitest: "4.0.0" } },
      "/root/mobile/package.json": { dependencies: { "@tauri-apps/api": "2.0.0" } },
    };
    const names = declaredDirectDeps(
      (p: string) => files[p] ?? null,
      ["/root/package.json", "/root/mobile/package.json", "/root/gone/package.json"],
    );
    expect([...names].sort()).toEqual(["@tauri-apps/api", "react", "vitest"]);
  });

  it("excludes the specifiers that never appear in a licenses payload", () => {
    // Our own packages and local paths are not published dependencies, and a
    // catalog: specifier resolves under its real name. Counting them would make
    // the floor fail on a correct tree, which is how a floor gets deleted.
    const names = declaredDirectDeps(
      () => ({
        dependencies: {
          "@myne/editor": "workspace:*",
          linked: "link:../x",
          onDisk: "file:../y",
          viaCatalog: "catalog:default",
          real: "1.0.0",
        },
      }),
      ["/root/package.json"],
    );
    expect([...names]).toEqual(["real"]);
  });
});
