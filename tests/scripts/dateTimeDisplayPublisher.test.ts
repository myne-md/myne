// The guard for the myne-md/myne#609 defect class, tested the only way a guard
// can be: by injecting the defect it claims to catch and watching it name that
// defect.
//
// It is NOT "the guard that would have caught myne#609", which is what this line
// said first and is measurably false: at the merge base `mobile/src` held no
// read marker at all, because its consumption was transitive through the shared
// task panel, so the rule passed over the defective tree vacuously. The guard's
// own header now says so, and `ARMED_TREES` is what stops that state returning
// silently. The claim mattered because a reader who believes it stops looking.
//
// A guard that has never failed is a guard nobody has tested, and this repo has
// three recorded cases of a check passing while the thing it checked was wrong.
// So every rule below is driven through `analyse`'s injection seams rather than
// asserted from a green run of the real tree, which proves only that the tree is
// currently fine.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyse,
  ARMED_TREES,
  NOT_A_CLIENT,
  PUBLISH_MARKER,
  READ_MARKERS,
} from "../../scripts/check-datetime-display-publisher.mjs";

describe("the rule itself", () => {
  it("names a client that reads the store and never publishes", () => {
    const { failures } = analyse({
      trees: {
        src: { reads: true, publishes: true },
        "mobile/src": { reads: true, publishes: false },
      },
      missingTrees: [],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.root).toBe("mobile/src");
    // The message has to say what goes wrong, not just that a rule was broken.
    // This is the shape the real defect took: the value arrives and is ignored.
    expect(failures[0]?.why).toContain("SYNCED date_format arrives and is disregarded");
  });

  it("passes a client that does both", () => {
    const { failures } = analyse({
      trees: { src: { reads: true, publishes: true } },
      missingTrees: [],
    });
    expect(failures).toHaveLength(0);
  });

  it("passes a client that reads nothing, rather than demanding a publisher", () => {
    // `web/src` is this case today: it compiles the shared `src/` tree, so it
    // inherits that tree's adapter and holds no consumer of its own. Requiring a
    // publisher there would be requiring a second one.
    const { failures } = analyse({
      trees: { "web/src": { reads: false, publishes: false } },
      missingTrees: [],
    });
    expect(failures).toHaveLength(0);
  });

  it("names EVERY offending client, not just the first", () => {
    const { failures } = analyse({
      trees: {
        src: { reads: true, publishes: false },
        "mobile/src": { reads: true, publishes: false },
      },
      missingTrees: [],
    });
    expect(failures.map((f) => f.root).sort()).toEqual(["mobile/src", "src"]);
  });
});

describe("the scope cannot narrow in silence", () => {
  it("fails when a shared root on the roster is absent from the checkout", () => {
    // The failure this rule exists for: a guard that walks one client fewer and
    // still prints ok. It is unreachable from a real run, because every shared
    // root is on disk, which is exactly why it is injected here.
    const { failures } = analyse({
      trees: { src: { reads: true, publishes: true } },
      missingTrees: ["mobile/src"],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.root).toBe("mobile/src");
    expect(failures[0]?.why).toContain("silently covered one client fewer");
  });

  it("fails when an exemption outlives the tree it exempts", () => {
    const { failures } = analyse({
      trees: { src: { reads: true, publishes: true } },
      missingTrees: [],
      exemptions: { "packages/gone": "was a shared tree once and is not one now." },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.root).toBe("packages/gone");
    expect(failures[0]?.why).toContain("no longer a shared root");
  });

  it("does NOT call the real exemptions stale on a partial scan", () => {
    // The first version asked this of the SCANNED set, so every injected run
    // reported all four real exemptions as stale and drowned the rule under
    // test. Staleness is a question about the roster.
    const { failures } = analyse({
      trees: { src: { reads: true, publishes: true } },
      missingTrees: [],
    });
    expect(failures).toEqual([]);
    expect(Object.keys(NOT_A_CLIENT).length).toBeGreaterThan(0);
  });
});

describe("the markers are the ones a consumer actually writes", () => {
  it("covers the hook, the getter, the subscription and the formatters", () => {
    // Named individually rather than by count: a count passes when one is
    // swapped for another, and losing `formatStoredValue` would make the task
    // rows invisible to the rule while every other spelling still matched.
    for (const marker of [
      "useDateTimeDisplay",
      "dateTimeDisplay(",
      "subscribeDateTimeDisplay",
      "formatStoredValue",
      "formatCivilDate",
      "formatWallClockTime",
      "formatInstant",
      "todayIn",
    ]) {
      expect(READ_MARKERS, marker).toContain(marker);
    }
  });

  it("has exactly one publish spelling, because there is one setter", () => {
    expect(PUBLISH_MARKER).toBe("setDateTimeDisplay(");
  });

  it("gives every exemption a stated reason", () => {
    // An exemption without a reason is an exemption nobody can argue with later.
    for (const [root, reason] of Object.entries(NOT_A_CLIENT)) {
      expect(reason.length, root).toBeGreaterThan(40);
    }
  });
});

describe("the arming, which is what stops a vacuous pass", () => {
  it("fails when an armed tree stops reading the store at all", () => {
    // The exact state the defect shipped in, and the one the conditional rule
    // cannot see: `reads: false` satisfies "reads implies publishes" for free.
    const { failures } = analyse({
      trees: {
        src: { reads: true, publishes: true },
        "mobile/src": { reads: false, publishes: true },
      },
      missingTrees: [],
    });
    expect(failures.map((f) => f.root)).toEqual(["mobile/src"]);
    expect(failures[0]?.why).toContain("vacuously");
  });

  it("says nothing about a tree that is not armed", () => {
    const { failures } = analyse({
      trees: { src: { reads: false, publishes: false } },
      missingTrees: [],
    });
    expect(failures).toEqual([]);
  });

  it("fails when an armed entry outlives its tree", () => {
    const { failures } = analyse({
      trees: { src: { reads: true, publishes: true } },
      missingTrees: [],
      armedTrees: { "packages/gone": "was a client once." },
    });
    expect(failures.map((f) => f.root)).toEqual(["packages/gone"]);
    expect(failures[0]?.why).toContain("no longer a shared root");
  });

  it("gives every armed tree a stated reason", () => {
    for (const [root, reason] of Object.entries(ARMED_TREES)) {
      expect(reason.length, root).toBeGreaterThan(40);
    }
  });
});

describe("the scan half, over real files", () => {
  // Everything above drives the RULE with an injected scan result, which leaves
  // the half of the guard that opens files and matches markers asserted by
  // nothing: a deleted marker, or a walk that stopped recursing, would have
  // passed every case. These build a small tree on disk and point the guard at
  // it, so the scan is what is under test.
  const built: string[] = [];

  function tree(files: Record<string, string>): string {
    const base = mkdtempSync(join(tmpdir(), "myne-dtdp-"));
    built.push(base);
    for (const [rel, body] of Object.entries(files)) {
      const full = join(base, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body, "utf8");
    }
    return base;
  }

  afterEach(() => {
    while (built.length > 0) rmSync(built.pop()!, { recursive: true, force: true });
  });

  const scan = (root: string) =>
    analyse({ root, presentTrees: ["client/src"], missingTrees: [], exemptions: {} });

  it("names a tree whose files read the store and never publish", () => {
    // The real defect, in the shape it actually shipped: a consumer deep in the
    // tree, no publisher anywhere.
    const root = tree({
      "client/src/panel/TaskRow.tsx": "export const x = formatStoredValue(v, d);\n",
      "client/src/lib/other.ts": "export const y = 1;\n",
    });
    const { failures } = scan(root);
    expect(failures.map((f) => f.root)).toEqual(["client/src"]);
  });

  it("passes once a publisher exists anywhere under the same tree", () => {
    const root = tree({
      "client/src/panel/TaskRow.tsx": "export const x = formatStoredValue(v, d);\n",
      "client/src/lib/sync.ts": "setDateTimeDisplay(displayFromPrefs(p, l));\n",
    });
    expect(scan(root).failures).toEqual([]);
  });

  it("recurses, rather than reading only the top level", () => {
    // A walk that stopped at depth one would report this tree clean, because
    // the only consumer is four directories down. `check-web-screens.mjs`
    // records the same failure from the other side: a shallow listing that made
    // a roster miss 27 of its own files.
    const root = tree({
      "client/src/a/b/c/d/Deep.tsx": "const t = todayIn(display);\n",
    });
    expect(scan(root).failures.map((f) => f.root)).toEqual(["client/src"]);
  });

  it("reads .tsx as well as .ts", () => {
    // Both halves of the client tree are one or the other, and a consumer is
    // far more likely to be a component. An extension filter that dropped
    // `.tsx` would leave the rule scanning the wrong half of every client.
    const tsOnly = tree({ "client/src/only.ts": "const t = todayIn(display);\n" });
    const tsxOnly = tree({ "client/src/Only.tsx": "const t = todayIn(display);\n" });
    expect(scan(tsOnly).failures).toHaveLength(1);
    expect(scan(tsxOnly).failures).toHaveLength(1);
  });

  it("matches every read marker it claims to, one file each", () => {
    // The list is asserted as STRINGS elsewhere. This asserts that each one
    // actually makes the scan fire, which is the part a renamed export breaks.
    for (const marker of READ_MARKERS) {
      const root = tree({ "client/src/One.ts": `const v = ${marker}x);\n` });
      expect(scan(root).failures.map((f) => f.root), marker).toEqual(["client/src"]);
    }
  });

  it("treats a tree with no consumer as clean rather than demanding a publisher", () => {
    const root = tree({ "client/src/plain.ts": "export const n = 2;\n" });
    expect(scan(root).failures).toEqual([]);
  });
});

describe("the real tree", () => {
  it("passes today", () => {
    // Deliberately LAST and deliberately thin. It proves the guard runs against
    // the checkout without throwing; it proves nothing about the rule, which is
    // what every test above is for.
    const { failures, scanned } = analyse();
    expect(failures).toEqual([]);
    expect(scanned.length).toBeGreaterThan(0);
  });
});
