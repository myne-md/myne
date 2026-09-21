/**
 * `scripts/check-clipper-identifiers.mjs` catches each drift class it claims to
 * — myne-md/myne#558.
 *
 * # Why a guard gets its own test
 *
 * Root `AGENTS.md` is explicit: "Verifying a guard means breaking it, not
 * running it. A guard that has never failed is a guard nobody has tested."
 * Three consecutive reviews of one feature found a check that passed while the
 * thing it checked was wrong, and in each case the check had just been *fixed*
 * and "verified" by passing afterwards — which proves nothing.
 *
 * So each defect is injected into a COPY of the tree and the guard is run
 * against it, and the assertion is that it names that defect. A copy rather
 * than the real files: a test that mutates `src-tauri/` and restores in a
 * `finally` leaves the repository broken whenever it is interrupted, and this
 * one runs in a suite people cancel.
 *
 * # The branch that matters most is the one that runs in CI
 *
 * The companion repo is absent in a fresh clone and absent on the runner, so
 * the companion-ABSENT branch is the one that executes there — and its bug
 * (reporting `ok` while silently checking half of what the name claims) is
 * invisible by construction. `MYNE_CLIPPER_DIR` exists so that branch can be
 * exercised on a machine that HAS the companion, which is every machine where
 * anyone would think to test it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = process.cwd();
const GUARD = "scripts/check-clipper-identifiers.mjs";
const MANIFEST_RS = "src-tauri/src/clipper/manifest.rs";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A minimal copy of the tree the guard reads, so an injection never touches the
 * working checkout.
 *
 * Only the four inputs are copied. The guard resolves everything from its own
 * location, so putting it under `<scratch>/scripts/` is what makes the copy a
 * self-contained repo root as far as it is concerned.
 */
function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), "clipper-guard-"));
  scratch.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "src-tauri", "src", "clipper"), { recursive: true });
  cpSync(join(REPO_ROOT, GUARD), join(dir, GUARD));
  cpSync(join(REPO_ROOT, MANIFEST_RS), join(dir, MANIFEST_RS));
  cpSync(join(REPO_ROOT, "AGENTS.md"), join(dir, "AGENTS.md"));
  return dir;
}

/** A companion checkout carrying `key` and `gecko.id`. */
function companion(opts: { key?: string; gecko?: string | null } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "clipper-companion-"));
  scratch.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  const real = JSON.parse(
    readFileSync(join(REAL_COMPANION, "src", "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  const manifest: Record<string, unknown> = { ...real };
  if (opts.key !== undefined) manifest.key = opts.key;
  if (opts.gecko !== undefined) {
    manifest.browser_specific_settings =
      opts.gecko === null ? undefined : { gecko: { id: opts.gecko } };
    delete manifest.applications;
  }
  writeFileSync(join(dir, "src", "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/**
 * Run the guard in `dir`; returns BOTH streams and the exit status.
 *
 * `spawnSync` rather than `execFileSync`, and that is a correction: the latter
 * returns stdout only, so on the SUCCESS path this dropped stderr entirely —
 * and stderr is where the guard prints what it could not check. The
 * companion-absent test therefore reported "no NOT CHECKED line" against a
 * guard that had printed one, which is a failure invented by the harness.
 */
function run(dir: string, opts: { companionDir?: string; args?: string[] } = {}) {
  const r = spawnSync("node", [join(dir, GUARD), ...(opts.args ?? [])], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(opts.companionDir === undefined ? {} : { MYNE_CLIPPER_DIR: opts.companionDir }),
    },
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function patchManifestRs(dir: string, from: string, to: string): void {
  const path = join(dir, MANIFEST_RS);
  const source = readFileSync(path, "utf8");
  expect(source, `injection anchor "${from}" is not in ${MANIFEST_RS}`).toContain(from);
  writeFileSync(path, source.replace(from, to));
}

// The real companion, needed for the cross-repo assertions. Skipped rather than
// silently passing where it is absent — the guard's own posture.
//
// **Both layouts, for the reason the guard now carries in its own comment.**
// Companions are cloned NESTED at `<repo>/myne-clipper`
// (`workspace/manifest.txt`); from a worktree under `.opencode/worktrees/<name>`
// that same directory is three levels up. This file hardcoded only the second,
// so it passed from a worktree and failed from the ordinary checkout with the
// guard reporting NOT CHECKED — four cross-repo assertions that looked like a
// broken guard and were a broken path.
const REAL_COMPANION =
  [join(REPO_ROOT, "myne-clipper"), join(REPO_ROOT, "..", "..", "..", "myne-clipper")].find((c) =>
    existsSync(join(c, "src", "manifest.json")),
  ) ?? join(REPO_ROOT, "myne-clipper");

describe("the clipper-identifier guard", () => {
  it("passes on the tree as it stands", () => {
    const r = run(tree(), { companionDir: REAL_COMPANION });
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toContain("derivation verified against the companion");
  });

  it("names a Chromium id that does not derive from the committed key", () => {
    // THE cross-repo check, and the one no single repository can make. A pinned
    // id that stops matching the extension's key means the browser starts the
    // host for nobody.
    const dir = tree();
    patchManifestRs(dir, "ebbbblnjddeockegombcnbiljefmlhbh", "ebbbblnjddeockegombcnbiljefmlhbp");
    const r = run(dir, { companionDir: REAL_COMPANION });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("CHROMIUM_EXTENSION_ID drift");
    expect(r.out).toContain("derives");
  });

  it("names a Chromium id outside the [a-p] alphabet", () => {
    const dir = tree();
    patchManifestRs(dir, "ebbbblnjddeockegombcnbiljefmlhbh", "zzzzzlnjddeockegombcnbiljefmlhbh");
    const r = run(dir, { companionDir: REAL_COMPANION });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("not 32 characters of [a-p]");
  });

  it("names a Firefox id that disagrees with the extension's gecko id", () => {
    const dir = tree();
    patchManifestRs(dir, '"clipper@myne.md"', '"other@myne.md"');
    const r = run(dir, { companionDir: REAL_COMPANION });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("FIREFOX_EXTENSION_ID drift");
  });

  it("names a renamed constant rather than reporting ok on an input it cannot read", () => {
    // The failure mode a scan has that a compiler does not: a rename makes the
    // pattern miss, and a guard that treated "not found" as "nothing to check"
    // would go green on the change most likely to matter.
    const dir = tree();
    patchManifestRs(dir, "pub const HOST_NAME", "pub const HOST_RENDEZVOUS_NAME");
    const r = run(dir, { companionDir: REAL_COMPANION });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("could not find");
  });

  it("names a constant that is declared and never used", () => {
    // A manifest builder that inlined a literal keeps working and stops
    // tracking the constant the pairing token binds to — invisible to every
    // compiler, because both the constant and the literal are valid.
    const dir = tree();
    const path = join(dir, MANIFEST_RS);
    const source = readFileSync(path, "utf8");
    // Replace every USE, leaving the declaration.
    const declaration = 'pub const FIREFOX_EXTENSION_ID: &str = "clipper@myne.md";';
    const withoutUses = source
      .split(declaration)
      .map((part: string, i: number) =>
        i === 0 ? part : part.replaceAll("FIREFOX_EXTENSION_ID", '"clipper@myne.md"'),
      )
      .join(declaration);
    writeFileSync(path, withoutUses);
    const r = run(dir, { companionDir: REAL_COMPANION });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("declared and never used");
  });

  it("names a value the published identifier table no longer carries", () => {
    // The table is normative prose — a reader takes the value from it — so a
    // constant changed without it leaves a wrong identifier published in the
    // document whose whole job is being the reference.
    const dir = tree();
    const claude = readFileSync(join(dir, "AGENTS.md"), "utf8");
    writeFileSync(
      join(dir, "AGENTS.md"),
      claude.replaceAll("md.myne.clipper", "md.myne.clipper-OLD"),
    );
    const r = run(dir, { companionDir: REAL_COMPANION });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("does not carry HOST_NAME");
  });

  it("says what it could NOT check when the companion is absent, and still passes", () => {
    // The branch that runs in CI and in a fresh clone. It must not claim the
    // derivation was verified — that is the silent-skip failure this guard's
    // header cites from `check-embed-layout-drift.mjs`.
    const r = run(tree(), { companionDir: join(tmpdir(), "definitely-not-a-checkout") });
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toContain("NOT CHECKED");
    expect(
      r.out,
      "the success line still claims the derivation was verified while the " +
        "companion was absent — which is the exact half-checked `ok` this guard " +
        "exists not to print",
    ).not.toContain("derivation verified against the companion");
  });

  it("fails on an absent companion under --require-companion", () => {
    const r = run(tree(), {
      companionDir: join(tmpdir(), "definitely-not-a-checkout"),
      args: ["--require-companion"],
    });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("not checked out");
  });

  it("names a companion manifest with no key", () => {
    const dir = tree();
    const c = companion({ key: undefined });
    // Remove the key outright.
    const p = join(c, "src", "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    delete m.key;
    writeFileSync(p, JSON.stringify(m, null, 2));
    const r = run(dir, { companionDir: c });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("no `key` field");
  });
});
