// The self-host bundle drift guard, driven end-to-end against companion trees it BUILDS.
//
// It does not import the rules. The guard reads three files in two other repositories, so
// the only way to test the drift classes is to give it a pair of trees and read what it
// says. Injecting the defect and watching the guard name that defect is the verification;
// observing the real tree stay green proves nothing.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// NOT import.meta.dirname: it is not on ImportMeta under this repo's tsconfig, and tests/ is
// excluded from tsconfig.json, so check-test-typecheck.mjs is the one thing that typechecks
// this file.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = join(REPO_ROOT, "scripts", "check-selfhost-bundle-drift.mjs");

const DIGEST_A = "sha256:" + "a".repeat(64);
const DIGEST_B = "sha256:" + "b".repeat(64);

/** The guide's page, with one fenced compose block the guard must find. */
function guideMarkdown(digest = DIGEST_A, extraEnv = ""): string {
  return `---
title: "Run your own sync server"
---

Save this as \`docker-compose.yml\`:

\`\`\`yaml
name: myne-server

services:
  server:
    image: ghcr.io/myne-md/myne-server@${digest}
    restart: unless-stopped
    environment:
      MYNE_SERVER_ADDR: ":8080"
${extraEnv}    volumes:
      - myne-data:/data

volumes:
  myne-data:
\`\`\`

Then start it.
`;
}

/** The bundle's runnable compose. */
function bundleCompose(digest = DIGEST_A, defaultAddr = ":8080"): string {
  return `name: myne-server

services:
  server:
    image: \${MYNE_SERVER_IMAGE:-ghcr.io/myne-md/myne-server@${digest}}
    environment:
      MYNE_SERVER_ADDR: "\${MYNE_SERVER_ADDR:-${defaultAddr}}"
    expose:
      - "8080"

volumes:
  myne-data:
`;
}

/** The annotated env example. */
function envExample(addr = ":8080"): string {
  return `# --- knobs ---
# kind: server
MYNE_SERVER_ADDR=${addr}
`;
}

function makeTrees(guide: string, compose: string, env: string) {
  const base = mkdtempSync(join(tmpdir(), "bundle-drift-"));
  const website = join(base, "myne-website");
  mkdirSync(join(website, "src", "content", "user-guide", "sync-and-devices"), { recursive: true });
  writeFileSync(
    join(website, "src", "content", "user-guide", "sync-and-devices", "run-your-own-sync-server.md"),
    guide,
  );
  const ops = join(base, "operations");
  mkdirSync(join(ops, "bundle"), { recursive: true });
  writeFileSync(join(ops, "bundle", "docker-compose.yml"), compose);
  writeFileSync(join(ops, "bundle", "bundle.env.example"), env);
  return { website, ops };
}

function runGuard(website: string, ops: string, args: string[] = []) {
  try {
    const out = execFileSync("node", [GUARD, ...args], {
      env: { ...process.env, MYNE_WEBSITE_DIR: website, MYNE_OPS_DIR: ops },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

describe("check-selfhost-bundle-drift", () => {
  it("passes when the guide, the bundle and the env example agree", () => {
    const t = makeTrees(guideMarkdown(), bundleCompose(), envExample());
    const r = runGuard(t.website, t.ops);
    expect(r.code).toBe(0);
    expect(r.out).toContain("agree about what a self-hoster can set");
  });

  // --- rule 1: one image pin, two copies --------------------------------------------

  it("names the digest when the guide's copy disagrees with the bundle's", () => {
    const t = makeTrees(guideMarkdown(DIGEST_B), bundleCompose(DIGEST_A), envExample());
    const r = runGuard(t.website, t.ops);
    expect(r.code).toBe(1);
    expect(r.out).toContain("the image pin disagrees between the guide and the bundle");
    expect(r.out).toContain(DIGEST_B);
    expect(r.out).toContain(DIGEST_A);
  });

  // --- rule 2: the guide may not document a knob the bundle cannot set ---------------

  it("names an env the guide sets that the bundle's server service does not", () => {
    const t = makeTrees(
      guideMarkdown(DIGEST_A, '      MYNE_NOT_IN_BUNDLE: "1"\n'),
      bundleCompose(),
      envExample(),
    );
    const r = runGuard(t.website, t.ops);
    expect(r.code).toBe(1);
    expect(r.out).toContain("MYNE_NOT_IN_BUNDLE is set by the guide's server service");
  });

  // --- rule 3: the failure the guard was written for ---------------------------------

  it("names a documented server knob the compose never forwards", () => {
    // The shipped bundle had 14 of these: `.env` is read by Compose for `${...}`
    // interpolation only, never injected into the container, so the operator's value
    // silently did nothing.
    const compose = `name: myne-server

services:
  server:
    image: \${MYNE_SERVER_IMAGE:-ghcr.io/myne-md/myne-server@${DIGEST_A}}
    environment:
      MYNE_SOMETHING_ELSE: "1"

volumes:
  myne-data:
`;
    const t = makeTrees(guideMarkdown(), compose, envExample());
    const r = runGuard(t.website, t.ops);
    expect(r.code).toBe(1);
    expect(r.out).toContain("MYNE_SERVER_ADDR is a documented \"kind: server\" entry");
    expect(r.out).toContain("never references it as ${MYNE_SERVER_ADDR}");
  });

  it("names the knob when the two files disagree about its default", () => {
    const t = makeTrees(guideMarkdown(), bundleCompose(DIGEST_A, ":9090"), envExample(":8080"));
    const r = runGuard(t.website, t.ops);
    expect(r.code).toBe(1);
    expect(r.out).toContain("MYNE_SERVER_ADDR has two different defaults");
    expect(r.out).toContain(":9090");
    expect(r.out).toContain(":8080");
  });

  it("does not fire on a commented-out example in the env file", () => {
    const env = `# --- knobs ---
# kind: server
MYNE_SERVER_ADDR=:8080

# --- backup ---
# kind: server
# MYNE_BACKUP_ENABLED=true
`;
    const t = makeTrees(guideMarkdown(), bundleCompose(), env);
    expect(runGuard(t.website, t.ops).code).toBe(0);
  });

  // --- the non-vacuity arms ----------------------------------------------------------

  it("fails by name when the env file documents no server knob at all", () => {
    const t = makeTrees(guideMarkdown(), bundleCompose(), "# nothing here\n");
    const r = runGuard(t.website, t.ops);
    expect(r.code).toBe(1);
    expect(r.out).toContain("was not evaluated");
  });

  it("fails by name when the guide carries no compose block", () => {
    const t = makeTrees("---\ntitle: x\n---\n\nNo block here.\n", bundleCompose(), envExample());
    const r = runGuard(t.website, t.ops);
    expect(r.code).toBe(1);
    expect(r.out).toContain("carries no fenced yaml block");
  });

  it("reports NOTHING COMPARED when the companions are absent, and fails under --require-companion", () => {
    const base = mkdtempSync(join(tmpdir(), "bundle-drift-absent-"));
    const skip = runGuard(join(base, "no-website"), join(base, "no-ops"));
    expect(skip.code).toBe(0);
    expect(skip.out).toContain("NOTHING COMPARED");
    const strict = runGuard(join(base, "no-website"), join(base, "no-ops"), ["--require-companion"]);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("--require-companion was passed");
  });
});
