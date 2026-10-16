// The pinned-digest guard, driven against companion trees it BUILDS.
//
// WHAT THIS FILE DOES NOT COVER, and why: the half that talks to ghcr.io. A unit test that
// needs a public registry is a test that goes red when GitHub is slow, and the resolution
// half is exercised end-to-end by running the guard (and, at release time, by
// `myne-ops/scripts/check-image-multiarch.sh`). What IS covered here is every branch that
// does not need the network — the absent-companion skip, its `--require-companion` form, the
// non-vacuity floor, and the unreachable-registry path (driven through the guard's
// `MYNE_REGISTRY_BASE` seam, which is what that seam exists for).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = join(REPO_ROOT, "scripts", "check-referenced-digests.mjs");

/** A dead port: reaching the registry through it fails to connect, which is the offline path. */
const DEAD_REGISTRY = "http://127.0.0.1:9";

function makeTrees(opts: { guide?: string; compose?: string; chart?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), "refdigests-"));
  const website = join(base, "myne-website");
  mkdirSync(join(website, "src", "content", "user-guide", "sync-and-devices"), { recursive: true });
  writeFileSync(
    join(website, "src", "content", "user-guide", "sync-and-devices", "run-your-own-sync-server.md"),
    opts.guide ?? "# no pins here\n",
  );
  const ops = join(base, "myne-ops");
  mkdirSync(join(ops, "bundle"), { recursive: true });
  writeFileSync(join(ops, "bundle", "docker-compose.yml"), opts.compose ?? "name: myne-server\n");
  writeFileSync(join(ops, "bundle", "bundle.env.example"), "# kind: server\n");
  const server = join(base, "myne-server");
  mkdirSync(join(server, "deploy", "helm", "myne-server"), { recursive: true });
  mkdirSync(join(server, "deploy", "helm", "myne-web"), { recursive: true });
  writeFileSync(
    join(server, "deploy", "helm", "myne-server", "values.yaml"),
    opts.chart ?? "image:\n  repository: ghcr.io/myne-md/myne-server\n",
  );
  writeFileSync(join(server, "deploy", "helm", "myne-web", "values.yaml"), "image:\n  repository: ghcr.io/myne-md/myne-web\n");
  return { website, ops, server };
}

function runGuard(
  trees: { website: string; ops: string; server: string },
  args: string[] = [],
  registry?: string,
) {
  try {
    const out = execFileSync("node", [GUARD, ...args], {
      env: {
        ...process.env,
        MYNE_WEBSITE_DIR: trees.website,
        MYNE_OPS_DIR: trees.ops,
        MYNE_SERVER_DIR: trees.server,
        ...(registry ? { MYNE_REGISTRY_BASE: registry } : {}),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

describe("check-referenced-digests", () => {
  // --- the absent branch: this is what runs in CI and in a fresh clone ---------------

  it("reports NOTHING VERIFIED when no companion carries a pin", () => {
    const base = mkdtempSync(join(tmpdir(), "refdigests-absent-"));
    const r = runGuard({ website: join(base, "no-web"), ops: join(base, "no-ops"), server: join(base, "no-server") });
    expect(r.code).toBe(0);
    expect(r.out).toContain("NOTHING VERIFIED");
    expect(r.out).toContain("not a verdict");
  });

  it("fails on that branch when the caller passes --require-companion", () => {
    const base = mkdtempSync(join(tmpdir(), "refdigests-absent2-"));
    const r = runGuard(
      { website: join(base, "no-web"), ops: join(base, "no-ops"), server: join(base, "no-server") },
      ["--require-companion"],
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("--require-companion was passed");
  });

  // --- the vacuous pass --------------------------------------------------------------

  it("fails by name when the companions are present but no pin is found", () => {
    // A tree that HAS the files and none of the pins is the case that must not read as ok:
    // it is either a scan that lost its inputs or a pin someone deleted.
    const r = runGuard(makeTrees());
    expect(r.code).toBe(1);
    expect(r.out).toContain("below the floor");
  });

  // --- the offline path --------------------------------------------------------------

  it("says it could not reach the registry instead of claiming a pass", () => {
    const trees = makeTrees({
      guide: [
        "```yaml",
        "image: ghcr.io/myne-md/myne-server@" + "sha256:" + "a".repeat(64),
        "```",
        "```yaml",
        "image: ghcr.io/myne-md/myne-web:0.8.0",
        "```",
        "```yaml",
        "image: ghcr.io/myne-md/myne-web:v0.8.1",
        "```",
      ].join("\n"),
    });
    const r = runGuard(trees, [], DEAD_REGISTRY);
    expect(r.code).toBe(0);
    expect(r.out).toContain("COULD NOT REACH the registry");
    expect(r.out).toContain("This is not a pass");
    expect(r.out).toContain("NOTHING VERIFIED");
  });
});
