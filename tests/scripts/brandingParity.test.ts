/**
 * `scripts/check-branding-parity.mjs` catches each drift class it claims to —
 * audit 2026-10-18 B5+B6+B7.
 *
 * # Why a guard gets its own test
 *
 * Root `AGENTS.md` is explicit: "Verifying a guard means breaking it, not
 * running it. A guard that has never failed is a guard nobody has tested." So
 * each defect is injected into a COPY of the tree (or into a synthetic
 * companion) and the guard is run against it, and the assertion is that it
 * names that defect.
 *
 * # The branch that runs in CI is the companion-ABSENT one
 *
 * CI clones `myne-server` and `myne-test-vectors` only, so all three companions
 * are absent there and `NOTHING COMPARED` is what a push actually sees. The
 * `MYNE_BRANDING_DIR` / `MYNE_CLIPPER_DIR` / `MYNE_WEBSITE_DIR` overrides exist
 * so both branches are exercisable on the machine that has the companions; the
 * SYNTHETIC companion fixtures below carry the always-run injection cases so CI
 * exercises the named-failure arms too, not just the absent one.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = process.cwd();
const GUARD = "scripts/check-branding-parity.mjs";
const TWIN = "scripts/check-twin-inventory.mjs";
const APP_SHEET = "client-core/src/tokens.css";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A self-contained repo root the guard can run from: the guard + its app sheet. */
function tree(opts: { appSheet?: string | null } = {}): string {
  const dir = mkTmp("branding-guard-");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "client-core", "src"), { recursive: true });
  cpSync(join(REPO_ROOT, GUARD), join(dir, GUARD));
  cpSync(join(REPO_ROOT, TWIN), join(dir, TWIN));
  if (opts.appSheet !== null) {
    writeFileSync(join(dir, APP_SHEET), opts.appSheet ?? (readFileSync(join(REPO_ROOT, APP_SHEET), "utf8") as string));
  }
  return dir;
}

/** A synthetic companion checkout from `relpath -> contents`. */
function companion(files: Record<string, string>): string {
  const dir = mkTmp("branding-companion-");
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), contents);
  }
  return dir;
}

/** A path that exists but holds no companion, so the guard takes the absent branch. */
function emptyDir(): string {
  return mkTmp("branding-empty-");
}

/** The real companions, tried in both layouts. Skipped, never silently green. */
function realCompanion(nested: string, marker: string): string {
  const candidates = [join(REPO_ROOT, nested), join(REPO_ROOT, "..", "..", "..", nested)];
  return candidates.find((c) => existsSync(join(c, marker))) ?? join(REPO_ROOT, nested);
}
const REAL_BRANDING = realCompanion("myne-branding", join("color", "palette.json"));
const REAL_CLIPPER = realCompanion("myne-clipper", join("src", "lib", "tokens.css"));
const REAL_WEBSITE = realCompanion("myne-website", join("src", "lib", "themeBuilder", "tokens.mjs"));
const HAS_ALL_COMPANIONS =
  existsSync(join(REAL_BRANDING, "color", "palette.json")) &&
  existsSync(join(REAL_CLIPPER, "src", "lib", "tokens.css")) &&
  existsSync(join(REAL_WEBSITE, "src", "lib", "themeBuilder", "tokens.mjs"));

interface RunOpts {
  branding?: string;
  clipper?: string;
  website?: string;
  args?: string[];
}

/** Run the guard in `dir`; returns BOTH streams and the exit status. */
function run(dir: string, opts: RunOpts = {}): { ok: boolean; out: string } {
  const r = spawnSync("node", [join(dir, GUARD), ...(opts.args ?? [])], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      MYNE_BRANDING_DIR: opts.branding ?? emptyDir(),
      MYNE_CLIPPER_DIR: opts.clipper ?? emptyDir(),
      MYNE_WEBSITE_DIR: opts.website ?? emptyDir(),
    },
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** A clipper token copy carrying one `--danger` value in its light block. */
function clipperFixture(danger: string): Record<string, string> {
  return {
    "src/lib/tokens.css": `.myne-overlay {\n  --danger: ${danger};\n}\n`,
    "src/lib/icon-svg.ts": 'export const STATE_INK = { idle: "#1f2933", saved: "#2f6048", locked: "#8a2a23" };\n',
  };
}

/** The app sheet's declared member names of one family, so a fixture drifts only where injected. */
function appFamilyNames(prefix: string): string[] {
  const sheet = readFileSync(join(REPO_ROOT, APP_SHEET), "utf8") as string;
  const names = new Set<string>();
  for (const m of sheet.matchAll(new RegExp(`${prefix}[\\w-]+`, "g"))) names.add(m[0]);
  return [...names];
}

/** A theme-builder model with an injected roster / seed. */
function websiteFixture(opts: {
  highlights?: string[];
  darkHighlight?: string;
  manifestExtra?: boolean;
}): Record<string, string> {
  const highlights = opts.highlights ?? [
    "--highlight",
    "--highlight-green",
    "--highlight-blue",
    "--highlight-pink",
    "--highlight-purple",
  ];
  // Everything the app declares EXCEPT the highlight family, so a failing test
  // fails on the injected drift rather than on 18 unrelated absent families.
  const syntax = appFamilyNames("--syntax-");
  const label = appFamilyNames("--label-");
  const tokens = [
    'export const REQUIRED_TOKENS = ["--paper"];',
    `export const SYNTAX_TOKENS = ${JSON.stringify(syntax)};`,
    `export const LABEL_TOKENS = ${JSON.stringify(label)};`,
    `export const HIGHLIGHT_TOKENS = ${JSON.stringify(highlights)};`,
    "export const OPTIONAL_TOKENS = [...SYNTAX_TOKENS, ...LABEL_TOKENS, ...HIGHLIGHT_TOKENS];",
    "export const ALL_TOKENS = [...REQUIRED_TOKENS, ...OPTIONAL_TOKENS];",
    'export const LIGHT_DEFAULTS = {\n  "--paper": "#fbfbfa",\n};',
    `export const DARK_DEFAULTS = {\n  "--highlight": "${opts.darkHighlight ?? "#4f4422"}",\n};`,
    "",
  ].join("\n");
  const manifestTokens =
    opts.manifestExtra === false ? ["--highlight"] : [...syntax, ...label, ...highlights];
  const rows = manifestTokens.map((t) => `  { token: "${t}", label: "X" },`).join("\n");
  const manifest = `export const GROUPS = [\n  { id: "highlights", label: "Text highlights", disclosure: true, tokens: [\n${rows}\n  ] },\n];\n`;
  return {
    "src/lib/themeBuilder/tokens.mjs": tokens,
    "src/lib/themeBuilder/manifest.mjs": manifest,
  };
}

describe("the cross-repo token-binding guard", () => {
  it("passes on the real companions (branding, clipper, website)", { skip: !HAS_ALL_COMPANIONS }, () => {
    const r = run(tree(), { branding: REAL_BRANDING, clipper: REAL_CLIPPER, website: REAL_WEBSITE });
    expect(r.out, r.out).toContain("branding-parity: ok");
    expect(r.ok).toBe(true);
    expect(r.out).toContain("branding, clipper, website");
  });

  it("reports every absent companion and still exits ok — the branch a fresh clone takes", () => {
    const r = run(tree());
    expect(r.ok).toBe(true);
    expect(r.out).toContain("NOTHING COMPARED");
    expect(r.out).toContain("myne-branding companion is not checked out");
    expect(r.out).toContain("myne-clipper companion is not checked out");
    expect(r.out).toContain("myne-website companion is not checked out");
  });

  it("--require-companion turns an absent companion into a failure", () => {
    const r = run(tree(), { args: ["--require-companion"] });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("myne-branding companion is not checked out");
  });

  it("fails by name when the app sheet itself is missing", () => {
    const r = run(tree({ appSheet: null }));
    expect(r.ok).toBe(false);
    expect(r.out).toContain("the app token sheet is missing");
    expect(r.out).toContain(APP_SHEET);
  });

  it("fails by name when a mapped branding anchor cannot be read", () => {
    // An empty palette `{}` has none of the mapped keys: a guard that treated
    // "not found" as "nothing to check" would be green on the file it cannot read.
    const branding = companion({ "color/palette.json": "{}", "typography/type-scale.json": "{}" });
    const r = run(tree(), { branding });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("--accent");
    expect(r.out).toContain("is missing");
  });

  it("fails by name when a checked-out companion is missing one of its files", () => {
    // The hole the first draft had: keying presence on "BOTH files, or absent"
    // would report a half-deleted export as "not checked out" and go green on a
    // file it never read.
    const branding = companion({ "color/palette.json": "{}" });
    const r = run(tree(), { branding });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("type-scale.json is missing from a companion that IS checked out");
  });

  it("names a branding value that stopped agreeing with the app", { skip: !HAS_ALL_COMPANIONS }, () => {
    const dir = companion({
      "color/palette.json": readFileSync(join(REAL_BRANDING, "color", "palette.json"), "utf8") as string,
      "typography/type-scale.json": readFileSync(join(REAL_BRANDING, "typography", "type-scale.json"), "utf8") as string,
    });
    const palettePath = join(dir, "color", "palette.json");
    const palette = JSON.parse(readFileSync(palettePath, "utf8")) as {
      semanticLight: Record<string, string>;
    };
    palette.semanticLight.accent = "#000000";
    writeFileSync(palettePath, JSON.stringify(palette, null, 2));
    const r = run(tree(), { branding: dir });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("myne-branding/color/palette.json semanticLight");
    expect(r.out).toContain("--accent");
  });

  it("names the clipper's `--danger` when it is not the app's value", () => {
    const r = run(tree(), { clipper: companion(clipperFixture("#b54034")) });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("myne-clipper light: --danger");
    expect(r.out).toContain("#b54034");
    expect(r.out).toContain("#8a2a23");
  });

  it("names the clipper's `STATE_INK.locked` when it is not the app's danger value", () => {
    const dir = companion({
      ...clipperFixture("#8a2a23"),
      "src/lib/icon-svg.ts": 'export const STATE_INK = { saved: "#2f6048", locked: "#b54034" };\n',
    });
    const r = run(tree(), { clipper: dir });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("myne-clipper STATE_INK.locked");
    expect(r.out).toContain("#b54034");
  });

  it("fails by name when the clipper's overlay block is renamed away", () => {
    const dir = companion({ "src/lib/tokens.css": ".overlay {\n  --danger: #8a2a23;\n}\n" });
    const r = run(tree(), { clipper: dir });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("could not find the `.myne-overlay` block");
  });

  it("names every app highlight the builder cannot serialize", () => {
    const r = run(tree(), {
      website: companion(websiteFixture({ highlights: ["--highlight", "--highlight-green"] })),
    });
    expect(r.ok).toBe(false);
    for (const token of ["--highlight-red", "--highlight-teal", "--highlight-cyan", "--highlight-indigo"]) {
      expect(r.out).toContain(token);
    }
    expect(r.out).toContain("the theme builder cannot serialize it");
  });

  it("names a stale dark seed in the builder's defaults", () => {
    const r = run(tree(), {
      website: companion(websiteFixture({ highlights: ["--highlight"], darkHighlight: "#4a3f1e" })),
    });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("myne-website DARK_DEFAULTS: --highlight");
    expect(r.out).toContain("#4a3f1e");
    expect(r.out).toContain("#4f4422");
  });

  it("names a manifest roster that has fallen behind the token model", () => {
    const r = run(tree(), {
      website: companion(websiteFixture({ highlights: ["--highlight", "--highlight-green"], manifestExtra: false })),
    });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("manifest.mjs does not expose it");
    expect(r.out).toContain("--highlight-green");
  });

  it("still catches a renamed builder export rather than reporting ok on an unread file", () => {
    const dir = companion({
      "src/lib/themeBuilder/tokens.mjs": "export const SOMETHING_ELSE = [];\n",
      "src/lib/themeBuilder/manifest.mjs": "export const GROUPS = [];\n",
    });
    const r = run(tree(), { website: dir });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("could not read");
  });
});
