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
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLACEHOLDER,
  deadBindings,
  invokesThroughChokepoint,
  mergeRecord,
  ratchet,
} from "../../scripts/check-ipc-binding-callers.mjs";
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

  it("does not accept a COMMENT mention as a caller", () => {
    // myne-md/myne#886: the import strip left this hole one line away. A caller
    // file that names the binding in a doc comment and never calls it counted as
    // a caller, so replacing the real call with a no-op kept the guard green and
    // the exemption deletion was resting on a comment. A comment is weaker
    // evidence than an import, which the case above already rejects.
    const { dead } = deadBindings({
      bindings: new Map([["src/lib/agent-run.ts", BINDING]]),
      callers: new Map([
        ["src/lib/agent-run.ts", BINDING],
        [
          "src/notes/agent/Composer.tsx",
          `import { agentCapability, agentStart } from "../../lib/agent-run";
// On open it probes the cache (agentCapability), then runs.
/* agentCapability is what this WOULD call. */
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

  it("counts a caller that RENAMED the import", () => {
    // `withoutImports` strips the import line so a mention in it cannot count as
    // a call, and that is also the only place the two names appear together. The
    // remaining text says `probe(...)` and never says `agentCapability`, so a
    // binding four call sites reach was reported dead. A FALSE POSITIVE on a
    // ratchet is the dangerous direction: the fix a reader reaches for is an
    // exemption, and an exemption on live code turns the record from a list of
    // defects into a list of names somebody once argued about.
    const { dead } = deadBindings({
      bindings: new Map([["src/lib/agent-run.ts", BINDING]]),
      callers: new Map([
        ["src/lib/agent-run.ts", BINDING],
        [
          "src/notes/agent/Composer.tsx",
          `import { agentCapability as probe, agentStart } from "../../lib/agent-run";
const v = await probe();
await agentStart(task);`,
        ],
      ]),
    });
    expect(dead).toEqual([]);
  });

  it("still refuses a renamed import that is never called", () => {
    // The direction that turns the fix above into a hole. Resolving the alias
    // must not resurrect the rule the guard already learned once: an import is
    // not a caller, whatever local name it is given.
    const { dead } = deadBindings({
      bindings: new Map([["src/lib/agent-run.ts", BINDING]]),
      callers: new Map([
        ["src/lib/agent-run.ts", BINDING],
        [
          "src/notes/agent/Composer.tsx",
          `import { agentCapability as probe, agentStart } from "../../lib/agent-run";
await agentStart(task);`,
        ],
      ]),
    });
    expect(dead).toEqual(["src/lib/agent-run.ts:agentCapability"]);
  });

  it("counts a binding reached through one exported function in its own file", () => {
    // `mobile/src/lib/workspace-persist.ts` declares `workspaceRead`, calls it
    // from `ensureWorkspaceHydrated` twenty lines down, and exports that
    // instead. The binding is reached on every unlock. The guard's header
    // records the same-file shape as MEASURED not to occur in the binding
    // layer, and that measurement was taken before the caller search was scoped
    // per client, so it only ever read the desktop tree.
    const src = `${BINDING}
export async function hydrate(): Promise<void> {
  await agentCapability();
}
`;
    const { dead } = deadBindings({
      bindings: new Map([["src/lib/agent-run.ts", src]]),
      callers: new Map([
        ["src/lib/agent-run.ts", src],
        ["src/notes/agent/Composer.tsx", `await hydrate();\nawait agentStart(task);`],
      ]),
    });
    expect(dead).toEqual([]);
  });

  it("refuses the hop when the intermediary is itself dead", () => {
    // What stops the hop being a hole. Two dead functions inside one file must
    // not carry each other into liveness, which is also why the hop is ONE and
    // not a chain the guard follows arbitrarily far.
    const src = `${BINDING}
export async function hydrate(): Promise<void> {
  await agentCapability();
}
`;
    const { dead } = deadBindings({
      bindings: new Map([["src/lib/agent-run.ts", src]]),
      callers: new Map([
        ["src/lib/agent-run.ts", src],
        ["src/notes/agent/Composer.tsx", `await agentStart(task);`],
      ]),
    });
    expect(dead).toEqual(["src/lib/agent-run.ts:agentCapability"]);
  });

  it("does not let a MENTION inside the declaring file stand in for a call", () => {
    // The hop looks for `name(`, not for the name. A doc comment naming the
    // binding inside a live exported function is not a call site, and treating
    // it as one would make every binding a comment away from liveness.
    const src = `${BINDING}
export async function hydrate(): Promise<void> {
  // agentCapability is what this WOULD call.
  return;
}
`;
    const { dead } = deadBindings({
      bindings: new Map([["src/lib/agent-run.ts", src]]),
      callers: new Map([
        ["src/lib/agent-run.ts", src],
        ["src/notes/agent/Composer.tsx", `await hydrate();\nawait agentStart(task);`],
      ]),
    });
    expect(dead).toEqual(["src/lib/agent-run.ts:agentCapability"]);
  });

  it("does not let one client's caller answer for the other client's binding", () => {
    // Both Tauri clients name their bindings identically, so a flat search over
    // every caller root let desktop's caller satisfy mobile's binding and the
    // other way round: the same "each was the other's caller" defect the
    // re-export fix closed one level down. It survived two earlier fixes to this
    // guard in the same change.
    const { dead } = deadBindings({
      bindings: new Map([
        ["src/lib/agent-run.ts", BINDING],
        ["mobile/src/lib/agent-run.ts", BINDING],
      ]),
      callers: new Map([
        ["src/lib/agent-run.ts", BINDING],
        ["mobile/src/lib/agent-run.ts", BINDING],
        [
          "src/notes/agent/Composer.tsx",
          `const v = await agentCapability();\nawait agentStart(task);`,
        ],
        ["mobile/src/app/flows/EditorFlow.tsx", `await agentStart(task);`],
      ]),
    });
    expect(dead).toEqual(["mobile/src/lib/agent-run.ts:agentCapability"]);
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

  it("recognises a binding behind the prefs chokepoint", () => {
    // Blind spot A (myne-md/myne#605): prefs writes carry no direct `invoke`
    // — the literal sits as `writePref`'s first argument, and `writePref` is
    // module-private and the only thing that calls `invoke`. The success line
    // still counted; it just counted almost nothing (3 of 70 desktop prefs
    // bindings). A `writePref("plugin:…")` body is a binding too.
    const PREFS = `export async function setFoo(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_foo", { enabled });
}
`;
    const { dead, checked } = deadBindings({
      bindings: new Map([["src/lib/prefs.ts", PREFS]]),
      callers: new Map([
        ["src/lib/prefs.ts", PREFS],
        ["src/components/settings/Foo.tsx", `await setFoo(true);`],
      ]),
    });
    expect(checked).toBe(1);
    expect(dead).toEqual([]);
  });

  it("names a chokepoint binding with no caller in its own tree", () => {
    // Forward injection for the widening above: the new denominator must
    // actually report, by path and symbol. This is `setDailyDateFormat`'s
    // shape — consumed on its client, settable on neither.
    const PREFS = `export async function setFoo(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_foo", { enabled });
}
`;
    const { dead } = deadBindings({
      bindings: new Map([["mobile/src/lib/prefs.ts", PREFS]]),
      callers: new Map([["mobile/src/lib/prefs.ts", PREFS]]),
    });
    expect(dead).toEqual(["mobile/src/lib/prefs.ts:setFoo"]);
  });

  it("does not let the other client's caller answer for a chokepoint binding", () => {
    // The tree-scoping rule applies to chokepoint bindings exactly as to
    // direct ones: a desktop caller must not keep a mobile setter alive. The
    // sixteen mobile prefs setters this widening surfaced were held alive only
    // by `src/` files.
    const PREFS = `export async function setFoo(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_foo", { enabled });
}
`;
    const { dead } = deadBindings({
      bindings: new Map([["mobile/src/lib/prefs.ts", PREFS]]),
      callers: new Map([
        ["mobile/src/lib/prefs.ts", PREFS],
        ["src/components/settings/Foo.tsx", `await setFoo(true);`],
      ]),
    });
    expect(dead).toEqual(["mobile/src/lib/prefs.ts:setFoo"]);
  });

  it("accepts a chokepoint binding called from its own client", () => {
    // The passing direction of the same rule: the identical setter called
    // from `mobile/src` is live.
    const PREFS = `export async function setFoo(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_foo", { enabled });
}
`;
    const { dead } = deadBindings({
      bindings: new Map([["mobile/src/lib/prefs.ts", PREFS]]),
      callers: new Map([
        ["mobile/src/lib/prefs.ts", PREFS],
        ["mobile/src/app/flows/Settings.tsx", `await setFoo(true);`],
      ]),
    });
    expect(dead).toEqual([]);
  });

  it("recognises a GENERIC chokepoint call with no caller", () => {
    // The generic form (myne-md/myne#880). Since myne-md/myne#613 the five
    // set-union mutators are written `writePref<number>("plugin:prefs|…")`,
    // because they return how many additions the reserved byte budget refused,
    // and the matcher required the literal immediately after `writePref(`. So
    // those five desktop and three mobile bindings never entered the
    // denominator: measured, desktop showed 71 of its 76 prefs bindings and
    // mobile 55 of its 58. This is `mutateSpellLanguages`' shape, the mobile
    // binding the widening surfaced as genuinely uncalled.
    const PREFS = `export async function setFoo(mutation: SetMutation): Promise<number> {
  return await writePref<number>("plugin:prefs|set_foo", { mutation });
}
`;
    const { dead, checked } = deadBindings({
      bindings: new Map([["mobile/src/lib/prefs.ts", PREFS]]),
      callers: new Map([["mobile/src/lib/prefs.ts", PREFS]]),
    });
    expect(checked).toBe(1);
    expect(dead).toEqual(["mobile/src/lib/prefs.ts:setFoo"]);
  });

  it("accepts a GENERIC chokepoint binding called from its own client", () => {
    // The passing direction of the widening: the identical generic setter
    // called from `mobile/src` is live, so the widening did not simply report
    // every generic binding.
    const PREFS = `export async function setFoo(mutation: SetMutation): Promise<number> {
  return await writePref<number>("plugin:prefs|set_foo", { mutation });
}
`;
    const { dead } = deadBindings({
      bindings: new Map([["mobile/src/lib/prefs.ts", PREFS]]),
      callers: new Map([
        ["mobile/src/lib/prefs.ts", PREFS],
        ["mobile/src/app/flows/Settings.tsx", `await setFoo(mutation);`],
      ]),
    });
    expect(dead).toEqual([]);
  });

  it("does not accept a bare invoke as a chokepoint call", () => {
    // The direction the widening must NOT take. The chokepoint is the mandated
    // write path, and `invoke("plugin:prefs|…")` is exactly the shape it exists
    // to forbid, so a matcher written as a generic function-name pattern (which
    // would match `invoke<number>(…)` too) would make a bypass look compliant.
    // Driven directly because the difference is invisible through
    // `deadBindings`: a direct `invoke` is detected by `invokesCommand` either
    // way, so only this assertion distinguishes the two spellings.
    expect(invokesThroughChokepoint(`await invoke("plugin:prefs|set_foo", {})`)).toBe(false);
    expect(invokesThroughChokepoint(`await invoke<number>("plugin:prefs|set_foo", {})`)).toBe(
      false,
    );
    // And the two real shapes still count.
    expect(invokesThroughChokepoint(`await writePref("plugin:prefs|set_foo", { enabled })`)).toBe(
      true,
    );
    expect(
      invokesThroughChokepoint(`return await writePref<number>("plugin:prefs|set_foo", { mutation })`),
    ).toBe(true);
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

describe("check-ipc-binding-callers: the writer", () => {
  // The half this file's own history says nobody tests, and the one that was
  // wrong: `--record` built the file from the measured set alone, so running the
  // command the failure message recommends replaced all thirty hand-written
  // reasons with the placeholder. The header and the root AGENTS.md row both
  // described the merge as existing behaviour, which is how the code and its
  // documentation had already parted company.

  const reason = "Recorded because the surface it belongs to has not been built yet.";

  it("keeps the reason of every entry that is still dead", () => {
    const exempt = mergeRecord(["a.ts:x", "b.ts:y"], { "a.ts:x": reason, "b.ts:y": reason });
    expect(exempt).toEqual({ "a.ts:x": reason, "b.ts:y": reason });
    // And the result passes the reader, which is the property that matters: a
    // merge that lost a reason would come back as `unreasoned`.
    expect(ratchet(["a.ts:x", "b.ts:y"], exempt)).toEqual({ news: [], unreasoned: [], stale: [] });
  });

  it("still seeds a genuinely new entry with the placeholder", () => {
    // The placeholder is not a regression: it is how a fresh exemption fails
    // until a human argues for it.
    const exempt = mergeRecord(["a.ts:x", "b.ts:y"], { "a.ts:x": reason }) as Record<string, string>;
    expect(exempt["b.ts:y"]).toBe(PLACEHOLDER);
    expect(ratchet(["a.ts:x", "b.ts:y"], exempt).unreasoned).toEqual(["b.ts:y"]);
  });

  it("drops an entry whose binding acquired a caller", () => {
    // The one edit `--record` exists to make.
    const exempt = mergeRecord(["a.ts:x"], { "a.ts:x": reason, "b.ts:y": reason });
    expect(Object.keys(exempt)).toEqual(["a.ts:x"]);
    expect(ratchet(["a.ts:x"], exempt).stale).toEqual([]);
  });

  it("treats a blank prior reason as absent rather than preserving it", () => {
    const exempt = mergeRecord(["a.ts:x"], { "a.ts:x": "   " }) as Record<string, string>;
    expect(exempt["a.ts:x"]).toBe(PLACEHOLDER);
  });

  // ── The same claim, driven through the CLI ────────────────────────────────
  //
  // The cases above are pure functions, and that leaves the GLUE untested: the
  // record path, the JSON shape, the exit code and the message. A regression
  // there stays green behind a passing unit, which is the "writer's half nobody
  // tests" shape this file's own header records. `check-prefs-parity.mjs`'s suite
  // drives its `--record` the same way, through a record-path override.
  it("--record seeds the placeholder and the very next --check is red", () => {
    withTempRecord((path) => {
      const recorded = runCli(["--record"], path);
      expect(recorded.code).toBe(0);
      expect(recorded.out).toContain("carry the placeholder");

      const written = JSON.parse(readFileSync(path, "utf8")) as {
        exempt: Record<string, string>;
      };
      const keys = Object.keys(written.exempt);
      expect(keys.length, "the scratch record must carry the measured dead set").toBeGreaterThan(0);
      for (const key of keys) expect(written.exempt[key]).toBe(PLACEHOLDER);

      const checked = runCli(["--check"], path);
      expect(checked.code).toBe(1);
      expect(checked.out).toContain("carry no reason");
      expect(checked.out).toContain(keys[0]);
    });
  }, 120_000);
});

const ROOT: string = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT: string = join(ROOT, "scripts/check-ipc-binding-callers.mjs");

/** Spawn the guard, pointed at a scratch record. */
function runCli(args: string[], recordPath: string): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync("node", [SCRIPT, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, MYNE_IPC_BINDING_CALLERS_RECORD: recordPath },
      }),
    };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

/** Run `body` with a scratch record path, removed afterwards either way. */
function withTempRecord(body: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "myne-ipc-binding-callers-"));
  const path = join(dir, "ipc-binding-callers.json");
  try {
    body(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A file set that satisfies both real rosters, as the baseline each case mutates. */
function healthyFiles(): Record<string, string> {
  return {
    "src/notes/agent/agentStore.ts": `export function clearAgentForLock(): void {}\n`,
    "src/notes/ai/chatStore.ts": `export function clearChat(): void {}\n`,
    "src/notes/ai/chatPersist.ts": `export function clearChatPersistForLock(): void {}\n`,
    "mobile/src/lib/chatHistory.ts": `export function clearChatHistoryPersistForLock(): void {}\n`,
    "editor/src/decorations/spell.ts": `export function resetSessionIgnored(): void {}\n`,
    "editor/src/host/lib/datetimeFormat.ts": `export function resetDateTimeDisplayForLock(): void {}\n`,
    "src/components/sync/personIdentityState.ts": `export function resetPersonIdentityState(): void {}\n`,
    "src/notes/collab/awarenessStore.ts": `export function clearAwareness(): void {}\n`,
    // view-manifests: the bulk field action's journal (ids only, still cleared on
    // every leaving path).
    "src/notes/views/bulkUndoJournal.ts": `export function clearBulkUndoForLock(): void {}\n`,

    // The two DELETE paths. Only the display store is asserted on them: what it
    // holds describes the READER, so erasing the vault erases the source of the
    // value and never the value. Every other store skips them with a stated
    // reason, which is why these bodies carry one call each.
    "src/lib/vault-delete.ts": `export async function deleteVault(vaultId: string): Promise<void> {
  resetDateTimeDisplayForLock();
  resetPersonIdentityState();
  clearAwareness();
  clearBulkUndoForLock();
  await invoke("plugin:vault-unlock|vault_delete");
}
`,

    "mobile/src/lib/vault-delete.ts": `export async function deleteVault(vaultId?: string): Promise<void> {
  resetDateTimeDisplayForLock();
  clearAwareness();
  await invoke("plugin:vault-unlock|vault_delete");
}
`,
    "src/notes/meetingSession.ts": `export function teardownMeetingSessionForLock(): void {
  clearMeetingAiOffer();
}\n`,
    "src/components/meeting/meetingAiStore.ts": `export function clearMeetingAiOffer(): void {}\n`,
    "src/notes/scrollMemory.ts": `export function resetScrollMemory(): void {}\n`,
    "src/notes/recentNotes.ts": `export function resetRecentNotes(): void {}\n`,
    "editor/src/attachments/decoded-aspect.ts": `export function resetDecodedAspects(): void {}\n`,
    "editor/src/attachments/session-caches.ts": `export function resetPreviewCache(): void {}
export function resetTranscripts(): void {}
export function resetMermaidZoom(): void {}\n`,
    "src/lib/vault-unlock.ts": `export async function lockVault(): Promise<void> {
  clearAgentForLock();
  clearAwareness();
  clearChat();
  clearChatPersistForLock();
  await invoke("plugin:vault_unlock|vault_lock");
  resetScrollMemory();
  resetRecentNotes();
  resetDecodedAspects();
  resetPreviewCache();
  resetTranscripts();
  teardownMeetingSessionForLock();
  resetMermaidZoom();
  resetDateTimeDisplayForLock();
  resetPersonIdentityState();
  clearBulkUndoForLock();
}
`,

    "src/lib/vault-switch.ts": `export async function leaveActiveVault(deps: {
  reason: string;
}): Promise<void> {
  clearAgentForLock();
  clearAwareness();
  clearChat();
  clearChatPersistForLock();
  resetSessionIgnored();
  await lockVault();
  resetScrollMemory();
  resetRecentNotes();
  resetDecodedAspects();
  resetPreviewCache();
  resetTranscripts();
  teardownMeetingSessionForLock();
  resetMermaidZoom();
  resetDateTimeDisplayForLock();
  clearBulkUndoForLock();
}
`,
    "src/App.tsx": `const onCreateAutoUnlockSuccess = () => {
  resetPersonIdentityState();
}
`,
    // Mobile (myne-md/myne#456). One choke point, and the background listener,
    // both reaching the agent teardown through the wrapper that also cancels
    // the host-side run.
    "mobile/src/lib/vault-unlock.ts": `export async function lockVault(): Promise<void> {
  endAgentRun("lock", "");
  clearChatHistoryPersistForLock();
  await invoke("plugin:vault-unlock|lock");
  resetDecodedAspects();
  resetPreviewCache();
  resetTranscripts();
  resetMermaidZoom();
  resetDateTimeDisplayForLock();
  clearAwareness();
}
`,
    "mobile/src/app/flows/EditorFlow.tsx": `const flushAll = () => {
  endAgentRun("background", notice);
  clearAwareness();
};
`,
    "mobile/src/lib/agent-lifetime.ts": `export function endAgentRun(): void {
  clearAgentForLock();
}
`,
    // The two editor exits that skip `lockVault` (myne-md/myne#849 review, D9),
    // named functions so the roster can hold them. Both in one file, as in the
    // real `AppShell.tsx`, so the extraction is exercised on a file holding two.
    "mobile/src/app/AppShell.tsx": `function StageSwitch() {
  const leaveForCreateVault = () => {
    endAgentRun("lock", "");
    clearAwareness();
    clearHandoffCaches();
    dispatch({ type: "editor.create-vault" });
  };

  const leaveForJoinAccount = () => {
    endAgentRun("lock", "");
    clearAwareness();
    clearHandoffCaches();
    setJoinFrom("editor");
  };
}
`,
    // The one hop the five re-derivable editor caches go through on those two
    // exits (myne-md/myne#849 review): a named wrapper, like `lockVault`, so the
    // guard's second hop can hold it rather than ten inline calls.
    "mobile/src/app/vaultHandoff.ts": `export function clearHandoffCaches(): void {
  resetDecodedAspects();
  resetPreviewCache();
  resetTranscripts();
  resetMermaidZoom();
  resetDateTimeDisplayForLock();
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

  it("names a person-state reset removed from the desktop lock choke point", () => {
    const files = healthyFiles();
    files["src/lib/vault-unlock.ts"] = files["src/lib/vault-unlock.ts"].replace(
      "  resetPersonIdentityState();\n",
      "",
    );
    const errors = run(files);
    expect(errors.some((error) => error.includes("lockVault does not call resetPersonIdentityState()"))).toBe(true);
  });

  it("names a person-state reset removed from the desktop delete path", () => {
    const files = healthyFiles();
    files["src/lib/vault-delete.ts"] = files["src/lib/vault-delete.ts"].replace(
      "  resetPersonIdentityState();\n",
      "",
    );
    const errors = run(files);
    expect(errors.some((error) => error.includes("deleteVault does not call resetPersonIdentityState()"))).toBe(true);
  });

  it("names a person-state reset removed from the direct create boundary", () => {
    const files = healthyFiles();
    files["src/App.tsx"] = files["src/App.tsx"].replace(
      "  resetPersonIdentityState();\n",
      "",
    );
    const errors = run(files);
    expect(
      errors.some((error) =>
        error.includes("onCreateAutoUnlockSuccess does not call resetPersonIdentityState()"),
      ),
    ).toBe(true);
  });

  it("names a person-state reset removed from the switch choke point", () => {
    const files = healthyFiles();
    files["src/lib/vault-switch.ts"] = files["src/lib/vault-switch.ts"].replace(
      "  await lockVault();\n",
      "",
    );
    const errors = run(files);
    expect(errors.some((error) => error.includes("leaveActiveVault does not call lockVault()"))).toBe(true);
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
      "could not extract lockVault's body in src/lib/vault-unlock.ts",
    ]);
  });

  it("names the myne#533 defect: the chat transcript cleared on neither path", () => {
    // `clearChat` had no roster entry and no call on either leaving path: the
    // only thing dropping the transcript was the Editor's unmount cleanup,
    // which is a rendering fact rather than a guarantee. Both paths are
    // asserted, so removing either is named on its own.
    const files = healthyFiles();
    files["src/lib/vault-unlock.ts"] = files["src/lib/vault-unlock.ts"].replace(
      "  clearChat();\n",
      "",
    );
    files["src/lib/vault-switch.ts"] = files["src/lib/vault-switch.ts"].replace(
      "  clearChat();\n",
      "",
    );
    const errors = run(files);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("lockVault does not call clearChat()");
    expect(errors[1]).toContain("leaveActiveVault does not call clearChat()");
  });

  // The presence store on every mobile leaving path (myne-md/myne#849 review, D9).
  // Each case removes the ONE `clearAwareness();` a mobile path carries and expects
  // the guard to name that path, so a call deleted from any of them reddens this
  // suite rather than leaving the previous vault's peers resident.
  it.each([
    ["mobile/src/lib/vault-unlock.ts", "mobile/src/lib/vault-unlock.ts::lockVault"],
    ["mobile/src/lib/vault-delete.ts", "mobile/src/lib/vault-delete.ts::deleteVault"],
    ["mobile/src/app/flows/EditorFlow.tsx", "mobile/src/app/flows/EditorFlow.tsx::flushAll"],
  ])("names clearAwareness removed from %s", (file, path) => {
    const files = healthyFiles();
    expect(files[file].split("clearAwareness();")).toHaveLength(2);
    files[file] = files[file].replace("  clearAwareness();\n", "");
    expect(run(files)).toEqual([
      expect.stringContaining(`${path} does not call clearAwareness()`),
    ]);
  });

  it.each([
    ["leaveForCreateVault", "dispatch"],
    ["leaveForJoinAccount", "setJoinFrom"],
  ])("names clearAwareness removed from AppShell's %s", (fn, tail) => {
    // The file holds both exits, so the removal is scoped to the one function's
    // own call: the line just before its distinctive tail.
    const files = healthyFiles();
    const file = "mobile/src/app/AppShell.tsx";
    const before = files[file];
    files[file] = before.replace(
      `    clearAwareness();\n    clearHandoffCaches();\n    ${tail}(`,
      `    clearHandoffCaches();\n    ${tail}(`,
    );
    expect(files[file]).not.toBe(before);
    expect(run(files)).toEqual([
      expect.stringContaining(`${file}::${fn} does not call clearAwareness()`),
    ]);
  });

  it("names the agent run dropped from the create exit", () => {
    // `leaveForCreateVault` gained `endAgentRun` with its roster row: as an inline
    // prop it had the presence clear and not this one.
    const files = healthyFiles();
    const file = "mobile/src/app/AppShell.tsx";
    files[file] = files[file].replace(
      `    endAgentRun("lock", "");\n    clearAwareness();\n    clearHandoffCaches();\n    dispatch(`,
      `    clearAwareness();\n    clearHandoffCaches();\n    dispatch(`,
    );
    expect(run(files)).toEqual([
      expect.stringContaining(`${file}::leaveForCreateVault does not call endAgentRun()`),
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
          // Ids, not function names. Both clients call their choke point
          // `lockVault`, so a name-keyed roster could not tell them apart and a
          // skip for one would silently excuse the other.
          appliesTo: ["desktop-switch"],
          skips: { "desktop-lock": "not needed" },
        },
      ],
    });
    // Only the desktop lock path is reported: it is the one whose reason is too
    // short. The other three are reported too, since this cut-down roster gives
    // them no reason at all.
    expect(errors).toContain(
      "resetSessionIgnored does not apply to desktop-lock and gives no reason",
    );
  });
});
