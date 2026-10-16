import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FORBIDDEN,
  INTERNAL_MARKER,
  SENTINEL,
  findProblems,
} from "../../scripts/check-stories-public-bundle.mjs";

// Injection suite for `scripts/check-stories-public-bundle.mjs`.
//
// Per `AGENTS.md`: verifying a guard means BREAKING it. Every direction is driven
// with synthetic file lists rather than against a real build, so this suite needs
// no `pnpm stories:build:public` and cannot leave a stale `dist-public` behind.
// The build-dependent half is the CI step (`stories-build`), which runs both
// builds and then the real guard.
//
// The case most suites skip is the one that looks like success: a guard whose
// positive assertion is missing reports "no forbidden marker found" on an EMPTY
// input, which is indistinguishable from a clean build. That is why the sentinel
// cases below assert the two failure MODES separately — default-build and
// not-a-build — rather than only that problems were returned.

const ROOT: string = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT: string = join(ROOT, "scripts/check-stories-public-bundle.mjs");

/** A minimal clean public build: one file, carrying the sentinel. */
const clean = () => [
  {
    path: "assets/index-abc.js",
    text: `jsx("div",{"data-testid":"${SENTINEL}"});`,
  },
];

describe("check-stories-public-bundle: the rule", () => {
  it("passes a clean public build", () => {
    expect(findProblems({ files: clean() })).toEqual([]);
  });

  it("catches a private-repository link and names it", () => {
    const files = [
      ...clean(),
      {
        path: "assets/leak.js",
        text: 'href:"https://github.com/myne-md/myne-themes"',
      },
    ];
    const problems = findProblems({ files });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      kind: "forbidden",
      needle: "github.com/myne-md",
      path: "assets/leak.js",
    });
    // The message is the finding, not "grep matched".
    expect(problems[0].meaning).toMatch(/404/);
  });

  it("catches each affordance testid separately, so the finding names one", () => {
    for (const needle of ["stories.source", "stories.file-issue"]) {
      const files = [
        ...clean(),
        { path: "assets/index-abc.js", text: `"data-testid":"${needle}"` },
      ];
      const problems = findProblems({ files });
      expect(problems.map((p) => p.needle)).toEqual([needle]);
    }
  });

  it("catches every forbidden marker the list claims", () => {
    // Non-vacuity: a marker added to FORBIDDEN but never matched by the scan is a
    // needle nobody tests. Driven off the exported list so it cannot drift.
    for (const { needle } of FORBIDDEN) {
      const problems = findProblems({
        files: [{ path: "assets/x.js", text: `...${needle}... ${SENTINEL}` }],
      });
      expect(problems.some((p) => p.needle === needle)).toBe(true);
    }
  });

  it("fails when the sentinel is missing and says it read the DEFAULT build", () => {
    const problems = findProblems({
      files: [{ path: "assets/x.js", text: `"data-testid":"${INTERNAL_MARKER}"` }],
    });
    expect(problems).toEqual([{ kind: "no-sentinel", internal: true }]);
  });

  it("fails when the sentinel is missing and nothing identifies the variant", () => {
    // The load-bearing case: an empty or half-written build reports "no GitHub
    // URL" and would pass an absence-only guard.
    const problems = findProblems({ files: [{ path: "assets/x.js", text: "nothing" }] });
    expect(problems).toEqual([{ kind: "no-sentinel", internal: false }]);
  });

  it("still reports the sentinel failure when a link is present too", () => {
    const problems = findProblems({
      files: [
        { path: "assets/x.js", text: "https://github.com/myne-md/myne" },
      ],
    });
    expect(problems.map((p) => p.kind).sort()).toEqual(["forbidden", "no-sentinel"]);
  });
});

describe("check-stories-public-bundle: the CLI", () => {
  it("fails by name when the directory does not exist, rather than skipping", () => {
    let code = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        env: { ...process.env, MYNE_STORIES_PUBLIC_DIST: "stories/dist-does-not-exist" },
      });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      code = failure.status ?? 0;
      stderr = failure.stderr ?? "";
    }
    expect(code).toBe(1);
    expect(stderr).toMatch(/does not exist/);
    expect(stderr).toMatch(/stories:build:public/);
  });
});
