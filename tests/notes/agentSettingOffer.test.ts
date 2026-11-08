// Whether a run may be offered a setting change at all (myne-md/myne#850 task 5).
//
// **The failure this file guards is a promise made and then broken.** A setting
// change offered in a window that cannot write it is worse than one never
// offered: the user approves a change the app told them it would make, and then
// watches it fail at the ACL. So the gate is on the OFFER, not on the write.
//
// Two mechanisms, and only the first is a capability. A detached note window runs
// the same build as the main window and holds every capability it does, so the
// second arm is decided by WINDOW ROLE, which `detachedNoteId()` is where the app
// already tracks.
//
// **It is a consistency bound, not an enforcement, and this header said otherwise
// until the 2026-10-13 review read the write path.** The agent's setting write is
// an in-process call into the prefs plugin, not a `plugin:prefs|set-*` invocation,
// so the `prefs:allow-set-*` grant this used to cite is never consulted, and
// `detached-note.json` does grant `agent:default` to `note-*` windows. What the
// app guarantees is that its own UI never offers a change there; the host-side
// window check is owed and recorded in `myne-agents/docs/threat-model.md` §7.
//
// `settingsOffered` takes both inputs as parameters so both arms are exercisable
// without a detached window or a build that lacks the capability, and the last
// describe drives the REAL wiring through a mocked window global, the
// injected-plus-real pattern `dateTimeDisplayPublisher.test.ts` uses.

import { describe, expect, it, vi } from "vitest";

import { settingsOffered } from "../../src/notes/agent/settingCatalogue";

describe("settingsOffered", () => {
  it("is true only when the build can write AND this is the main window", () => {
    expect(settingsOffered(true, false)).toBe(true);
  });

  it("is false in a detached window, which holds every capability", () => {
    expect(settingsOffered(true, true)).toBe(false);
  });

  it("is false on a build with no preference write at all", () => {
    expect(settingsOffered(false, false)).toBe(false);
    expect(settingsOffered(false, true)).toBe(false);
  });
});

describe("offeredSettingIds in the ordinary case", () => {
  it("offers the settings the index marks writable", async () => {
    const { offeredSettingIds } = await import(
      "../../src/notes/agent/settingCatalogue"
    );
    expect(offeredSettingIds()).toContain("editor.weekly-notes-folder");
  });

  it("offers nothing the index refused", async () => {
    const { offeredSettingIds } = await import(
      "../../src/notes/agent/settingCatalogue"
    );
    // A control, and an entry no intent resolves to: neither may be offered,
    // whatever the window is.
    expect(offeredSettingIds()).not.toContain("privacy.auto-lock");
    expect(offeredSettingIds()).not.toContain("appearance.theme");
  });
});

describe("offeredSettingIds in a detached window", () => {
  it("offers nothing, through the real wiring", async () => {
    vi.resetModules();
    vi.doMock("../../src/lib/detachedWindow", () => ({
      detachedNoteId: () => "0184a2b3c4d5e6f708192a3b4c5d6e7f",
    }));
    const { offeredSettingIds } = await import(
      "../../src/notes/agent/settingCatalogue"
    );
    expect(offeredSettingIds()).toEqual([]);
    vi.doUnmock("../../src/lib/detachedWindow");
    vi.resetModules();
  });
});
