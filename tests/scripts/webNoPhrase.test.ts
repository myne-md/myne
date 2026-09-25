import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = new URL("../..", import.meta.url).pathname;
const GUARD = join(ROOT, "scripts", "check-web-no-phrase.mjs");

let scratch: string | null = null;

afterEach(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

function run(contents: string): { code: number; output: string } {
  scratch = mkdtempSync(join(tmpdir(), "web-no-phrase-"));
  mkdirSync(join(scratch, "web", "dist"), { recursive: true });
  writeFileSync(join(scratch, "web", "dist", "app.js"), contents, "utf8");
  try {
    const output = execFileSync("node", [GUARD], { cwd: scratch, encoding: "utf8" });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { code: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

describe("check-web-no-phrase", () => {
  it("catches the identity-home marker", () => {
    const result = run('const marker = "identity-home.accept-phrase";');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("identity-home.accept-phrase");
  });

  it("catches the member-vault unlock marker", () => {
    const result = run('const marker = "unlock.member-phrase";');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("unlock.member-phrase");
  });

  it("still catches the pre-existing member-roster marker", () => {
    const result = run('const marker = "member-roster.phrase-input";');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("member-roster.phrase-input");
  });

  it("catches the identity-setup marker", () => {
    const result = run('const marker = "identity-setup.phrase-input";');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("identity-setup.phrase-input");
  });

  it("catches the migration marker", () => {
    const result = run('const marker = "migrate.phrase-input";');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("migrate.phrase-input");
  });

  it("passes when no marker is present", () => {
    const result = run("const marker = 'ordinary-bundle-text';");
    expect(result.code).toBe(0);
    expect(result.output).toContain("ok");
  });
});
