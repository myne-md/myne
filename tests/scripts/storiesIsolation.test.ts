// Drives `scripts/check-stories-isolation.mjs` (myne-md/myne#832).
//
// Injects the exact defect the guard claims to catch: a `stories` reference in a
// guarded app config. Verified by breaking it, per the repo's rule.

import { describe, expect, it } from "vitest";
import {
  findLeaks,
  missingScripts,
  GUARDED_CONFIGS,
  REQUIRED_SCRIPTS,
} from "../../scripts/check-stories-isolation.mjs";

type GuardedConfig = { path: string; reason: string; content: string | null };

function configs(): GuardedConfig[] {
  return GUARDED_CONFIGS.map((c) => ({ ...c, content: "export default {}" }));
}

describe("check-stories-isolation.findLeaks", () => {
  it("passes when no config references stories", () => {
    expect(findLeaks({ configs: configs() })).toEqual([]);
  });

  it("names a config that references stories", () => {
    const c = configs();
    c[0] = { ...c[0], content: 'input: "stories/index.html"' };
    const problems = findLeaks({ configs: c });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(c[0].path);
  });

  it("fails rather than skips a config that could not be read", () => {
    const c = configs();
    c[1] = { ...c[1], content: null };
    const problems = findLeaks({ configs: c });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("could not be read");
  });
});

describe("check-stories-isolation.missingScripts", () => {
  it("reports a package.json that lost the catalogue's scripts", () => {
    expect(missingScripts({ scripts: {} })).toEqual(REQUIRED_SCRIPTS);
    expect(missingScripts({ scripts: { stories: "x" } })).toEqual(["stories:build"]);
    expect(
      missingScripts({ scripts: { stories: "x", "stories:build": "y" } }),
    ).toEqual([]);
  });
});
