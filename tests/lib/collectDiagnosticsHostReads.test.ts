// @vitest-environment jsdom
//
// The two readings the desktop block cannot take in the page (myne-md/myne#991).
//
// # Why this is a second file rather than a case in `collectDiagnostics.test.ts`
//
// `HAS_TAURI` is a module-load constant (`src/lib/app-window.ts`), so the desktop
// path can only be reached by importing this module against a window that claims
// the Tauri runtime. That is a property of the file, not of a case, and forcing it
// per test would make the sibling file assert two different runtimes in one
// module registry.
//
// # What is being held
//
// The panel is opened on a desktop build where `servedBuildInfo()` answers `null`
// by construction and `navigator.storage.estimate()` describes the WebView's own
// origin store instead of the vault directory. Both lines used to be absent for
// that reason; the fix is two host commands, and the assertions below are that the
// block carries what the host answered, and that a host read which fails costs
// its own lines and never the block.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  /** What `servedBuildInfo()` answers: `null` is what the desktop seam returns. */
  served: null as { commit: string; bundleHash: string } | null,
  /** The host's answers, per command. Each case replaces the two it cares about. */
  digest: async (): Promise<string> => "sha256:host",
  usage: async (): Promise<{ entries: number; bytes: number } | null> => ({
    entries: 418,
    bytes: 12 * 1024 * 1024,
  }),
}));

// The desktop runtime, which is what routes the block through the host measures.
vi.mock("../../src/lib/app-window", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/app-window")>()),
  HAS_TAURI: true,
}));

vi.mock("../../src/platform/build-info", () => ({
  servedBuildInfo: async () => host.served,
}));

// One seam, dispatched per command name: the block crosses it for the vault doctor
// too, and a mock that answered everything with the doctor's payload would prove
// nothing about which command supplied which line.
vi.mock("../../src/platform/core", () => ({
  invoke: async (command: string) => {
    if (command === "plugin:diagnostics|build_digest") return await host.digest();
    if (command === "plugin:diagnostics|vault_usage") return await host.usage();
    return null;
  },
}));

import { collectDiagnostics } from "../../src/lib/collect-diagnostics";

/** Whether the block carries a `key: value` line at all. */
function hasField(text: string, key: string): boolean {
  return text.split("\n").some((line) => line.startsWith(`${key}: `));
}

/** The value of one `key: value` line. */
function field(text: string, key: string): string {
  const line = text.split("\n").find((l) => l.startsWith(`${key}: `));
  if (line === undefined) throw new Error(`no ${key} line in:\n${text}`);
  return line.slice(key.length + 2);
}

beforeEach(() => {
  host.served = null;
  host.digest = async () => "sha256:host";
  host.usage = async () => ({ entries: 418, bytes: 12 * 1024 * 1024 });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "storage", { value: undefined, configurable: true });
});

describe("the desktop block's host-side measures", () => {
  it("names the running build artefact, which the page has no way to hash", async () => {
    const text = await collectDiagnostics("none");
    expect(field(text, "bundleHash")).toBe("sha256:host");
  });

  it("reports the vault directory the host measured, and no quota for it", async () => {
    const text = await collectDiagnostics("none");
    expect(field(text, "storageUsedMb")).toBe("12");
    expect(field(text, "storageEntries")).toBe("418");
    // A directory has no quota of its own. The disk's free space is a different
    // fact, and the WebView origin's quota is a fact about a different store.
    // Printing either would be a true number answering the wrong question.
    expect(hasField(text, "storageQuotaMb")).toBe(false);
  });

  it("keeps a served hash when there is one: it names a published artefact", async () => {
    host.served = { commit: "abc1234", bundleHash: "sha256:served" };
    const text = await collectDiagnostics("none");
    expect(field(text, "bundleHash")).toBe("sha256:served");
    // The commit rides along from the same document, and it is unsliced here (the
    // About row is the surface that shortens it).
    expect(field(text, "commit")).toBe("abc1234");
  });

  it("prints no storage line rather than falling back to the origin store", async () => {
    // A client that measures its vault has no use for the page's own estimate, and
    // this is the case that separates the two: the estimate below WOULD answer, and
    // it describes the WebView's origin store, which holds none of the vault. The
    // host measure answering `null` means "could not read", and the block says so
    // by saying nothing.
    Object.defineProperty(navigator, "storage", {
      value: {
        estimate: async () => ({ usage: 7 * 1024 * 1024, quota: 200 * 1024 * 1024 }),
      },
      configurable: true,
    });
    host.usage = async () => null;
    const text = await collectDiagnostics("none");
    expect(hasField(text, "storageUsedMb")).toBe(false);
    expect(hasField(text, "storageQuotaMb")).toBe(false);
    expect(hasField(text, "storageEntries")).toBe(false);
  });

  it("loses only its own lines when a host measure refuses", async () => {
    host.digest = async () => {
      throw new Error("refused");
    };
    host.usage = async () => {
      throw new Error("refused");
    };
    const text = await collectDiagnostics("worker-fatal");
    // Absent, never placeholdered, and never a fabricated zero: the same rule
    // every unreadable field follows.
    expect(hasField(text, "bundleHash")).toBe(false);
    expect(hasField(text, "storageUsedMb")).toBe(false);
    expect(hasField(text, "storageEntries")).toBe(false);
    // And the report itself survives, which is what the user came for.
    expect(field(text, "failureCode")).toBe("worker-fatal");
    expect(hasField(text, "version")).toBe(true);
  });
});
