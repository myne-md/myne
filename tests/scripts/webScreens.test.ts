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

function run(
  bundleText = "const bundled = true;",
  extraScreen = false,
): { code: number; output: string } {
  scratch = mkdtempSync(join(tmpdir(), "web-screens-"));
  cpSync(join(ROOT, "src", "screens"), join(scratch, "src", "screens"), { recursive: true });
  if (extraScreen) {
    writeFileSync(join(scratch, "src", "screens", "ZzGuardProbe.tsx"), "export const Probe = true;\n");
  }
  mkdirSync(join(scratch, "web", "dist"), { recursive: true });
  writeFileSync(join(scratch, "web", "dist", "index.html"), "<!doctype html>", "utf8");
  writeFileSync(join(scratch, "web", "dist", "app.js"), bundleText, "utf8");
  try {
    const output = execFileSync("node", [GUARD], { cwd: scratch, encoding: "utf8" });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { code: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

function runSurfaces(bundleText: string): { code: number; output: string } {
  scratch = mkdtempSync(join(tmpdir(), "web-surfaces-"));
  cpSync(join(ROOT, "src"), join(scratch, "src"), { recursive: true });
  mkdirSync(join(scratch, "web", "dist"), { recursive: true });
  writeFileSync(join(scratch, "web", "dist", "index.html"), "<!doctype html>", "utf8");
  writeFileSync(join(scratch, "web", "dist", "app.js"), bundleText, "utf8");
  try {
    const output = execFileSync("node", [SURFACES_GUARD], { cwd: scratch, encoding: "utf8" });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { code: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

describe("check-web-screens", () => {
  it("catches the IdentityHome exclusion marker in the bundle", () => {
    const result = run('const marker = "identity-home.identity-code";');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("identity-home.identity-code");
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
