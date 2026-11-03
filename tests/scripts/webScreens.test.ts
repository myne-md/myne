import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = new URL("../..", import.meta.url).pathname;
const GUARD = join(ROOT, "scripts", "check-web-screens.mjs");
const SURFACES_GUARD = join(ROOT, "scripts", "check-web-surfaces.mjs");

let scratch: string | null = null;

afterEach(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/**
 * Run a guard in `cwd` and return its exit code and output.
 *
 * **A spawn failure is not a verdict, and the difference is the whole point.**
 * `execFileSync` throws a `SystemError` carrying no `status`, `stdout` or
 * `stderr` when the CHILD could not be started at all (EAGAIN on a loaded
 * machine, where this file failed roughly one full suite in three with
 * `expected undefined to be 0` and nothing else to read). A guard's own refusal
 * always carries a numeric `status`, so only the spawn case is retried, once, and
 * a persistent one is raised as itself rather than folded into an exit code.
 */
function runGuard(guard: string, cwd: string): { code: number; output: string } {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { code: 0, output: execFileSync("node", [guard], { cwd, encoding: "utf8" }) };
    } catch (error) {
      const failure = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
        code?: string;
      };
      if (typeof failure.status === "number") {
        return { code: failure.status, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
      }
      if (attempt === 1) {
        throw new Error(`the guard could not be spawned: ${failure.code ?? String(error)}`);
      }
    }
  }
  throw new Error("unreachable");
}

function run(
  bundleText = "const bundled = true;",
  extraScreen = false,
): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "web-screens-"));
  scratch = dir;
  cpSync(join(ROOT, "src", "screens"), join(dir, "src", "screens"), { recursive: true });
  if (extraScreen) {
    writeFileSync(join(dir, "src", "screens", "ZzGuardProbe.tsx"), "export const Probe = true;\n");
  }
  mkdirSync(join(dir, "web", "dist"), { recursive: true });
  writeFileSync(join(dir, "web", "dist", "index.html"), "<!doctype html>", "utf8");
  writeFileSync(join(dir, "web", "dist", "app.js"), bundleText, "utf8");
  return runGuard(GUARD, dir);
}

function runSurfaces(bundleText: string): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "web-surfaces-"));
  scratch = dir;
  cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "web", "dist"), { recursive: true });
  writeFileSync(join(dir, "web", "dist", "index.html"), "<!doctype html>", "utf8");
  writeFileSync(join(dir, "web", "dist", "app.js"), bundleText, "utf8");
  return runGuard(SURFACES_GUARD, dir);
}

describe("check-web-screens", () => {
  it("catches an excluded screen's marker in the bundle", () => {
    // The needle has to come from an entry that is STILL `excluded`, and this
    // line has been updated twice for the same reason: a replacement that is no
    // longer excluded makes the guard's absence arm unfalsifiable while the test
    // stays green for the wrong reason. `IdentityHome` left `excluded` when
    // `decisions.md` 2026-10-18 (entry 0704) let it ship; `VaultPicker` left it
    // with myne-md/myne#911 task 13, because one origin can hold several
    // containers and the shared screen now ships. `RestoreBackup` is excluded by
    // decision (`decisions.md` 2026-07-26) and still carries a marker nothing
    // else in the tree emits.
    const result = run('const marker = "restore.pick-file";');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("restore.pick-file");
  });

  it("catches a screen with no roster verdict", () => {
    const result = run("const bundled = true;", true);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("ZzGuardProbe.tsx");
  });

  it("passes when the roster and bundle agree", () => {
    const result = run();
    expect(result.code).toBe(0);
    expect(result.output).toContain("ok");
  });
});

describe("check-web-surfaces", () => {
  /**
   * An unrecognised verdict used to count in NONE of the totals and leave the
   * run green: every figure in the exit line is a filter on the verdict string,
   * so a typo dropped the file out of the arithmetic instead of failing. Found
   * by injecting exactly that into this guard's own StoragePanel entry while
   * myne-md/myne#960 edited it, and the run printed `ok` with 12 excluded
   * instead of 13.
   *
   * The map is injected rather than written into the guard, because the roster
   * is what a future edit gets wrong and the check has to read it.
   *
   * The injection SPREADS the roster instead of naming two of its rows, and that
   * is the fix for a real failure rather than tidiness. It used to carry
   * `src/lib/shipped.ts` as its clean half; `0898f7cf5` removed that screen from
   * the roster, so the literal named a row that no longer existed and the test
   * stopped typechecking while asserting nothing at all about the guard. A
   * fixture that pins a roster row is a fixture that goes red when the roster
   * changes for a good reason, so the clean half is now the roster itself.
   */
  it("names a verdict outside the vocabulary", async () => {
    const { verdictGaps, SURFACE_VERDICTS, VERDICTS } = await import(
      "../../scripts/check-web-surfaces.mjs"
    );
    expect(verdictGaps()).toEqual([]);
    expect(
      verdictGaps({
        ...VERDICTS,
        "src/components/settings/StoragePanel.tsx": ["nonsense-verdict", "reason"],
      }),
    ).toEqual(["src/components/settings/StoragePanel.tsx"]);
    // The closed list itself, so a verdict added to a future entry without a
    // word here fails rather than being tolerated by the guard it extends.
    expect([...SURFACE_VERDICTS].sort()).toEqual([
      "adapted",
      "excluded",
      "ported",
      "typed-unsupported",
    ]);
  });

  it("catches the person-account absence marker", () => {
    const result = runSurfaces('const marker = "person-account-binding";');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("person-account-binding");
  });

  it("passes when the excluded person-account module is absent", () => {
    const result = runSurfaces("const marker = 'ordinary-bundle-text';");
    expect(result.code).toBe(0);
    expect(result.output).toContain("ok");
  });
});
