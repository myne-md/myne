// End-to-end injection tests for the two guards myne-md/myne#529 added.
//
// `agentGuards.test.ts` already breaks their PARSING helpers in both
// directions. What it cannot reach is the layer above: the caller decision, the
// ratchet's three verdicts, and the cross product of leaving paths against
// teardown calls. Those are where each guard's real defects lived, and they were
// only ever verified by mutating the working tree and restoring it by hand,
// which is evidence that expires the moment somebody forgets the restore.
//
// `deadBindings`, `ratchet` and `analyse` take their whole world as an argument
// for exactly this reason, the shape `check-mobile-export-backup.mjs` uses. Each
// case below is a synthetic file set, so every one runs on every commit and none
// of them can leave a half-restored checkout behind.

import { describe, expect, it } from "vitest";

import { deadBindings, ratchet } from "../../scripts/check-ipc-binding-callers.mjs";
import {
  LEAVING_PATHS,
  TEARDOWN_CALLS,
  analyse,
} from "../../scripts/check-frontend-lock-teardown.mjs";

const BINDING = `
import { invoke } from "@tauri-apps/api/core";

export async function agentCapability(): Promise<Capability> {
  return invoke<Capability>("plugin:agent|agent_capability");
}

export async function agentStart(task: string): Promise<AgentStepResult> {
  return invoke<AgentStepResult>("plugin:agent|agent_start", { task });
}
`;

describe("check-ipc-binding-callers: the caller decision", () => {
  it("passes when every binding has a caller in another module", () => {
    const { dead, checked } = deadBindings({
      bindings: new Map([["src/lib/agent-run.ts", BINDING]]),
      callers: new Map([
        ["src/lib/agent-run.ts", BINDING],
        [
          "src/notes/agent/Composer.tsx",
          `import { agentCapability, agentStart } from "../../lib/agent-run";
const v = await agentCapability();
await agentStart(task);`,
        ],
      ]),
    });
    expect(checked).toBe(2);
    expect(dead).toEqual([]);
  });

  it("names the binding whose only caller was deleted", () => {
    // The motivating defect: `agentCapability` shipped with no caller, so agent
    // mode was offered on every backend while two module docs said the probe
    // gate was the reason a near-miss may be refused.
    const { dead } = deadBindings({
      bindings: new Map([["src/lib/agent-run.ts", BINDING]]),
      callers: new Map([
        ["src/lib/agent-run.ts", BINDING],
        ["src/notes/agent/Composer.tsx", `await agentStart(task);`],
      ]),
    });
    expect(dead).toEqual(["src/lib/agent-run.ts:agentCapability"]);
  });

  it("does not accept an IMPORT as a caller", () => {
    // The direction the guard's own header records as the one nobody tries. The
    // first version matched the name anywhere in the file, so deleting the sole
    // CALL while leaving the import reported ok.
    const { dead } = deadBindings({
      bindings: new Map([["src/lib/agent-run.ts", BINDING]]),
      callers: new Map([
        ["src/lib/agent-run.ts", BINDING],
        [
          "src/notes/agent/Composer.tsx",
          `import { agentCapability, agentStart } from "../../lib/agent-run";
await agentStart(task);`,
        ],
      ]),
    });
    expect(dead).toEqual(["src/lib/agent-run.ts:agentCapability"]);
  });

  it("does not accept a RE-EXPORT as a caller", () => {
    const { dead } = deadBindings({
      bindings: new Map([["src/lib/agent-run.ts", BINDING]]),
      callers: new Map([
        ["src/lib/agent-run.ts", BINDING],
        ["src/lib/index.ts", `export { agentCapability } from "./agent-run";`],
        ["src/notes/agent/Composer.tsx", `await agentStart(task);`],
      ]),
    });
    expect(dead).toEqual(["src/lib/agent-run.ts:agentCapability"]);
  });

  it("does not let a module call ITSELF into liveness", () => {
    // The identity check is keyed on the map key, so a key mismatch between the
    // two maps (absolute against relative) would silently make every binding
    // look called by its own declaring file. That is a false GREEN, which is the
    // worse direction, and no other assertion here would catch it.
    const { dead } = deadBindings({
      bindings: new Map([["src/lib/agent-run.ts", `${BINDING}\nawait agentCapability();\n`]]),
      callers: new Map([["src/lib/agent-run.ts", `${BINDING}\nawait agentCapability();\n`]]),
    });
    expect(dead).toEqual([
      "src/lib/agent-run.ts:agentCapability",
      "src/lib/agent-run.ts:agentStart",
    ]);
  });
});

describe("check-ipc-binding-callers: the ratchet", () => {
  const reason = "Reserved for the CLI client, which does not exist yet.";

  it("passes when every dead binding is recorded with a reason", () => {
    const v = ratchet(["a.ts:x"], { "a.ts:x": reason });
    expect(v).toEqual({ news: [], unreasoned: [], stale: [] });
  });

  it("names a dead binding that is not recorded", () => {
    const v = ratchet(["a.ts:x", "b.ts:y"], { "a.ts:x": reason });
    expect(v.news).toEqual(["b.ts:y"]);
  });

  it("rejects a recorded exemption carrying no reason", () => {
    // An entry without one is indistinguishable from a defect somebody recorded
    // instead of fixing, which is what the list exists to prevent.
    const v = ratchet(["a.ts:x", "b.ts:y"], { "a.ts:x": reason, "b.ts:y": "TODO" });
    expect(v.unreasoned).toEqual(["b.ts:y"]);
    // And it is not ALSO reported as new: the two verdicts are independent, so a
    // reader is told the one thing that is wrong rather than two.
    expect(v.news).toEqual([]);
  });

  it("names an exemption whose binding has since acquired a caller", () => {
    // The ratchet's other direction. Without it the record decays into licences
    // nobody re-argued, and the guard reports ok about a tree it no longer
    // describes.
    const v = ratchet([], { "a.ts:x": reason });
    expect(v.stale).toEqual(["a.ts:x"]);
  });
});

/** A file set that satisfies both real rosters, as the baseline each case mutates. */
function healthyFiles(): Record<string, string> {
  return {
    "src/notes/agent/agentStore.ts": `export function clearAgentForLock(): void {}\n`,
    "editor/src/decorations/spell.ts": `export function resetSessionIgnored(): void {}\n`,
    "src/lib/vault-unlock.ts": `export async function lockVault(): Promise<void> {
  clearAgentForLock();
  await invoke("plugin:vault_unlock|vault_lock");
}
`,
    "src/lib/vault-switch.ts": `export async function leaveActiveVault(deps: {
  reason: string;
}): Promise<void> {
  clearAgentForLock();
  resetSessionIgnored();
  await lockVault();
}
`,
  };
}

function run(files: Record<string, string>): string[] {
  return analyse({ files, leavingPaths: LEAVING_PATHS, teardownCalls: TEARDOWN_CALLS });
}

describe("check-frontend-lock-teardown: the cross product", () => {
  it("passes on a file set that satisfies both rosters", () => {
    expect(run(healthyFiles())).toEqual([]);
  });

  it("names the exact myne#529 defect: the switch path skipping the clear", () => {
    // `clearAgentForLock` was written, documented as "the lock and vault-switch
    // variant", wired to the Editor lock paths and NOT to `leaveActiveVault`.
    const files = healthyFiles();
    files["src/lib/vault-switch.ts"] = files["src/lib/vault-switch.ts"].replace(
      "  clearAgentForLock();\n",
      "",
    );
    const errors = run(files);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("leaveActiveVault does not call clearAgentForLock()");
  });

  it("names the choke point skipping the clear", () => {
    const files = healthyFiles();
    files["src/lib/vault-unlock.ts"] = files["src/lib/vault-unlock.ts"].replace(
      "  clearAgentForLock();\n",
      "",
    );
    const errors = run(files);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("lockVault does not call clearAgentForLock()");
  });

  it("does not demand a call the roster reasons its way out of", () => {
    // The other direction, and the one the first version of this guard got
    // wrong: `resetSessionIgnored` is asserted on the switch only, because a
    // plain lock legitimately keeps the session's ignored words. A guard that
    // flattened this would teach the reader to add a call whose own comment
    // argues against it.
    expect(healthyFiles()["src/lib/vault-unlock.ts"]).not.toContain("resetSessionIgnored");
    expect(run(healthyFiles())).toEqual([]);
  });

  it("fails when a roster entry's file has vanished", () => {
    const files = healthyFiles();
    delete files["editor/src/decorations/spell.ts"];
    expect(run(files)).toEqual([
      "editor/src/decorations/spell.ts does not exist (roster is stale)",
    ]);
  });

  it("fails when a rostered teardown is no longer exported under that name", () => {
    // A rename otherwise leaves the guard asserting a call nobody makes, against
    // a declaration nobody has, and reporting ok about both.
    const files = healthyFiles();
    files["src/notes/agent/agentStore.ts"] = `export function clearAgentOnLock(): void {}\n`;
    expect(run(files)).toContain(
      "src/notes/agent/agentStore.ts no longer exports clearAgentForLock (roster is stale)",
    );
  });

  it("fails when a rostered leaving path no longer declares its function", () => {
    const files = healthyFiles();
    files["src/lib/vault-switch.ts"] = `export async function leaveVault(): Promise<void> {}\n`;
    expect(run(files)).toContain(
      "src/lib/vault-switch.ts no longer declares leaveActiveVault (roster is stale)",
    );
  });

  it("does not take a destructured parameter for the body", () => {
    // The first version read up to the next `}` at column 0, and
    // `leaveActiveVault`'s destructured parameter closes there, so the extracted
    // "body" was the SIGNATURE and every teardown call looked missing. Two false
    // failures on code that was already correct. The healthy fixture above keeps
    // that exact shape, so this asserts the fix rather than restating it.
    expect(healthyFiles()["src/lib/vault-switch.ts"]).toContain("deps: {\n  reason: string;\n}");
    expect(run(healthyFiles())).toEqual([]);
  });

  it("reports rather than guesses when the body cannot be extracted", () => {
    // A source whose braces do not balance is the reachable half of the
    // over-capture concern: the walk runs off the end and returns null, and the
    // guard says so instead of silently asserting nothing.
    //
    // The guard's OTHER arm, "the extracted body spans another function", is
    // deliberately not asserted here, because with the current `bodyOf` it is
    // unreachable: the walk is brace-balanced, so running past one function's
    // end costs a net extra `{` from a string literal AND a matching surplus
    // `}` later in the file, and every balanced sibling contributes zero. It is
    // kept as a belt-and-braces check against a future rewrite of `bodyOf` back
    // to a line-based scan, which is the version that had the defect. Writing a
    // test that claimed to exercise it would be claiming more than the input can
    // prove.
    const files = healthyFiles();
    files["src/lib/vault-unlock.ts"] = `export async function lockVault(): Promise<void> {
  await invoke("plugin:vault_unlock|vault_lock");
`;
    expect(run(files)).toEqual([
      "could not extract lockVault's body in src/lib/vault-unlock.ts",
    ]);
  });

  it("rejects a skip that gives no reason", () => {
    const errors = analyse({
      files: healthyFiles(),
      leavingPaths: LEAVING_PATHS,
      teardownCalls: [
        {
          call: "resetSessionIgnored",
          declaredIn: "editor/src/decorations/spell.ts",
          holds: "the session's ignored-word set",
          appliesTo: ["leaveActiveVault"],
          skips: { lockVault: "not needed" },
        },
      ],
    });
    expect(errors).toEqual([
      "resetSessionIgnored does not apply to lockVault and gives no reason",
    ]);
  });
});
