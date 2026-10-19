/**
 * `scripts/check-clipper-wire.mjs` catches each drift class it claims.
 *
 * The sibling of `tests/scripts/clipperIdentifiers.test.ts` and the same shape:
 * each defect is injected into a COPY of the tree and the guard is run against
 * it, and the assertion is that it names that defect. A copy rather than the
 * real files: a test that mutated `src-tauri/` or the companion and restored in
 * a `finally` leaves the repository broken whenever it is interrupted.
 *
 * # The branch that runs in CI is the one that most needs a test
 *
 * The companion repo is absent in a fresh clone and on the runner, so
 * `MYNE_CLIPPER_DIR` exists to exercise the absent branch on a machine that HAS
 * the companion — which is every machine where anyone would think to test it.
 * The INTRA-repo half (`capture_kind` between `envelope.rs` and
 * `captureKind.ts`) runs WITHOUT the companion, so it is gated in CI by the two
 * tests marked "no companion" below.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = process.cwd();
const GUARD = "scripts/check-clipper-wire.mjs";
const ENVELOPE_RS = "src-tauri/src/clipper/envelope.rs";
const CAPTURE_KIND_TS = "src/dialect/clip/captureKind.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A minimal copy of the tree the guard reads from the MAIN repo, so an injection
 * never touches the working checkout. The guard resolves everything from its own
 * location, so putting it under `<scratch>/scripts/` makes the copy a
 * self-contained repo root as far as it is concerned.
 */
function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), "clipper-wire-"));
  scratch.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "src-tauri", "src", "clipper"), { recursive: true });
  mkdirSync(join(dir, "src", "dialect", "clip"), { recursive: true });
  cpSync(join(REPO_ROOT, GUARD), join(dir, GUARD));
  cpSync(join(REPO_ROOT, ENVELOPE_RS), join(dir, ENVELOPE_RS));
  cpSync(join(REPO_ROOT, CAPTURE_KIND_TS), join(dir, CAPTURE_KIND_TS));
  return dir;
}

const REAL_COMPANION =
  [join(REPO_ROOT, "myne-clipper"), join(REPO_ROOT, "..", "..", "..", "myne-clipper")].find((c) =>
    existsSync(join(c, "src", "manifest.json")),
  ) ?? join(REPO_ROOT, "myne-clipper");
const HAS_COMPANION = existsSync(join(REAL_COMPANION, "src", "manifest.json"));

const COMPANION_FILES = [
  "src/manifest.json",
  "src/background/envelope.ts",
  "src/background/clip.ts",
  "src/background/pair-wire.ts",
  "src/background/status-wire.ts",
  "src/content/capture.ts",
];

/** A companion checkout carrying the wire files the guard reads. */
function companion(): string {
  const dir = mkdtempSync(join(tmpdir(), "clipper-wire-companion-"));
  scratch.push(dir);
  for (const rel of COMPANION_FILES) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(REAL_COMPANION, rel), dest);
  }
  return dir;
}

/** Run the guard in `dir`; returns BOTH streams and the exit status. */
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

const DEFINITELY_ABSENT = join(tmpdir(), "definitely-not-a-wire-checkout");

function patch(path: string, from: string, to: string): void {
  const source = readFileSync(path, "utf8");
  expect(source, `injection anchor "${from}" is not in ${path}`).toContain(from);
  writeFileSync(path, source.replace(from, to));
}

describe("the clipper-wire guard", () => {
  it("passes on the tree as it stands", { skip: !HAS_COMPANION }, () => {
    const r = run(tree(), { companionDir: REAL_COMPANION });
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toContain("extension cross-checked");
  });

  // ── The INTRA-repo half: gated in CI, no companion needed ────────────────

  it("names a Rust capture_kind the dialect does not declare, with NO companion", () => {
    const dir = tree();
    patch(join(dir, ENVELOPE_RS), "    Bookmark,\n", "    BookmarkPage,\n");
    const r = run(dir, { companionDir: DEFINITELY_ABSENT });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("capture_kind drift");
    expect(r.out).toContain("bookmark-page");
  });

  it("names a dialect capture_kind the Rust enum does not declare, with NO companion", () => {
    const dir = tree();
    patch(join(dir, CAPTURE_KIND_TS), '  "bookmark",\n', '  "bookmark-link",\n');
    const r = run(dir, { companionDir: DEFINITELY_ABSENT });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("capture_kind drift");
    expect(r.out).toContain("bookmark-link");
  });

  it("names a renamed enum rather than reporting ok on an input it cannot read", () => {
    const dir = tree();
    patch(join(dir, ENVELOPE_RS), "pub enum CaptureKind", "pub enum ClipCaptureKind");
    const r = run(dir, { companionDir: DEFINITELY_ABSENT });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("could not find");
  });

  // ── The companion-ABSENT branch (the one CI actually takes) ──────────────

  it("says what it could NOT check when the companion is absent, and still passes", () => {
    const r = run(tree(), { companionDir: DEFINITELY_ABSENT });
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toContain("NOT CHECKED");
    expect(
      r.out,
      "the success line claims the extension was cross-checked while the " +
        "companion was absent — the half-checked `ok` this guard exists not to print",
    ).not.toContain("extension cross-checked");
  });

  it("fails on an absent companion under --require-companion", () => {
    const r = run(tree(), { companionDir: DEFINITELY_ABSENT, args: ["--require-companion"] });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("not checked out");
  });

  // ── The cross-repo half ──────────────────────────────────────────────────

  it("names an envelope field the extension drops", { skip: !HAS_COMPANION }, () => {
    const dir = tree();
    const c = companion();
    patch(join(c, "src/background/envelope.ts"), "  readonly capture_kind: CaptureKind;\n", "");
    const r = run(dir, { companionDir: c });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("envelope field dictionary drift");
    expect(r.out).toContain("capture_kind");
  });

  it("names an envelope field the extension adds that Rust does not carry", { skip: !HAS_COMPANION }, () => {
    const dir = tree();
    const c = companion();
    patch(
      join(c, "src/background/envelope.ts"),
      "  readonly tags: readonly string[];\n",
      "  readonly tags: readonly string[];\n  readonly page_title: string;\n",
    );
    const r = run(dir, { companionDir: c });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("envelope field dictionary drift");
    expect(r.out).toContain("page_title");
  });

  it("names an extension capture_kind that Rust does not carry", { skip: !HAS_COMPANION }, () => {
    const dir = tree();
    const c = companion();
    patch(
      join(c, "src/background/clip.ts"),
      'export type CaptureKind = "full-article" | "selection" | "bookmark";',
      'export type CaptureKind = "full-article" | "selection" | "bookmark-page";',
    );
    const r = run(dir, { companionDir: c });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("capture_kind drift");
    expect(r.out).toContain("bookmark-page");
  });

  it("names a handoff kind the extension declares that Rust does not", { skip: !HAS_COMPANION }, () => {
    const dir = tree();
    const c = companion();
    patch(join(c, "src/background/pair-wire.ts"), 'kind: "pair-await"', 'kind: "pair-finish"');
    const r = run(dir, { companionDir: c });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("handoff kind drift");
    expect(r.out).toContain("pair-finish");
    expect(r.out).toContain("pair-await");
  });

  it("names a reply status the extension no longer handles", { skip: !HAS_COMPANION }, () => {
    const dir = tree();
    const c = companion();
    patch(join(c, "src/background/pair-wire.ts"), 'reply.status === "paired"', 'reply.status === "paired-ok"');
    const r = run(dir, { companionDir: c });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("reply status drift");
    expect(r.out).toContain("paired");
  });

  it("names a missing extension envelope file rather than checking less", { skip: !HAS_COMPANION }, () => {
    const dir = tree();
    const c = companion();
    rmSync(join(c, "src/background/envelope.ts"));
    const r = run(dir, { companionDir: c });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("missing");
  });
});
