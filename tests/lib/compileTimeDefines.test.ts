/**
 * Every compile-time define a tree READS is provided by every build that
 * compiles that tree — myne-md/myne#555, the `settings.panel.about` bullet
 * ("version/channel/commit are compile-time defines").
 *
 * # The failure, which has already been reasoned about once in a comment
 *
 * `__APP_VERSION__` and `__BUILD_COMMIT__` are not imports. They are textual
 * substitutions Vite performs at build time, and a reference to one the config
 * does not define survives typechecking (`src/vite-env.d.ts` declares them),
 * survives the build, and throws `ReferenceError: __BUILD_COMMIT__ is not
 * defined` the first time a user opens the surface that reads it.
 *
 * `web/vite.config.ts` already says so in prose, next to its own
 * `__APP_VERSION__` line: the shared tree reads it "unconditionally, so
 * omitting it here would break the" build. That comment is correct and it is a
 * comment — it protects `__APP_VERSION__`, in `web/`, for as long as someone
 * reads it. Three clients, four configs, and a new define is one line in one of
 * them.
 *
 * # Why it fails at the worst possible moment
 *
 * The surfaces that read these are About and diagnostics: the screens a user
 * opens when something has ALREADY gone wrong and they are trying to report it.
 * A `ReferenceError` there takes out the panel that would have told them which
 * build they are on.
 *
 * # What is compared
 *
 * Each build's `define` block against the identifiers actually referenced in
 * the trees that build compiles. The tree sets are not the same and that is the
 * whole point: the desktop and web bundles compile `src/`, while **mobile does
 * not** — it has its own `mobile/src` and source-consumes the shared packages
 * (`editor/`, `dialect/`, `copy/`, `ornaments/`) through aliases. So mobile
 * legitimately defines fewer, and a rule that demanded parity across all four
 * would be wrong rather than strict.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const REPO_ROOT = process.cwd();

/** Every `__NAME__` identifier referenced in a source file. */
const DEFINE_RE = /\b(__[A-Z][A-Z0-9_]*__)\b/g;

/** Files whose mention of a define is prose or a declaration, not a read. */
const NOT_A_READ = new Set(["vite-env.d.ts"]);

/**
 * Identifiers in `__NAME__` shape that are NOT compile-time defines, so no
 * config is expected to supply them.
 *
 * Exactly one family, and it earns the exemption by being injected by the HOST
 * at runtime rather than substituted at build time: `__TAURI_INTERNALS__` is
 * what the Tauri WebView puts on `window`, and reading it is how a client asks
 * "am I running inside Tauri at all". A build that "defined" it would be
 * answering that question at compile time, which is the opposite of what the
 * probe is for. Root `CLAUDE.md` names the same two files as the platform-seam
 * guard's only runtime-global exemptions, for the same reason.
 *
 * Deliberately a PREFIX rather than a wildcard: a new `__SOMETHING__` that no
 * config defines is the failure this file exists to catch, and an exemption
 * list that grew by pattern would swallow it.
 */
const RUNTIME_GLOBALS = (name: string) => name.startsWith("__TAURI");

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if ([".ts", ".tsx"].includes(extname(name)) && !NOT_A_READ.has(name)) out.push(full);
  }
  return out;
}

/** The defines referenced across `trees`, ignoring the ones that appear only
 *  inside a comment — a `//` or a doc block naming one is documentation, and
 *  three of this repo's configs explain themselves that way. */
function referencedIn(trees: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const tree of trees) {
    for (const file of walk(join(REPO_ROOT, tree))) {
      // A walk of a LIVE tree races sibling tests that inject scratch files
      // into it (manualTestRosterCli.test.ts writes and deletes
      // src/screens/ZzGuardProbe.tsx). ENOENT between the readdir and the open
      // is that scratch file's lifecycle, not a defines finding; skip THIS
      // file only, and any file whose read fails for another reason still
      // fails the spec. Observed once as a full-suite red in pre-push (myne#567's
      // load-shape: passes alone, passes on re-run).
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch (err) {
        // Structural cast, not `NodeJS.ErrnoException`: this tree has no
        // @types/node, so the namespace does not resolve here (the shape
        // e2e/support/xwindow.ts uses for the same reason).
        if ((err as { code?: unknown }).code === "ENOENT") continue;
        throw err;
      }
      for (const line of source.split("\n")) {
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
        for (const m of code.matchAll(DEFINE_RE)) {
          if (RUNTIME_GLOBALS(m[1]!)) continue;
          if (!found.has(m[1]!)) found.set(m[1]!, file.slice(REPO_ROOT.length + 1));
        }
      }
    }
  }
  return found;
}

/** The identifiers a Vite/Vitest config's `define` block supplies. */
function definedBy(configPath: string): Set<string> {
  const source = readFileSync(join(REPO_ROOT, configPath), "utf8");
  const out = new Set<string>();
  for (const m of source.matchAll(/^\s*(__[A-Z][A-Z0-9_]*__)\s*:/gm)) out.add(m[1]!);
  return out;
}

/**
 * Which build compiles which trees.
 *
 * `mobile` is deliberately short: it has its own React tree and source-consumes
 * the shared PACKAGES, not `src/`. Adding `src` here would not make the check
 * stricter, it would make it wrong.
 */
const BUILDS = [
  {
    name: "desktop",
    config: "vite.config.ts",
    trees: ["src", "editor/src", "dialect/src", "copy/src", "ornaments/src"],
  },
  {
    name: "web",
    config: "web/vite.config.ts",
    trees: ["web/src", "src", "editor/src", "dialect/src", "copy/src", "ornaments/src"],
  },
  {
    name: "mobile",
    config: "mobile/vite.config.ts",
    trees: ["mobile/src", "editor/src", "dialect/src", "copy/src", "ornaments/src"],
  },
  {
    // The one config that compiles everything under test, so a define missing
    // here is a `ReferenceError` in whichever suite touches it.
    name: "vitest",
    config: "vitest.config.ts",
    trees: ["src", "web/src", "editor/src", "dialect/src", "copy/src", "ornaments/src"],
  },
] as const;

describe("compile-time defines are provided by every build that needs them", () => {
  it("finds defines to check at all", () => {
    // Non-vacuity: a regex that matched nothing would make every assertion
    // below hold over an empty set.
    const desktop = referencedIn(BUILDS[0].trees);
    expect([...desktop.keys()]).toContain("__APP_VERSION__");
    expect([...desktop.keys()]).toContain("__BUILD_COMMIT__");
    expect(definedBy("vite.config.ts").size).toBeGreaterThan(0);
  });

  it("the runtime-global exemption is narrow, and really is exempt", () => {
    // Two directions. The identifier IS present in the tree (so the exemption
    // is doing something rather than describing a case that no longer exists),
    // and NO config defines it (so exempting it is correct rather than hiding a
    // config that should have it).
    const raw = new Set<string>();
    for (const file of walk(join(REPO_ROOT, "src"))) {
      for (const m of readFileSync(file, "utf8").matchAll(DEFINE_RE)) raw.add(m[1]!);
    }
    expect(
      [...raw].filter(RUNTIME_GLOBALS),
      "nothing matching __TAURI* is read in src/ any more — the exemption now " +
        "describes a case that does not exist, and should go rather than sit " +
        "there licensing a future name",
    ).not.toEqual([]);
    for (const build of BUILDS) {
      expect(
        [...definedBy(build.config)].filter(RUNTIME_GLOBALS),
        `${build.config} DEFINES a __TAURI* identifier. That answers "am I running ` +
          `inside Tauri" at compile time, which is the opposite of what the boot ` +
          `probe is for — and it means the exemption above is now hiding a real ` +
          `config entry.`,
      ).toEqual([]);
    }
  });

  it.each(BUILDS)("$name defines everything its trees read", (build) => {
    const referenced = referencedIn(build.trees);
    const defined = definedBy(build.config);
    const missing = [...referenced.entries()].filter(([name]) => !defined.has(name));
    expect(
      missing.map(([name, file]) => `${name} (read in ${file})`),
      `${build.config} does not define these, and the trees it compiles read them. ` +
        `A compile-time define is a textual substitution, so a missing one survives ` +
        `tsc (vite-env.d.ts declares it), survives the build, and throws ` +
        `"ReferenceError: <name> is not defined" the first time a user opens the ` +
        `surface that reads it — which for these is About and diagnostics, i.e. the ` +
        `screens somebody opens when something has already gone wrong.`,
    ).toEqual([]);
  });

  it("mobile really does compile a different tree set, so its shorter list is not laxity", () => {
    // The claim the BUILDS table rests on. If mobile started compiling `src/`
    // the table above would be wrong in the permissive direction, and this is
    // what would say so.
    const mobileConfig = readFileSync(join(REPO_ROOT, "mobile/vite.config.ts"), "utf8");
    expect(
      /find:\s*\/\^@myne\\\/editor/.test(mobileConfig) || mobileConfig.includes("@myne/editor"),
      "mobile/vite.config.ts no longer aliases the shared packages — check whether " +
        "it now compiles src/ too, which would make this file's tree table wrong",
    ).toBe(true);
    // `src/` is reached only through those aliases, never as a root.
    expect(
      referencedIn(["mobile/src"]).has("__BUILD_COMMIT__"),
      "mobile/src now reads __BUILD_COMMIT__, which mobile/vite.config.ts does not " +
        "define — the mobile About sheet would throw on open",
    ).toBe(false);
  });
});
