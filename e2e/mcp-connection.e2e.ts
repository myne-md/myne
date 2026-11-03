// External MCP connection suite (external-mcp-connection, myne-md/myne#923),
// task 10 of the feature: the desktop-lane scenario the feature owes.
//
// This is the lane that drives BOTH halves at once, the way `cli-thin-client`
// does for the terminal client: the production desktop binary through
// tauri-driver on one side, and the production `myne-mcp` binary as a real child
// process speaking JSON-RPC over stdio on the other. Everything below the socket
// already has dense coverage (`cli_bridge::mcp_door_test` on the desktop,
// `mcp/src/*` on the shim, `plugins::mcp::*` in `myne-core`); what no unit test
// can reach is what these three scenarios own:
//
//   mcp1: ENABLE, APPROVE, ANSWER: the door is shut on a fresh unlocked vault
//          and no program can reach it; flipping Settings → AI → Limits →
//          External access opens it; approving a connection while LEAVING A
//          FOLDER OUT writes a deny-list grant; and the real `myne-mcp`, started
//          with `MYNE_MCP_CONNECTION` naming that connection, answers
//          `tools/list` with the compiled catalog and `vault_state` with counts
//          that reflect the exclusion.
//   mcp2: THE EXCLUSION BITES: the left-out folder is absent from `vault_list`
//          while its in-scope sibling is present, and a note filed inside it is
//          absent from `note_search`. This is the assertion the whole deny-list
//          reversal rests on, and the one a unit test cannot make over the real
//          index.
//   mcp3: REVOKE AND LOCK ARE REFUSALS, NOT PROTOCOL ERRORS: revoking in
//          Settings turns the next call into `no_grant`, and locking the vault
//          turns it into `vault_locked`, both as `tools/call` RESULTS
//          (`isError: true` + `structuredContent.reason`) rather than JSON-RPC
//          errors, because a client reads a protocol error as a broken server
//          and reconnects. `tools/list` keeps answering in both states, because
//          that answer comes from the shim's own compiled schema and never
//          reaches the app.
//
// # Why the helper is spawned with `XDG_DATA_HOME` and that is NOT a test hook
//
// `mcp`'s door client resolves the command socket exactly as the CLI does,
// through `dirs::data_dir()` → `$XDG_DATA_HOME` on Linux, which
// `support/session.ts` already exports on the driver process to give each app
// instance its own data dir (SYNC-2). So this steers PRODUCTION path resolution,
// unchanged, the same way `cli-thin-client.e2e.ts` does and the same way a user
// whose session sets that variable would resolve. There is no flag and no
// environment variable the binary knows about for testing.
//
// # KDF + credential discipline
//
// Weak-KDF generator fixture (params are `vault.meta`-resident). The password
// never reaches the helper: the door never prompts. Note bodies DO reach stdout
// on `note_read`/`note_search`, deliberately: handing text over is the feature.
// The needle below is an in-source scenario constant, the accepted exception
// (SYNC-13).
//
// Vault-count precondition: 1 (weak KDF).

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

import { expect, it } from "vitest";

import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  contextMenuPick,
  createFolder,
  createNote,
  dismissImporterOffer,
  enableDeveloperMode,
  nameNewNote,
  openSettings,
  selectSettingsTopic,
  unlockToEditor,
} from "./support/flows";
import { describeE2E, scenario } from "./support/scenario";
import { defaultAppPath, type AppSession } from "./support/session";
import { type Session, testIdSelector } from "./support/webdriver";

// ---- the duplicated-by-design contract, from this side --------------------
//
// `MYNE_MCP_CONNECTION` is the env var a client's configuration carries the
// approved connection name in (`mcp/src/dispatch.rs::CONNECTION_ENV`), and the
// Settings snippet the UI writes names the same variable. Three places know the
// string (`mcp/`, the settings section, this suite) and they cannot share a
// constant, since the shim depends on neither the desktop nor the UI. Keep the
// `const NAME = "value";` shape: a guard greps it.
const CONNECTION_ENV = "MYNE_MCP_CONNECTION";

/** The connection this suite approves. Distinctive enough that it cannot
 *  collide with anything a fixture writes, and stable because the grant is
 *  keyed on it. */
const CONNECTION_NAME = "mcp-e2e-client";

/** The folder left out of the approval, and the in-scope sibling that must stay
 *  readable. Both are created through the real sidebar control. */
const LEFT_OUT_FOLDER = "e2eptrivate";
const IN_SCOPE_FOLDER = "e2eppublic";

/** A token that survives the search tokenizer and cannot collide with app
 *  chrome or with the note titles the fixture seeds. */
const HIDDEN_NEEDLE = "e2ephiddennoteneedle9k2xq7";

/** The production `myne-mcp` binary. Derived from the app path's directory so a
 *  `MYNE_E2E_APP` override carries the staged sidecar with it (a `tauri build`
 *  lands it next to the app binary as `<profile>/myne-mcp`; see
 *  `scripts/build-mcp-sidecar.mjs`), with its own override for the odd layout. */
function mcpBinary(): string {
  return process.env.MYNE_E2E_MCP ?? join(dirname(defaultAppPath()), "myne-mcp");
}

/** Requests are budgeted by the same socket limiter the CLI is held to (120 per
 *  60 s by default), so this suite makes a handful of calls in total rather than
 *  polling: every wait below is on the UI or the filesystem. */
const MCP_TIMEOUT_MS = 30_000;
const UI_TIMEOUT_MS = 15_000;

/** One JSON-RPC frame and the parsed answers to it, in order. */
interface RpcAnswer {
  id: number | null;
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    protocolVersion?: string;
  };
  error?: { code: number; message: string };
}

/**
 * Run the production `myne-mcp` against this app session, sending `frames` as
 * line-delimited JSON and collecting the answers.
 *
 * stdout is protocol only (`mcp/src/serve.rs`), so every non-blank line is one
 * response. stderr is captured separately and never echoed: it is where the
 * shim's own diagnostics would go, and a failure message must not become a
 * channel for note text.
 */
function runMcp(app: AppSession, frames: unknown[]): RpcAnswer[] {
  const input = frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");
  const result = spawnSync(mcpBinary(), [], {
    env: { ...process.env, XDG_DATA_HOME: app.dataHome, [CONNECTION_ENV]: CONNECTION_NAME },
    input,
    encoding: "utf8",
    timeout: MCP_TIMEOUT_MS,
  });
  if (result.error) {
    throw new Error(`myne-mcp did not spawn: ${result.error.message}`);
  }
  if (result.status === null) {
    // Killed by a signal or the timeout: the helper did not decide its own exit,
    // which for a stdio server that reads to EOF is a defect rather than slowness.
    throw new Error(
      `myne-mcp never exited on its own (signal ${result.signal ?? "none"}); it answers then exits on EOF`,
    );
  }
  // The annotations are load-bearing, not style: with no `@types/node` in the
  // typecheck, `result.stdout` is `any`, so `.split()` returns `any` and each
  // callback below loses its contextual type. CI has no node types and reported
  // exactly these three implicit-anys (the guard filters TS2591, not TS7006), and
  // a local run WITH node types hid them, which is why they shipped.
  const lines = ((result.stdout ?? "") as string)
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0);
  return lines.map((line: string) => {
    try {
      return JSON.parse(line) as RpcAnswer;
    } catch {
      // Never echo the line: it may carry note text from a `note_read`.
      throw new Error(`myne-mcp emitted a non-JSON line (${line.length} bytes)`);
    }
  });
}

/** One `tools/call` frame at request id `id`. */
function callFrame(id: number, tool: string, args: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } };
}

/** The `structuredContent.reason` a refused call carries, or a named throw. */
function refusalReason(answer: RpcAnswer, label: string): string {
  const result = answer.result;
  if (result === undefined) {
    throw new Error(
      `${label}: expected a tools/call RESULT carrying a refusal, got a protocol error ` +
        `(${answer.error?.code ?? "none"}: ${answer.error?.message ?? ""}). A client reads ` +
        `that as a broken server and reconnects`,
    );
  }
  expect(result.isError, `${label}: isError must be true on a refusal`).toBe(true);
  const reason = result.structuredContent?.reason;
  if (typeof reason !== "string") {
    throw new Error(`${label}: refusal carried no structuredContent.reason`);
  }
  return reason;
}

/** Open Settings → AI → Limits and wait for the External access section. The AI
 *  tab lives behind Developer mode (`developer-mode.e2e.ts:137`), so the caller
 *  enables that first; `enableDeveloperMode` leaves Settings OPEN on About by
 *  design, hence the tab click rather than a second `openSettings`. */
async function openExternalAccess(session: Session): Promise<void> {
  await (await session.byTestId("settings.tab-ai")).click();
  await session.byTestId("settings.ai-panel", { timeoutMs: UI_TIMEOUT_MS });
  await selectSettingsTopic(session, "ai", "limits");
  await session.byTestId("settings.mcp-external-access", { timeoutMs: UI_TIMEOUT_MS });
}

/** Turn the door on (it is off by default and the same switch as CLI Terminal
 *  access) and wait until the section reflects it. */
async function enableExternalAccess(session: Session): Promise<void> {
  const row = await session.byTestId("settings.mcp-enable");
  if ((await row.attribute("data-enabled")) === "false") {
    await (await session.byTestId("settings.mcp-enable-toggle")).click();
  }
  await session.waitUntil(
    async () =>
      (await (await session.byTestId("settings.mcp-enable")).attribute("data-enabled")) === "true"
        ? true
        : null,
    { label: "external access toggle = true", timeoutMs: UI_TIMEOUT_MS },
  );
}

/**
 * Approve `CONNECTION_NAME` while LEAVING `LEFT_OUT_FOLDER` out, through the
 * dialog a user actually uses.
 *
 * **The picker, not the setter.** The exclusion set is read back from the host's
 * own preview on Approve rather than from this side's copy of the selection
 * (`McpGrantDialog.approve`), so driving the picker proves the rule the resolver
 * enforces rather than a second implementation of it.
 */
async function approveLeavingOut(session: Session, folder: string): Promise<void> {
  await (await session.byTestId("settings.mcp-add")).click();
  await session.byTestId("settings.mcp-grant", { timeoutMs: UI_TIMEOUT_MS });

  await (await session.byTestId("settings.mcp-grant-name")).sendKeys(CONNECTION_NAME);

  await (await session.byTestId("settings.mcp-grant-exclude")).click();
  // The picker's option value is the HOST's folder path, and the host writes
  // paths with a trailing slash (`e2eptrivate/` — what every other sidebar spec
  // matches). Accept either spelling rather than encode one: this spec's subject
  // is the exclusion rule, not the separator.
  const option = await session.waitUntil(
    async () => {
      const [found] = await session.findElements(
        `${testIdSelector("settings.mcp-grant-exclude-option")}[data-value="${folder}"], ` +
          `${testIdSelector("settings.mcp-grant-exclude-option")}[data-value="${folder}/"]`,
      );
      return found ?? null;
    },
    { label: `the exclusion picker offering ${folder}`, timeoutMs: 10_000 },
  );
  await option.click();

  // The count the user read and the bytes written must be the same decision, so
  // wait for the host's preview to carry the exclusion before approving.
  await session.waitUntil(
    async () =>
      (await (await session.byTestId("settings.mcp-grant-counts")).attribute("data-excluded-count")) ===
      "1"
        ? true
        : null,
    { label: "the grant preview counts one exclusion", timeoutMs: 10_000 },
  );

  await (await session.byTestId("settings.mcp-grant-approve")).click();
  await session.byTestId("settings.mcp-connection", { timeoutMs: UI_TIMEOUT_MS });
}

/** Create the two folders this suite needs, and the note that must stay hidden.
 *  `createNote` files into the vault root; the note that has to live INSIDE the
 *  left-out folder is created after selecting that folder through the sidebar,
 *  which is the only route a user has. */
async function seedFoldersAndNotes(session: Session): Promise<void> {
  await createFolder(session, IN_SCOPE_FOLDER);
  await createFolder(session, LEFT_OUT_FOLDER);

  // A root note, readable under any grant: the control that proves the search
  // still works while an exclusion is in force.
  await createNote(session, "e2epinscopenote");

  // The note that must become unreachable, filed INSIDE the left-out folder.
  // The sidebar's `+ New note` button cannot do this: it resolves the target
  // from `new_note_location` (vault root by default), not from the selected
  // folder. The folder's own context menu is the route a user has.
  const row = await session.waitForElement(
    testIdSelector("notes.folder-row", { "data-folder-path": `${LEFT_OUT_FOLDER}/` }),
    { timeoutMs: UI_TIMEOUT_MS },
  );
  await contextMenuPick(session, row, "new-note");
  await nameNewNote(session, HIDDEN_NEEDLE);
}

describeE2E("mcp1 External access opens the door and approves a deny-list grant (myne-md/myne#923)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("enabling the door and approving a connection makes the real myne-mcp answer", async () => {
    let password = "";
    await scenario(
      "mcp1-enable-and-approve",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await seedFoldersAndNotes(s);

        // Default-off: an unlocked vault is not enough, and the helper's own
        // refusal is the proof that the door is shut rather than merely unlisted.
        await enableDeveloperMode(s);
        await openExternalAccess(s);
        const shut = runMcp(
          app,
          [{ jsonrpc: "2.0", id: 1, method: "tools/list" }, callFrame(2, "vault_state")],
        );
        expect(shut).toHaveLength(2);
        expect(refusalReason(shut[1], "door shut")).toBe("door_disabled");

        await enableExternalAccess(s);
        await approveLeavingOut(s, LEFT_OUT_FOLDER);
        await closeSettings(s);

        // Present is not reachable: a real session over the real binary is.
        const answers = runMcp(app, [
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          callFrame(2, "vault_state"),
        ]);
        expect(answers).toHaveLength(2);

        const catalog = answers[0].result?.tools ?? [];
        expect(catalog.map((tool) => tool.name).sort()).toEqual([
          "note_append",
          "note_create",
          "note_edit",
          "note_move",
          "note_read",
          "note_search",
          "note_set_field",
          "vault_list",
          "vault_state",
        ]);

        const state = answers[1].result?.structuredContent ?? {};
        // The answer is printed on failure: a bare `expected true to be false`
        // says an assertion flipped and nothing about why the server refused,
        // which is the whole question when the door and the grant both look open.
        // The answer is printed on failure: a bare `expected true to be false`
        // says an assertion flipped and nothing about why the server refused,
        // which is the whole question when the door and the grant both look open.
        expect(
          answers[1].result?.isError,
          `vault_state refused: ${JSON.stringify(answers[1].result?.structuredContent ?? answers[1].result?.content ?? answers[1].error ?? null)}`,
        ).toBe(false);
        expect(state.unlocked).toBe(true);
        expect(state.external_access).toBe(true);
        // The exclusion the user named is live, so it is counted as an exclusion
        // and not as a stale entry naming a folder the vault no longer has.
        expect(state.excluded_folder_count).toBe(1);
        expect(state.stale_exclusion_count).toBe(0);
      },
    );
  });
});

describeE2E("mcp2 a left-out folder is unreadable through the connection (myne-md/myne#923)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("vault_list omits the left-out folder and note_search cannot reach its note", async () => {
    let password = "";
    await scenario(
      "mcp2-exclusion-bites",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await seedFoldersAndNotes(s);

        await enableDeveloperMode(s);
        await openExternalAccess(s);
        await enableExternalAccess(s);
        await approveLeavingOut(s, LEFT_OUT_FOLDER);
        await closeSettings(s);

        const answers = runMcp(app, [
          callFrame(1, "vault_list"),
          callFrame(2, "note_search", { query: HIDDEN_NEEDLE }),
        ]);
        expect(answers).toHaveLength(2);

        // vault_list answers an ARRAY of { folder, count }, where `folder: null`
        // is the vault ROOT (in scope, because nothing named the root).
        expect(answers[0].result?.isError).toBe(false);
        const listed = JSON.stringify(answers[0].result?.structuredContent ?? {});
        expect(listed).toContain(IN_SCOPE_FOLDER);
        expect(listed).not.toContain(LEFT_OUT_FOLDER);

        // note_search: the note inside the left-out folder is unreachable, and
        // it is unreachable as "no results" rather than as a refusal, because
        // the search itself is inside the scope.
        expect(answers[1].result?.isError).toBe(false);
        const searchText = JSON.stringify(answers[1].result?.structuredContent ?? {});
        expect(searchText).not.toContain(HIDDEN_NEEDLE);
      },
    );
  });
});

describeE2E("mcp3 revoke and lock are refusals rather than protocol errors (myne-md/myne#923)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a revoked name answers no_grant and a locked vault answers vault_locked, both as results", async () => {
    let password = "";
    await scenario(
      "mcp3-revoke-and-lock",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await seedFoldersAndNotes(s);

        await enableDeveloperMode(s);
        await openExternalAccess(s);
        await enableExternalAccess(s);
        await approveLeavingOut(s, LEFT_OUT_FOLDER);

        // Revoke through the row, then close Settings: the grant is re-read on
        // every call, so the NEXT call is already refused with nothing to wait for.
        await (await s.byTestId("settings.mcp-revoke")).click();
        await closeSettings(s);

        const revoked = runMcp(app, [
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          callFrame(2, "vault_state"),
        ]);
        expect(revoked).toHaveLength(2);
        // Disclosure still works: that answer never leaves the shim.
        expect((revoked[0].result?.tools ?? []).length).toBeGreaterThan(0);
        expect(refusalReason(revoked[1], "revoked")).toBe("no_grant");

        // Re-approve, then lock: the same call is now refused for a different
        // reason, told apart because the fix is different.
        await openSettings(s, "ai");
        await selectSettingsTopic(s, "ai", "limits");
        await approveLeavingOut(s, LEFT_OUT_FOLDER);
        await closeSettings(s);

        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input", { timeoutMs: UI_TIMEOUT_MS });

        const locked = runMcp(app, [
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          callFrame(2, "vault_state"),
        ]);
        expect(locked).toHaveLength(2);
        expect((locked[0].result?.tools ?? []).length).toBeGreaterThan(0);
        expect(refusalReason(locked[1], "locked")).toBe("vault_locked");
      },
    );
  });
});
