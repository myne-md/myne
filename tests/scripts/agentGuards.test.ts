// Injection tests for the three guards myne-md/myne#529 added.
//
// Root `CLAUDE.md`: verifying a guard means BREAKING it, and a guard fix
// "verified" by a green tree is non-evidence, because a guard that has stopped
// checking is green by definition. Each guard's own header records that it was
// broken by hand once and what that found. A hand break proves nothing about
// the NEXT edit, which is what this file is for.
//
// Every case below injects a defect class the guard claims to catch and asserts
// the guard's own logic names it. Where a guard's prose records a specific
// self-inflicted blind spot, that exact shape is one of the cases, because it
// is the one already proven possible.

import { describe, expect, it } from "vitest";

import {
  bindingsInSource,
  withoutImports,
} from "../../scripts/check-ipc-binding-callers.mjs";
import { analyse, bodyOf } from "../../scripts/check-frontend-lock-teardown.mjs";
import {
  imageTags,
  lockedVersion,
} from "../../scripts/check-playwright-image.mjs";

describe("check-ipc-binding-callers", () => {
  it("finds an exported binding that invokes a plugin command", () => {
    const src = `
export async function agentStart(task: string) {
  return invoke<AgentStepResult>("plugin:agent|agent_start", { task });
}
`;
    expect(bindingsInSource(src)).toEqual(["agentStart"]);
  });

  it("does not call an ordinary exported function a binding", () => {
    // The other direction: without this the guard would demand callers for
    // every export in the file and its exemption list would grow to hide that.
    const src = `
export function keptEdits(agent: AgentState) {
  return agent.proposal.edits.filter((_, i) => !agent.rejected.has(i));
}
`;
    expect(bindingsInSource(src)).toEqual([]);
  });

  it("attributes each binding to its own body, not to the file", () => {
    // The scan slices between `export function` marks. A binding whose invoke
    // sits in the NEXT function would otherwise be credited to this one.
    const src = `
export function first() {
  return 1;
}
export async function second() {
  return invoke("plugin:agent|agent_cancel", {});
}
`;
    expect(bindingsInSource(src)).toEqual(["second"]);
  });

  // The guard's own recorded blind spot. Its header: "An import is not a call,
  // and matching one is how this guard passed while the thing it checks was
  // wrong." Removing the sole CALL while leaving the import must not read as a
  // caller, and that is the direction nobody thinks to try.
  it("strips imports, so an import alone is not a caller", () => {
    const text = `import { agentCapability } from "../../lib/agent-run";\n\nconst x = 1;\n`;
    expect(withoutImports(text)).not.toContain("agentCapability");
  });

  it("strips a type-only import and a bare side-effect import too", () => {
    const type = `import type { AgentRunView } from "../lib/agent-run";\n`;
    const bare = `import "./editor-host";\n`;
    expect(withoutImports(type).trim()).toBe("");
    expect(withoutImports(bare).trim()).toBe("");
  });

  it("leaves a real call site standing", () => {
    // Without this the guard could pass by stripping everything.
    const text = `import { agentCancel } from "../lib/agent-run";\n\nvoid agentCancel(runId);\n`;
    expect(withoutImports(text)).toContain("agentCancel(runId)");
  });
});

describe("check-frontend-lock-teardown", () => {
  // `bodyOf` is where this guard got it wrong TWICE while reporting ok, per its
  // own header: a `function` whose name is followed by a destructured parameter
  // list, and an arrow-assigned const. Both shapes are in this tree.
  it("takes the body of a plain function declaration", () => {
    const src = `export function lockVault() {\n  clearAgentForLock();\n}\n`;
    expect(bodyOf(src, src.indexOf("lockVault"))).toContain("clearAgentForLock");
  });

  it("does not run past the function into the next one", () => {
    const src = [
      "export function lockVault() {",
      "  dropKeys();",
      "}",
      "export function somethingElse() {",
      "  clearAgentForLock();",
      "}",
      "",
    ].join("\n");
    const body = bodyOf(src, src.indexOf("lockVault"));
    expect(body).toContain("dropKeys");
    expect(body).not.toContain("clearAgentForLock");
  });

  it("handles a destructured parameter list without stopping at its brace", () => {
    // The shape that broke it: the first `{` after the name belongs to the
    // PARAMETERS, not to the body, so a naive first-brace scan returns `{ a, b }`
    // and every assertion about the body silently passes on an empty string.
    const src = `export async function leaveActiveVault({ a, b }: Args) {\n  clearAgentForLock();\n}\n`;
    const body = bodyOf(src, src.indexOf("leaveActiveVault"));
    expect(body).toContain("clearAgentForLock");
  });

  it("handles an arrow-assigned function", () => {
    const src = `const handleLockFlushed = async () => {\n  clearAgentForLock();\n};\n`;
    const body = bodyOf(src, src.indexOf("handleLockFlushed"));
    expect(body).toContain("clearAgentForLock");
  });

  it("keeps nested braces inside the body", () => {
    const src = `export function lockVault() {\n  if (x) {\n    clearAgentForLock();\n  }\n}\n`;
    expect(bodyOf(src, src.indexOf("lockVault"))).toContain("clearAgentForLock");
  });

  // ---- the two-hop `via` rule (myne-md/myne#456) ---------------------------
  //
  // A path may reach a teardown through a named wrapper, and the guard then has
  // to check BOTH hops. Accepting the wrapper without the second hop would let
  // an EMPTY function satisfy this guard, which is the exact shape
  // `check-lock-teardown.mjs` exists to catch on the Rust side.

  const PATHS = [
    { id: "c:lock", file: "client/lock.ts", fn: "lockVault", why: "the choke point" },
  ];
  const WRAPPER = "client/lifetime.ts";
  const CALLS = [
    {
      call: "clearAgentForLock",
      declaredIn: "shared/store.ts",
      holds: "note-derived plaintext",
      appliesTo: ["c:lock"],
      skips: {},
      via: { "c:lock": { fn: "endAgentRun", file: WRAPPER } },
    },
  ];

  it("accepts a path that calls the declared wrapper", () => {
    const errors = analyse({
      files: {
        "client/lock.ts": "export function lockVault() {\n  endAgentRun('lock');\n}\n",
        [WRAPPER]: "export function endAgentRun() {\n  clearAgentForLock();\n}\n",
        "shared/store.ts": "export function clearAgentForLock() {}\n",
      },
      leavingPaths: PATHS,
      teardownCalls: CALLS,
    });
    expect(errors).toEqual([]);
  });

  it("rejects a path that calls neither the wrapper nor the teardown", () => {
    const errors = analyse({
      files: {
        "client/lock.ts": "export function lockVault() {\n  dropKeys();\n}\n",
        [WRAPPER]: "export function endAgentRun() {\n  clearAgentForLock();\n}\n",
        "shared/store.ts": "export function clearAgentForLock() {}\n",
      },
      leavingPaths: PATHS,
      teardownCalls: CALLS,
    });
    expect(errors.join("\n")).toContain("does not call endAgentRun()");
  });

  it("rejects an empty wrapper even when a SIBLING in the same file clears", () => {
    // The defect the second hop was written for, surviving the second hop.
    // Hop two used to grep the whole wrapper FILE, so any other function in it
    // that called the teardown satisfied the check and the empty wrapper the
    // path actually calls passed. It held in the tree only because the real
    // `mobile/src/lib/agent-lifetime.ts` contained one function, which is an
    // accident of file size rather than a property. Found by the /simplify
    // altitude pass on myne-md/myne#456, which injected exactly this.
    const errors = analyse({
      files: {
        "client/lock.ts": "export function lockVault() {\n  endAgentRun('lock');\n}\n",
        [WRAPPER]:
          "export function endAgentRun() {}\n" +
          "export function somethingElse() {\n  clearAgentForLock();\n}\n",
        "shared/store.ts": "export function clearAgentForLock() {}\n",
      },
      leavingPaths: PATHS,
      teardownCalls: CALLS,
    });
    expect(errors.join("\n")).toContain("never calls clearAgentForLock()");
  });

  it("reads a wrapper whose return type is a plain identifier", () => {
    // `bodyOf`'s rule was "the brace after `)` or `>`", which a
    // `: Promise<void> {` satisfies and a `: void {` does not: the scan walked
    // past the real body and returned the first INNER block whose brace
    // followed a `)`. Silent, and it reported the live wrapper as empty.
    const errors = analyse({
      files: {
        "client/lock.ts": "export function lockVault() {\n  endAgentRun('lock');\n}\n",
        [WRAPPER]:
          "export function endAgentRun(reason: Reason, notice: string): void {\n" +
          "  clearAgentForLock();\n" +
          "  if (reason === 'background') report(notice);\n" +
          "}\n",
        "shared/store.ts": "export function clearAgentForLock() {}\n",
      },
      leavingPaths: PATHS,
      teardownCalls: CALLS,
    });
    expect(errors).toEqual([]);
  });

  it("rejects an EMPTY wrapper, which is the whole point of the second hop", () => {
    // Hop one passes: the path calls the wrapper. Without hop two the guard
    // would report ok over a teardown that tears nothing down.
    const errors = analyse({
      files: {
        "client/lock.ts": "export function lockVault() {\n  endAgentRun('lock');\n}\n",
        [WRAPPER]: "export function endAgentRun() {}\n",
        "shared/store.ts": "export function clearAgentForLock() {}\n",
      },
      leavingPaths: PATHS,
      teardownCalls: CALLS,
    });
    expect(errors.join("\n")).toContain("never calls clearAgentForLock()");
  });

  it("fails by name when a via entry points at a file that is gone", () => {
    const errors = analyse({
      files: {
        "client/lock.ts": "export function lockVault() {\n  endAgentRun('lock');\n}\n",
        "shared/store.ts": "export function clearAgentForLock() {}\n",
      },
      leavingPaths: PATHS,
      teardownCalls: CALLS,
    });
    expect(errors.join("\n")).toContain("via entry for c:lock is stale");
  });

  it("keys on id, not on function name, so two clients' lockVault differ", () => {
    // Both clients call their choke point `lockVault`. Keyed on the name, one
    // roster entry would silently mean both and a skip for one would excuse the
    // other. Here the SECOND path is not in `appliesTo` and carries a reason,
    // so a name-keyed guard would report it as applying and fail.
    const errors = analyse({
      files: {
        "a/lock.ts": "export function lockVault() {\n  clearAgentForLock();\n}\n",
        "b/lock.ts": "export function lockVault() {\n  dropKeys();\n}\n",
        "shared/store.ts": "export function clearAgentForLock() {}\n",
      },
      leavingPaths: [
        { id: "a:lock", file: "a/lock.ts", fn: "lockVault", why: "client A" },
        { id: "b:lock", file: "b/lock.ts", fn: "lockVault", why: "client B" },
      ],
      teardownCalls: [
        {
          call: "clearAgentForLock",
          declaredIn: "shared/store.ts",
          holds: "note-derived plaintext",
          appliesTo: ["a:lock"],
          skips: {
            "b:lock": "Client B does not ship the surface that writes to this store at all.",
          },
        },
      ],
    });
    expect(errors).toEqual([]);
  });
});

describe("check-playwright-image", () => {
  const LOCK = `packages:\n\n  '@playwright/test@1.62.1':\n    resolution: {integrity: sha512-x}\n`;

  it("reads the version the lockfile resolves, not a package.json range", () => {
    expect(lockedVersion(LOCK)).toBe("1.62.1");
  });

  it("returns null when the dependency is absent, so the guard can fail by name", () => {
    expect(lockedVersion("packages:\n\n  'vitest@4.1.8':\n")).toBeNull();
  });

  it("finds every playwright image tag in the CI config", () => {
    const yml = [
      "  mobile-flow-logic:",
      "    image: mcr.microsoft.com/playwright:v1.62.1-noble",
      "  other:",
      "    image: mcr.microsoft.com/playwright:v1.61.1-jammy",
    ].join("\n");
    expect(imageTags(yml)).toEqual(["1.62.1", "1.61.1"]);
  });

  // The exact defect that shipped: 179 tests across 44 files failing in
  // `browserType.launch` because the image baked browsers for 1.61.1 while the
  // lockfile installed 1.62.1.
  it("the shipped mismatch is detectable from the two inputs alone", () => {
    const yml = "    image: mcr.microsoft.com/playwright:v1.61.1-noble\n";
    const tags = imageTags(yml);
    expect(tags).toEqual(["1.61.1"]);
    expect(tags.every((t) => t === lockedVersion(LOCK))).toBe(false);
  });

  it("and the aligned pair is not", () => {
    const yml = "    image: mcr.microsoft.com/playwright:v1.62.1-noble\n";
    expect(imageTags(yml).every((t) => t === lockedVersion(LOCK))).toBe(true);
  });

  it("reports no tags when the image is renamed, rather than passing empty", () => {
    // An empty tag list must not read as agreement: the guard fails on it.
    expect(imageTags("    image: node:25\n")).toEqual([]);
  });
});
