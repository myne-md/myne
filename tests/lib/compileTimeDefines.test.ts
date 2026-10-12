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
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
 * Two families, each earning the exemption the same way: the HOST injects it
 * onto `window` at runtime rather than Vite substituting it at build time, so a
 * config that "defined" it would be freezing a per-window runtime answer into
 * every bundle.
 *
 * 1. `__TAURI*` (`__TAURI_INTERNALS__`) is what the Tauri WebView puts on
 *    `window`, and reading it is how a client asks "am I running inside Tauri at
 *    all". A build that "defined" it would be answering that question at compile
 *    time, which is the opposite of what the probe is for. Root `AGENTS.md`
 *    names the same two files as the platform-seam guard's only runtime-global
 *    exemptions, for the same reason.
 * 2. `__MYNE_DETACHED*` (`__MYNE_DETACHED__`, `__MYNE_DETACHED_NOTE_ID__`) is
 *    what the desktop host stamps onto a detached (pop-out) note window via
 *    `detached_window_open`'s WebView init script (myne-md/myne#678, epic #173).
 *    The main window and the pop-out run the SAME bundle; the only thing that
 *    tells them apart is this per-window injection, so it is a runtime value by
 *    construction and never a compile-time one. `src/lib/detachedWindow.ts`
 *    reads it as `window.__MYNE_DETACHED__` (a property access, which answers
 *    `undefined` off a detached window rather than throwing), and it is
 *    UPPERCASE so `check-web-no-test-hooks.mjs`'s lowercase `__myne*` scan never
 *    matches it.
 *
 * Deliberately PREFIXES rather than a wildcard: a new `__SOMETHING__` that no
 * config defines is the failure this file exists to catch, and an exemption
 * list that grew by pattern would swallow it. `__MYNE_DETACHED` is the exact
 * detached-window family and nothing wider, so a future `__MYNE_*` compile-time
 * define bug still fails here.
 */
const RUNTIME_GLOBALS = (name: string) =>
  name.startsWith("__TAURI") || name.startsWith("__MYNE_DETACHED");

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

/**
 * Read a file that a WALK of a live tree named, tolerating one that vanished.
 *
 * **The tree is not static while the suite runs, and this is a flake rather
 * than a finding.** `walk()` lists a directory and reads each path it found, and
 * a sibling test file injects a scratch source into `src/` and deletes it again
 * (`tests/scripts/manualTestRosterCli.test.ts` writes and removes
 * `src/screens/ZzRecordProbe.tsx`, and did the same under the earlier name
 * `ZzGuardProbe.tsx`). ENOENT between the readdir and the open is that scratch
 * file's lifecycle: it passes alone, it passes on re-run, and it reddened a full
 * run twice in one session, both times on this spec, both times with
 * `manualTestRosterCli` running in parallel.
 *
 * **One errno wide, deliberately.** Only a vanished file is skipped; any other
 * read error still fails the spec, because the alternative, swallowing every
 * failure, is how a walk quietly stops covering what it claims to.
 *
 * Exported for its own spec: the tolerance is the whole point of the helper, and
 * a race that only appears under parallel load cannot be driven any other way.
 */
export function readWalked(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    // Structural cast, not `NodeJS.ErrnoException`: this tree has no
    // @types/node, so the namespace does not resolve here (the shape
    // e2e/support/xwindow.ts uses for the same reason).
    if ((err as { code?: unknown }).code === "ENOENT") return null;
    throw err;
  }
}

/** The defines referenced across `trees`, ignoring the ones that appear only
 *  inside a comment — a `//` or a doc block naming one is documentation, and
 *  three of this repo's configs explain themselves that way. */
function referencedIn(trees: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const tree of trees) {
    for (const file of walk(join(REPO_ROOT, tree))) {
      const source = readWalked(file);
      if (source === null) continue;
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
      // Through `readWalked`, not `readFileSync`: this is the second walk over
      // the same live tree, and it is the one that reddened, a scratch file
      // deleted between the readdir and the open is not a defines finding.
      const source = readWalked(file);
      if (source === null) continue;
      for (const m of source.matchAll(DEFINE_RE)) raw.add(m[1]!);
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

  describe("a walk of a live tree tolerates a file that vanished under it", () => {
    // **The race that reddened a full run twice in one session.** Sibling test
    // files inject scratch sources into `src/` and delete them again
    // (`tests/scripts/manualTestRosterCli.test.ts` writes and removes
    // `src/screens/ZzRecordProbe.tsx`), and this spec walks that tree. The
    // window is the readdir-to-open gap, so it cannot be driven from the
    // outside; what can be driven is the tolerance itself.
    it("returns null for a file that is gone", () => {
      const dir: string = mkdtempSync(join(tmpdir(), "myne-defines-"));
      try {
        const file = join(dir, "ZzScratch.tsx");
        writeFileSync(file, "export const x = __TAURI_INTERNALS__;\n");
        // Present, then gone, exactly what the parallel spec does.
        expect(readWalked(file)).toContain("__TAURI_INTERNALS__");
        rmSync(file);
        expect(readWalked(file)).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("no walk reads around the tolerant helper", () => {
      // **The half a behavioural test cannot reach.** Both walks are one call
      // apart from the helper, and a revert to `readFileSync` at either would
      // make the tolerance decorative, while staying green, because the race it
      // guards is a flake. So the file is scanned for the shape instead: exactly
      // ONE `readFileSync(file` in this module, and it is the helper's own. The
      // other reads here take a CONFIG path, not a walked one.
      const self: string = readFileSync(fileURLToPath(import.meta.url), "utf8");
      expect(
        // `file` followed by a comma or a close, so this test's own
        // `readFileSync(fileURLToPath(…))` and the prose above it do not count.
        self.match(/readFileSync\(file[,)]/g)?.length ?? 0,
        "a walk reads around `readWalked`, so a scratch file deleted mid-walk " +
          "reddens a full run again, pass the path through the helper instead",
      ).toBe(1);
    });

    it("still fails a read error that is not a vanished file", () => {
      // One errno wide, and this is the half that keeps the tolerance from
      // becoming a walk that silently covers less than it claims: reading a
      // DIRECTORY is EISDIR, and it must throw rather than skip.
      const dir: string = mkdtempSync(join(tmpdir(), "myne-defines-"));
      try {
        expect(() => readWalked(dir)).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
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
