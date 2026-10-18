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
    // `IdentityHome` used to carry this needle and no longer does: it is `gated`
    // rather than `excluded` since `decisions.md` 2026-10-18 (entry 0704), so it
    // ships and has no marker to leak. `VaultPicker` is the marker that proves
    // the arm still works, and the choice is deliberate rather than incidental —
    // a test that greps for a needle nothing declares passes for the wrong
    // reason.
    const result = run('const marker = "picker.vault-row";');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("picker.vault-row");
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
