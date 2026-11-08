// The runTool helper's own spec (myne-md/myne#528).
//
// Six of nine scripts that shell out used to swallow "the tool could not run"
// into a bare catch, and the one diagnostic rule the surviving good examples
// shared was invisible to anyone who copied the wrong one: `pnpm` and `tsc`
// both write their diagnostics to STDOUT and leave stderr empty, so a helper
// that only surfaced stderr would be a new version of the same bug. That case
// is the one this file injects first.
//
// The other two properties under test are the forcing mechanisms themselves:
// a call site that omits `onToolFailure` must not run at all, and an "empty"
// verdict without a written reason must not run either. Those are the locks
// that stop the next bare catch, and a lock that can be skipped is not one.
//
// The spawner is injected rather than spawned: the failure arms are the arms
// that matter, and exercising them against real tools means exercising them
// against tools that succeed (myne#515's shape — the gate's failure paths had
// no spec because nothing could make pnpm fail on demand).
import { describe, expect, it, vi } from "vitest";

import { ToolRunError, formatDiagnostic, runTool } from "../../scripts/lib/run-tool.mjs";

/** A spawn result shaped like child_process's, for driving the helpers'
 *  classification directly without spawning anything. */
function stub(overrides: Partial<{ status: number | null; error: Error | undefined; stdout: string; stderr: string }>) {
  return {
    status: 0,
    error: undefined,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

const spawner = (result: ReturnType<typeof stub>) => vi.fn().mockReturnValueOnce(result);

describe("runTool: the forcing lock", () => {
  it("refuses to run without an explicit onToolFailure verdict", () => {
    // The whole point of the helper (myne#528): silence is not a default.
    // @ts-expect-error: the omission IS the test — the type requires the
    // verdict precisely so skipping it fails loudly at runtime instead.
    expect(() => runTool(["true"], {})).toThrow(/onToolFailure is REQUIRED/);
  });

  it("refuses a bogus verdict value", () => {
    // @ts-expect-error: the bogus value IS the test — the union type exists
    // precisely so a typo fails here instead of at runtime.
    expect(() => runTool(["true"], { onToolFailure: "whatever" })).toThrow(/onToolFailure is REQUIRED/);
  });

  it('refuses an "empty" verdict with no written reason', () => {
    // An unnamed tolerance is the bare catch wearing a new name.
    expect(() => runTool(["true"], { onToolFailure: "empty" })).toThrow(/requires a written reason/);
  });
});

describe("runTool: a tool that fails on STDOUT only", () => {
  // pnpm and tsc both report on stdout and leave stderr empty. A helper that
  // only surfaced stderr would print "(nothing)" for exactly the failures it
  // exists to name — myne#515's literal shape.
  it("a fatal failure throws and names the stdout diagnosis", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        runTool(["pnpm", "licenses", "list", "--json"], {
          onToolFailure: "fatal",
          spawner: spawner(stub({ status: 1, stdout: "ERR_PNPM_MISSING_PACKAGE_INDEX_FILE" })),
        }),
      ).toThrow(ToolRunError);
      const printed = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(printed).toContain("ERR_PNPM_MISSING_PACKAGE_INDEX_FILE");
    } finally {
      errSpy.mockRestore();
    }
  });

  it('an "empty" verdict returns null but still prints the diagnostics', () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = runTool(["git", "show", "HEAD:gone.md"], {
        onToolFailure: "empty",
        reason: "the record has a first commit",
        spawner: spawner(stub({ status: 128, stderr: "fatal: path 'gone.md' does not exist" })),
      });
      expect(r).toBeNull();
      const printed = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(printed).toContain("tolerated as an empty result: the record has a first commit");
      expect(printed).toContain("fatal: path 'gone.md' does not exist");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a tool that ran and found nothing (exit 0) is not a tool failure", () => {
    const r = runTool(["git", "diff", "--name-only", "HEAD"], {
      onToolFailure: "fatal",
      spawner: spawner(stub({ status: 0, stdout: "" })),
    });
    expect(r?.status).toBe(0);
    expect(r?.stdout).toBe("");
  });
});

describe("formatDiagnostic", () => {
  it("carries both streams, the argv, the exit and the cwd", () => {
    const text = formatDiagnostic({
      argv: ["git", "show", "HEAD:agent-tooling/docs/x.md"],
      status: 128,
      stdout: "",
      stderr: "fatal: path 'agent-tooling/docs/x.md' does not exist",
      cwd: "/repo",
      reason: "the record has a first commit",
    });
    // Both streams unconditionally: pnpm/tsc report on stdout, git on stderr.
    expect(text).toContain('stdout: ""');
    expect(text).toContain("fatal: path 'agent-tooling/docs/x.md' does not exist");
    expect(text).toContain("git show HEAD:agent-tooling/docs/x.md");
    expect(text).toContain("exit: 128");
    expect(text).toContain("cwd: /repo");
    expect(text).toContain("tolerated as an empty result");
  });

  it("says when the tool could not spawn at all", () => {
    const text = formatDiagnostic({
      argv: ["definitely-not-a-tool", "--v"],
      status: null,
      stdout: "",
      stderr: "",
      cwd: "/repo",
    });
    expect(text).toContain("(killed / could not spawn)");
  });
});
