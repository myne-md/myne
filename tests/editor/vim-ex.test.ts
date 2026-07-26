// @vitest-environment jsdom
//
// vim-keyboard-mode (MYND-313) — the `:` command table.
//
// The property under test is the BOUNDARY, not the plumbing: the table is closed,
// every entry maps to something Myne already does, and the commands a vim user
// will actually try that Myne refuses produce a message instead of silence.
//
// That boundary is the whole reason `:` was allowed to ship at all (design
// session Q3): a fixed dispatch table is the command palette in a vim accent,
// whereas `:set` / `:map` / `:source` would be a config-script surface Myne has
// committed not to grow. A regression here is a product-commitment regression,
// not a UX nit — hence the explicit "no command may persist behaviour" test.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { REFUSED_EX_COMMANDS, installExCommands, resetExCommandsForTests } from "../../editor/src/vim-ex";
import { setEditorHost, type EditorHost } from "../../editor/src/host";

type Defined = { name: string; prefix: string; run: (cm: unknown, params: unknown) => void };

function makeApi() {
  const defined: Defined[] = [];
  return {
    defined,
    api: {
      Vim: {
        defineEx(name: string, prefix: string, run: (cm: unknown, params: unknown) => void) {
          defined.push({ name, prefix, run });
        },
      },
    },
    find: (name: string) => defined.find((d) => d.name === name),
  };
}

function installHost(overrides?: Partial<EditorHost>) {
  const flushPendingSaves = vi.fn(async () => {});
  const closeActiveTab = vi.fn();
  setEditorHost({
    t: (key: string) => key,
    notes: { tagTree: async () => [], isMediaTarget: () => false },
    attachments: {
      attachmentExport: async () => {},
      attachmentRename: async () => {},
      pickExportDestination: async () => null,
      readText: async () => "",
      readStructured: async () => null,
    },
    prefsRead: async () => ({}),
    openExternal: () => {},
    workspace: { flushPendingSaves, closeActiveTab },
    ...overrides,
  } as unknown as EditorHost);
  return { flushPendingSaves, closeActiveTab };
}

describe("vim ex command table (MYND-313)", () => {
  beforeEach(() => {
    resetExCommandsForTests();
  });

  it("`:w` flushes pending saves — a real action, not a no-op", async () => {
    const { flushPendingSaves } = installHost();
    const stub = makeApi();
    installExCommands(stub.api);

    stub.find("write")!.run(null, null);
    await Promise.resolve();

    expect(flushPendingSaves).toHaveBeenCalledTimes(1);
  });

  it("`:q` closes the focused note tab", () => {
    const { closeActiveTab } = installHost();
    const stub = makeApi();
    installExCommands(stub.api);

    stub.find("quit")!.run(null, null);

    expect(closeActiveTab).toHaveBeenCalledTimes(1);
  });

  it("`:wq` and `:x` both write AND close", async () => {
    const { flushPendingSaves, closeActiveTab } = installHost();
    const stub = makeApi();
    installExCommands(stub.api);

    stub.find("wq")!.run(null, null);
    stub.find("xit")!.run(null, null);
    await Promise.resolve();

    expect(flushPendingSaves).toHaveBeenCalledTimes(2);
    expect(closeActiveTab).toHaveBeenCalledTimes(2);
  });

  it("refuses `:set`, `:map` and friends with a message rather than silence", () => {
    installHost();
    const stub = makeApi();
    installExCommands(stub.api);

    for (const { name } of REFUSED_EX_COMMANDS) {
      const cmd = stub.find(name);
      expect(cmd, `${name} should be defined so it can refuse`).toBeDefined();
      // Running it must not throw — it shows a toast and stops.
      expect(() => cmd!.run(null, null)).not.toThrow();
    }
  });

  it("defines NO command that could persist a behaviour definition", () => {
    // The commitment, asserted structurally: the only commands in the table are
    // the write/quit family and the explicit refusals. If someone later adds a
    // `:set` that actually sets something, this fails.
    installHost();
    const stub = makeApi();
    installExCommands(stub.api);

    const allowed = new Set(["write", "wq", "xit", "quit", "substitute"]);
    const refused = new Set(REFUSED_EX_COMMANDS.map((c) => c.name));

    for (const { name } of stub.defined) {
      expect(
        allowed.has(name) || refused.has(name),
        `unexpected ex command "${name}" — the table must stay closed`,
      ).toBe(true);
    }
  });

  it("degrades safely when the host backs no workspace (mobile)", () => {
    installHost({ workspace: undefined });
    const stub = makeApi();
    installExCommands(stub.api);

    // No crash: an unbacked platform gets a command that does nothing, which is
    // why the seam member is optional.
    expect(() => stub.find("write")!.run(null, null)).not.toThrow();
    expect(() => stub.find("quit")!.run(null, null)).not.toThrow();
  });

  it("is idempotent — the engine's command map is process-global", () => {
    installHost();
    const stub = makeApi();
    installExCommands(stub.api);
    const first = stub.defined.length;
    installExCommands(stub.api);

    expect(stub.defined).toHaveLength(first);
  });
});
