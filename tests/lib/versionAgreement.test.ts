/**
 * Every place that declares Myne's version declares the same one —
 * myne-md/myne#555, the `settings.panel.about` bullet:
 *
 *   > version/channel/commit are compile-time defines a scenario compares
 *   > against `package.json` and git HEAD.
 *
 * # What the roster row was checking, and what it could not see
 *
 * It asked a person to open Settings → About and confirm the version matched
 * the release being tested. One person, one client, one build. The version is
 * declared in **six** places across three clients and two languages, and a
 * walk of the desktop About panel cannot see five of them.
 *
 * # Why the drift is worse than a cosmetic mismatch
 *
 * `__APP_VERSION__` is what About renders, and each client's Vite config
 * injects it from a DIFFERENT `package.json` — the desktop and web builds from
 * the repo root's, mobile from its own. The Tauri configs carry their own
 * `version` field, which is what the bundle identifier, the installer and the
 * updater metadata use. `src-tauri/Cargo.toml` carries a third for the crate.
 *
 * So a release where one of them lags produces an app that TELLS the user one
 * version while its bundle, its crash reports and its update check say another.
 * Every bug report from that build then names a version whose source tree does
 * not contain the bug, which is the kind of thing that costs a day and gets
 * blamed on the reporter.
 *
 * Nothing checks it. `pnpm version` bumps one file. The Tauri configs are JSON
 * nobody's compiler reads. `Cargo.toml`'s is checked by cargo against nothing.
 *
 * # Scope
 *
 * Equality across the six, and nothing about what the value should BE — that is
 * the release's decision, not this test's. A test that pinned a literal would
 * fail on every bump, which is the fastest way to teach people to edit a test
 * without reading it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `process.cwd()` rather than `import.meta.url`: under jsdom the module URL is
// served as `/@fs/…`, which `fileURLToPath` turns into a path that does not
// exist. Vitest runs from the repo root.
const REPO_ROOT = process.cwd();

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, relative), "utf8")) as Record<string, unknown>;
}

/** The `version = "x.y.z"` at the top of a Cargo manifest — the crate's own,
 *  not a dependency's, so only the first occurrence before any `[section]`
 *  other than `[package]` counts. */
function cargoVersion(relative: string): string | null {
  const source = readFileSync(join(REPO_ROOT, relative), "utf8");
  const pkg = source.indexOf("[package]");
  if (pkg < 0) return null;
  const rest = source.slice(pkg);
  const end = rest.indexOf("\n[", 1);
  const block = end < 0 ? rest : rest.slice(0, end);
  const m = block.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return m ? m[1]! : null;
}

/** Every declaration, with what it drives — the message is only useful if it
 *  says what the mismatched number actually affects. */
const DECLARATIONS: Array<{ where: string; drives: string; read: () => string | null }> = [
  {
    where: "package.json",
    drives: "__APP_VERSION__ in the desktop and web builds — what Settings → About renders",
    read: () => (readJson("package.json").version as string) ?? null,
  },
  {
    where: "mobile/package.json",
    drives: "__APP_VERSION__ in the mobile build — what the mobile About sheet renders",
    read: () => (readJson("mobile/package.json").version as string) ?? null,
  },
  {
    where: "src-tauri/tauri.conf.json",
    drives: "the desktop bundle, installer and updater metadata",
    read: () => (readJson("src-tauri/tauri.conf.json").version as string) ?? null,
  },
  {
    where: "mobile/src-tauri/tauri.conf.json",
    drives: "the iOS/Android bundle version the stores see",
    read: () => (readJson("mobile/src-tauri/tauri.conf.json").version as string) ?? null,
  },
  {
    where: "src-tauri/Cargo.toml",
    drives: "the myne-desktop crate version",
    read: () => cargoVersion("src-tauri/Cargo.toml"),
  },
  {
    where: "mobile/src-tauri/Cargo.toml",
    drives: "the mobile Tauri crate version",
    read: () => cargoVersion("mobile/src-tauri/Cargo.toml"),
  },
];

describe("the version is declared once, in six places, and they agree", () => {
  it("finds a version in every declaration", () => {
    // Non-vacuity, and the thing that fails when a file MOVES: a `null` here
    // would otherwise be compared against nothing and the agreement below would
    // hold over a shorter list every time somebody renamed something.
    for (const d of DECLARATIONS) {
      const v = d.read();
      expect(v, `no version found in ${d.where} — it drives ${d.drives}`).toBeTruthy();
      expect(v, `${d.where} does not look like a version: ${v}`).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("declares the same version everywhere", () => {
    const seen = DECLARATIONS.map((d) => ({ ...d, version: d.read() }));
    const reference = seen[0]!;
    const wrong = seen.filter((d) => d.version !== reference.version);
    expect(
      wrong.map((d) => `${d.where} says ${d.version} (drives ${d.drives})`),
      `${reference.where} says ${reference.version}, and these disagree. A build ` +
        `where they diverge tells the user one version while its bundle, its crash ` +
        `reports and its update check say another — so every bug report from it ` +
        `names a version whose source tree does not contain the bug.`,
    ).toEqual([]);
  });

  it("no About surface hardcodes a version instead of reading the define", () => {
    // The failure this file was written to prevent, arriving through a door the
    // six-way comparison above cannot see: all six declarations agreed
    // perfectly while `mobile/src/app/flows/SettingsSheet.tsx` rendered the
    // literal `0.1.0` on an app shipping 0.5.0. Its own `vite.config.ts`
    // injects `__APP_VERSION__` from `mobile/package.json` and says in a
    // comment that this row reads it. It did not.
    //
    // A mobile About screen naming a version four minors old means every bug
    // report from that build points at a source tree that cannot contain the
    // bug — the same cost as a config drift, from the opposite direction.
    const SURFACES = [
      "src/components/settings/AboutPanel.tsx",
      "mobile/src/app/flows/SettingsSheet.tsx",
    ];
    const version = readJson("package.json").version as string;
    // Any dotted numeric triple in the file that is NOT the define. Narrow on
    // purpose: a bare `0.1.0` is what the defect looked like, and a broad
    // "contains digits" rule would fire on every style value.
    const LOOKS_LIKE_A_VERSION = /(?<![\w.])\d+\.\d+\.\d+(?![\w.])/g;
    const offenders: string[] = [];
    for (const rel of SURFACES) {
      // Comments explain; only rendered code counts. Blocks are stripped
      // WHOLESALE rather than line-by-line, and that is a correction: a
      // line-prefix rule caught the first line of a `{/* … */}` block and let
      // its continuation lines through, so this test reported its own
      // explanatory comment — which names both `0.1.0` and `0.5.0` — as two
      // offenders. A finding a test invents about itself is worse than none.
      const source = readFileSync(join(REPO_ROOT, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const line of source.split("\n")) {
        for (const m of line.matchAll(LOOKS_LIKE_A_VERSION)) {
          offenders.push(`${rel}: ${m[0]} in ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(
      offenders,
      `an About surface carries a hardcoded version literal instead of reading ` +
        `\`__APP_VERSION__\` (the repo is at ${version}). Every declaration in the ` +
        `test above can agree perfectly while the screen the user actually reads ` +
        `says something else.`,
    ).toEqual([]);
  });

  it("the comparison would notice a disagreement", () => {
    // Verifies the comparison rather than trusting an empty result. A parser
    // that returned the same constant for every file would pass the test above
    // no matter what the files said.
    const fake = [
      { where: "a", drives: "x", version: "1.2.3" },
      { where: "b", drives: "y", version: "1.2.4" },
    ];
    expect(fake.filter((d) => d.version !== fake[0]!.version)).toHaveLength(1);
    // …and the Cargo parser really reads the PACKAGE version, not the first
    // `version = ` it sees (every manifest here has dependency versions below).
    expect(cargoVersion("src-tauri/Cargo.toml")).toBe(
      readJson("package.json").version as string,
    );
  });
});
