// The dev server's watch scope, pinned.
//
// `vite.config.ts` hands chokidar an ALLOWLIST predicate instead of the denylist
// it used to carry. The number that motivated it: with the denylist, a counting
// probe in `watch.ignored` was asked about **84,379 distinct paths** at startup,
// 70,217 of them under `target/`. With the predicate it is asked about 2,462.
//
// This spec exists because the predicate's failure mode is SILENT and worse than
// the slow startup it replaces: refuse the repository root and chokidar stops at
// depth zero, so `src/` never enters the watch set and HMR simply stops, with
// nothing logged. The first version shipped exactly that (it compared
// `startsWith(WATCH_ROOT + "/")`, and the root arrives WITHOUT a trailing slash),
// and only a counting probe in that position said so. These cases are that bug,
// written down.
//
// It reads the predicate out of the real config rather than a copy: a copy would
// be a second thing to keep true, which is the failure the allowlist itself
// exists to remove.

import { describe, expect, it } from "vitest";

import { isWatchedByDevServer, WATCHED_ROOTS } from "../../vite.config";

const ROOT = process.cwd().replace(/\\/g, "/");

describe("isWatchedByDevServer", () => {
  it("admits the repository root itself, which is what lets chokidar descend", () => {
    // The regression. `process.cwd()` carries no trailing slash, so a predicate
    // written as a bare `startsWith(root + "/")` refuses the root and the walk
    // never starts.
    expect(isWatchedByDevServer(ROOT)).toBe(true);
    expect(isWatchedByDevServer(`${ROOT}/`)).toBe(true);
  });

  it("admits every listed root, at its own level and at any depth", () => {
    for (const root of WATCHED_ROOTS) {
      expect(isWatchedByDevServer(`${ROOT}/${root}`), root).toBe(true);
      expect(isWatchedByDevServer(`${ROOT}/${root}/a/b/c.ts`), root).toBe(true);
    }
  });

  it("admits a repository-root file, so a config edit still reloads the server", () => {
    for (const f of ["index.html", "pdf-export.html", "vite.config.ts", "package.json"]) {
      expect(isWatchedByDevServer(`${ROOT}/${f}`), f).toBe(true);
    }
  });

  it("refuses a directory the walk used to spend 70k paths on", () => {
    // The point of the change. One level deep is admitted (a bare `target` has no
    // separator, and the root-file arm covers it), and every path BELOW it is not
    // -- which is what stops chokidar descending.
    for (const ignored of ["target", "docs", "e2e", "mobile", "myne-server", "agent-tooling"]) {
      expect(isWatchedByDevServer(`${ROOT}/${ignored}/anything.ts`), ignored).toBe(false);
      expect(isWatchedByDevServer(`${ROOT}/${ignored}/a/b/c.js`), ignored).toBe(false);
    }
  });

  it("refuses a path outside the project entirely", () => {
    expect(isWatchedByDevServer("/tmp/elsewhere.txt")).toBe(false);
    expect(isWatchedByDevServer("/Users/someone/other/src/index.ts")).toBe(false);
  });
});
