// The editor host answers for every member on both clients
// (phase3-web-client task 26).
//
// # What this pins that `tsc` cannot
//
// `src/editor-host.ts` compiles unchanged for desktop and web; what differs is
// which OPTIONAL members it installs, and that is decided at runtime by
// `platform/capabilities`. A type checker sees an object literal with spreads
// and is satisfied either way — so the property that matters ("a member the
// platform cannot honour is ABSENT, not present-and-failing") has no compile-time
// witness at all.
//
// The test drives the real module twice with the two real capability answers,
// rather than asserting against a hand-written list of what web omits — a list
// would be a third statement of the contract, and the one nobody updates.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The capability sets the two clients actually declare. */
const DESKTOP_ABSENT: string[] = [];
const WEB_ABSENT = [
  "clipper",
  "localAi",
  "watchCapture",
  "shareImport",
  "biometricQuickUnlock",
  "osIdleAutoLock",
  "screenCaptureProtection",
  "vaultMigration",
  "backup",
  "nativeSaveAs",
  "vaultCreation",
  "phraseRecovery",
  "vaultExport",
  // Task 47 — spell-check is a bundle-size decision, not a portability limit.
  "spellCheck",
];

// This list mirrors `web/src/platform/capabilities.ts`'s `ABSENT` by hand, and
// the mirror is not free: adding a capability there and forgetting it here makes
// this test assert the OLD shape while passing. `scripts/check-web-capabilities.mjs`
// is what actually keeps the two descriptors honest — it reads both files — so
// what this list is for is driving the host through a KNOWN answer, not being a
// second source of truth. Keep it in step, but trust the guard.

/**
 * Load `src/editor-host.ts` with a given capability answer and return the host
 * it installed. Every Tauri-facing import is mocked because this test is about
 * the SHAPE of the host, not about what its members do.
 */
async function loadHost(absent: string[]): Promise<Record<string, unknown>> {
  vi.resetModules();
  let installed: Record<string, unknown> | null = null;

  vi.doMock("../../src/platform/capabilities", () => ({
    has: (cap: string) => !absent.includes(cap),
  }));
  // editor-host imports setEditorHost from the `./host` sub-entry (not the
  // barrel) so the CodeMirror graph stays out of the first-load bundle — mock
  // the same specifier it actually imports.
  vi.doMock("@myne/editor/host", () => ({
    setEditorHost: (host: Record<string, unknown>) => {
      installed = host;
    },
  }));
  vi.doMock("../../src/platform/opener", () => ({ openUrl: async () => {} }));
  vi.doMock("../../src/platform/dialog", () => ({ save: async () => null }));
  vi.doMock("../../src/i18n", () => ({ default: { t: (k: string) => k } }));
  vi.doMock("../../src/notes/vaultIndices", () => ({
    tagTree: async () => [],
    isMediaTarget: () => false,
  }));
  vi.doMock("../../src/lib/attachments", () => ({
    attachmentExport: async () => {},
    attachmentRename: async () => {},
    attachmentReadText: async () => ({ text: "", truncated: false }),
    attachmentReadStructured: async () => ({ kind: "grid", rows: [] }),
  }));
  vi.doMock("../../src/lib/prefs", () => ({ prefsRead: async () => ({}) }));
  vi.doMock("../../src/notes/renameFlushHook", () => ({
    renameFlushHooks: () => ({ flushOpenPanes: async () => {} }),
  }));
  vi.doMock("../../src/notes/closeActiveTabSignal", () => ({
    CLOSE_ACTIVE_TAB_EVENT: "x",
  }));
  vi.doMock("../../src/lib/writing-assistant", () => ({
    infer: async () => "",
    // The ambient arm is its own export because its CLASS is decided by which
    // command runs, not by a payload flag (#188). A mock missing it makes the
    // desktop host fail to install rather than quietly lose the member.
    inferAmbient: async () => "",
    buildCompletionPrompt: () => "",
    buildTitlePrompt: () => "",
  }));
  vi.doMock("../../src/lib/spell", () => ({
    spellCheck: async () => [],
    addToPersonalDictionary: async () => {},
    ignoreWordInVault: async () => {},
  }));
  vi.doMock("../../src/lib/transcribe", () => ({ startTranscription: () => ({}) }));
  vi.doMock("../../src/lib/load-bearing-copy", () => ({
    AI_TRANSCRIPT_HONESTY_NOTE: "note",
  }));

  await import("../../src/editor-host");
  if (installed === null) throw new Error("editor-host installed nothing");
  return installed;
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../../src/platform/capabilities");
});

describe("editor host, per client", () => {
  it("desktop installs every member", async () => {
    const host = await loadHost(DESKTOP_ABSENT);
    expect(typeof host.t).toBe("function");
    expect(host.ai).toBeDefined();
    expect(host.spell).toBeDefined();
    expect(host.transcribe).toBeDefined();
    expect(host.transcriptHonestyNote).toBe("note");
    expect(
      (host.attachments as { pickExportDestination?: unknown }).pickExportDestination,
    ).toBeDefined();
    // Task 67 — the drop/paste handle mint. Installed UNCONDITIONALLY (both
    // clients answer, desktop with `null`), and asserted here because the unit
    // tests for the feature patch the host directly: they would all pass with
    // this member never wired at all, which is exactly how a working
    // implementation ships dead.
    expect(
      typeof (host.attachments as { pickedFromDropped?: unknown }).pickedFromDropped,
    ).toBe("function");
  });

  it("web omits the members its capability set says are absent", async () => {
    const host = await loadHost(WEB_ABSENT);

    // `localAi` absent → no ghost text, no AI slash commands, no transcription,
    // and no honesty note caveating a transcript that cannot be produced.
    expect("ai" in host).toBe(false);
    expect("transcribe" in host).toBe(false);
    expect("transcriptHonestyNote" in host).toBe(false);

    // `nativeSaveAs` absent → the Export affordance is omitted rather than
    // rendered and failing on click. Absence of the KEY is what the editor
    // checks, so `in` is the assertion, not `=== undefined`.
    expect("pickExportDestination" in (host.attachments as object)).toBe(false);

    // `spellCheck` absent (task 47) → no squiggles and no dictionary
    // affordances. The seam's contract for `spell` is that OMISSION disables
    // the feature, so the key must be gone rather than present-and-rejecting:
    // a present `spell` makes the editor call it on every idle pass and paint
    // nothing, which is a silent failure wearing a working feature's shape.
    expect("spell" in host).toBe(false);
  });

  it("web keeps the members that are ported or decided-present", async () => {
    const host = await loadHost(WEB_ABSENT);
    // Not gated: these have web backends today.
    expect(typeof host.t).toBe("function");
    expect(host.notes).toBeDefined();
    expect(typeof host.prefsRead).toBe("function");
    expect(typeof host.openExternal).toBe("function");
    expect(host.workspace).toBeDefined();
    // The cover picker (myne-md/myne#410) is not capability-gated: both clients
    // mount the same React picker over the same `attachment_import`, and the
    // seam member only carries the request from CodeMirror DOM into the shell.
    expect(host.cover).toBeDefined();
    const cover = host.cover as Record<string, unknown>;
    expect(typeof cover.openPicker).toBe("function");
    expect(typeof cover.remove).toBe("function");
    // Attachment IO stays installed: the port is task 44, and until then these
    // reject as `NotPortedToWeb` — a modelled refusal, not a silent lie.
    const attachments = host.attachments as Record<string, unknown>;
    expect(typeof attachments.attachmentExport).toBe("function");
    expect(typeof attachments.readText).toBe("function");
    // The attachment render path (task 44) is not capability-gated: both clients
    // resolve a ref, they just resolve it to different things — an
    // `attachment://` URL on desktop, an object URL on web.
    expect(typeof attachments.resolveRef).toBe("function");
    expect(typeof attachments.warmRefs).toBe("function");
  });
});
