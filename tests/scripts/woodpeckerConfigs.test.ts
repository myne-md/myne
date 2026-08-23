// The Woodpecker config roster's own spec (myne-md/myne#579).
//
// Root `CLAUDE.md`: "Verifying a guard means breaking it, not running it. Inject
// the exact defect the guard now claims to catch, watch it name that defect,
// then restore." Every case below is an injection against a temporary fixture
// tree, which is why `woodpeckerConfigPaths`/`readWoodpeckerConfigs` take a
// `root` parameter at all.
//
// The stakes are why this file exists rather than a hand-run. Both guards this
// roster serves (`check-woodpecker-substitution.mjs` and
// `check-playwright-image.mjs`) protect a config whose breakage kills every
// gate on every branch, and the repository has already lived that (2026-07-28,
// a `from_secret` naming an absent secret: fmt, clippy, cargo-test, vitest and
// the web lane all dead for a day, with CI unable to report it because CI was
// what broke).
//
// Three failure modes have no observable symptom in production, and between
// them they are why the roster is a NAMED list unioned with what is on disk
// rather than either half alone:
//
//   - `e2e.yml` going missing. It holds both E2E suites, it is triggered by
//     hand before a release, and nothing else in the repository reads it, since
//     `check-e2e-floor.mjs` runs INSIDE it. A purely derived roster returns the
//     one remaining file, both guards print ok, and the pre-release lane has
//     ceased to exist with weeks to notice.
//   - a THIRD workflow file arriving. Woodpecker runs it; a purely named roster
//     never opens it. That one shipped: see the case below for what it cost.
//   - a root `.woodpecker.yml` reappearing beside the directory. Woodpecker's
//     lookup takes the directory and IGNORES that file, so it is dead config:
//     someone edits it, pushes, and nothing changes, with no error anywhere.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  REQUIRED_CONFIGS,
  readWoodpeckerConfigs,
  woodpeckerConfigPaths,
} from "../../scripts/lib/woodpecker-configs.mjs";

const roots: string[] = [];

/** A fixture repo root. `files` maps a repo-relative path to its contents. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "myne-wp-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return root;
}

/** A fixture carrying exactly the roster this repository declares. */
function healthy(extra: Record<string, string> = {}): string {
  const files: Record<string, string> = {};
  for (const name of REQUIRED_CONFIGS) files[`.woodpecker/${name}`] = `steps: {}\n# ${name}\n`;
  return fixture({ ...files, ...extra });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("the healthy case", () => {
  it("returns every required config, sorted, with its contents", () => {
    const root = healthy();
    expect(woodpeckerConfigPaths(root)).toEqual(
      [...REQUIRED_CONFIGS].map((n) => `.woodpecker/${n}`).sort(),
    );
    const read = readWoodpeckerConfigs(root);
    expect(read.map((c) => c.rel).sort()).toEqual(woodpeckerConfigPaths(root));
    for (const { rel, text } of read) expect(text).toContain(rel.split("/")[1]);
  });

  // The case that shipped broken. The first version returned the named roster
  // and nothing else, so a third workflow file was run by Woodpecker and opened
  // by no guard. `not.toThrow()` was the whole assertion, which enshrined the
  // hole instead of catching it: a guard that never reads a file does not throw
  // either. MEASURED before this case existed: a `.woodpecker/nightly.yml`
  // carrying an unescaped single-dollar brace token made
  // `check-woodpecker-substitution.mjs` print ok, and a stale
  // `mcr.microsoft.com/playwright:v1.40.0-noble` in the same file made
  // `check-playwright-image.mjs` print ok. Both now name it.
  it("SCANS a third workflow file, which is a legitimate addition", () => {
    const root = healthy({ ".woodpecker/nightly.yml": "steps: {}\n# nightly\n" });
    expect(woodpeckerConfigPaths(root)).toContain(".woodpecker/nightly.yml");
    const read = readWoodpeckerConfigs(root);
    expect(read.find((c) => c.rel === ".woodpecker/nightly.yml")?.text).toContain("nightly");
  });

  it("scans a `.yaml` third file too, since Woodpecker runs both extensions", () => {
    const root = healthy({ ".woodpecker/nightly.yaml": "steps: {}\n" });
    expect(woodpeckerConfigPaths(root)).toContain(".woodpecker/nightly.yaml");
  });

  it("lists each roster member once, not twice, now that the two halves union", () => {
    const paths = woodpeckerConfigPaths(healthy());
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual([...paths].sort());
  });

  // A directory named `something.yml` is not a workflow file.
  it("ignores a directory whose name ends in .yml", () => {
    const root = healthy();
    mkdirSync(join(root, ".woodpecker", "fixtures.yml"));
    expect(woodpeckerConfigPaths(root)).not.toContain(".woodpecker/fixtures.yml");
  });
});

describe("the injections", () => {
  it("fails by name when the config directory is absent", () => {
    const root = fixture({ "README.md": "no ci here\n" });
    expect(() => woodpeckerConfigPaths(root)).toThrow(/\.woodpecker\/ does not exist/);
  });

  // The case a derived roster cannot see. `e2e.yml` is the file that can vanish
  // in a merge with nobody noticing, because nothing else in the repo reads it.
  it.each(REQUIRED_CONFIGS)("fails by name when %s is missing", (name) => {
    const root = healthy();
    rmSync(join(root, ".woodpecker", name));
    expect(() => woodpeckerConfigPaths(root)).toThrow(new RegExp(name.replace(".", "\\.")));
  });

  it("fails when the directory exists but holds none of the roster", () => {
    const root = fixture({ ".woodpecker/notes.txt": "not a workflow\n" });
    expect(() => woodpeckerConfigPaths(root)).toThrow(/missing/);
  });

  // Dead config: Woodpecker ignores a root file once the directory exists, so
  // scanning it would be worse than failing on it. A clean scan of a file that
  // does not run is a guard endorsing a lie.
  it.each([".woodpecker.yml", ".woodpecker.yaml"])(
    "fails when a root %s shadows the directory",
    (name) => {
      const root = healthy({ [name]: "steps: {}\n" });
      expect(() => woodpeckerConfigPaths(root)).toThrow(/ignores the root/);
    },
  );
});

describe("what the roster does NOT do", () => {
  // The direction that matters: it must never quietly substitute a root file
  // for a missing directory, which is what a "be forgiving" fix would do.
  it("does not fall back to a root .woodpecker.yml when the directory is absent", () => {
    const root = fixture({ ".woodpecker.yml": "steps: {}\n" });
    expect(() => woodpeckerConfigPaths(root)).toThrow(/does not exist/);
  });

  it("never returns an empty list instead of throwing", () => {
    const root = fixture({ ".woodpecker/main.yml": "steps: {}\n" });
    let returned: unknown = "did not return";
    try {
      returned = woodpeckerConfigPaths(root);
    } catch {
      returned = "threw";
    }
    expect(returned).toBe("threw");
  });
});
