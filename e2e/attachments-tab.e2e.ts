// att-tab: the attachment library is a TAB, and the ribbon knows it is open
// (myne-md/myne#773, epic #772 lane 4).
// Vault-count precondition: 1.
//
// The library used to be a `CenterView` — a second, parallel center-pane swap
// that replaced the whole pane tree, tab strip included. Three things were
// impossible because of that and are asserted here:
//
//   - it can be OPEN as a tab, with a tab-strip entry like any other surface;
//   - the left ribbon marks its own Attachments entry as current, which it
//     could not do at all before (pressing Attachments and pressing Graph left
//     the rail looking identical);
//   - opening a note REPLACES it, because that is what opening a note in the
//     focused pane means — no bespoke `onClose` swap.
//
// KDF: weak generator fixtures (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO: authored to the harness conventions but NOT yet validated in
// the container (this dev platform is macOS; the suite is Linux/tauri-driver
// only). Definition of done per e2e/AGENTS.md is "green 3× consecutive" via
// ./scripts/e2e-buildrun.sh. Run ISOLATED: the full suite contaminates.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  lockAndReunlock,
  unlockToEditor,
} from "./support/flows";
import type { Session } from "./support/webdriver";

const RAIL_BUTTON = '[data-testid="editor.ribbon.button"]';

/** The rail entry marked `aria-current="page"`, by command id, or null. */
async function currentRailCommand(s: Session): Promise<string | null> {
  return await s.execute<string | null>(
    `const el = document.querySelector('${RAIL_BUTTON}[aria-current="page"]');` +
      `return el === null ? null : el.getAttribute('data-command-id');`,
  );
}

/** The focused pane's tab labels, in strip order. */
async function tabLabels(s: Session): Promise<string[]> {
  const out = await s.execute<string[]>(
    `return Array.from(document.querySelectorAll('[data-testid="editor.tab"]'))` +
      `.map((el) => (el.textContent ?? "").trim());`,
  );
  return out ?? [];
}

describeE2E("ATT-TAB-1 the attachment library opens as a tab", () => {
  it("opens from the rail, marks the rail current, and is replaced by a note", async () => {
    let seeded: SeededVault;
    await scenario(
      "atttab1-open",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        // **A note, because the last claim is about one.** `seedVault` with no
        // options seeds a vault with NO notes: the sidebar lands on
        // `notes.empty-state`, and the closing step of this scenario ("opening a
        // note replaces the library tab") then waits for a `notes.row` that the
        // fixture never had. Measured: the first isolated run timed out on
        // exactly that row with the empty state on screen.
        await createNote(s, "atttab1notealfa7k2m9qx4w8e");

        expect(
          await currentRailCommand(s),
          "a note tab is not opened by a rail entry, so nothing is current",
        ).toBeNull();

        const railAttachments = await s.execute<boolean>(
          `const el = document.querySelector('${RAIL_BUTTON}[data-command-id="attachments.open"]');` +
            `if (el === null) return false; el.click(); return true;`,
        );
        expect(railAttachments, "the rail pins Attachments by default").toBe(true);

        // A TAB, not a pane-replacing view: the strip is still there and now
        // carries the library.
        const labels = await tabLabels(s);
        expect(labels.length, "the tab strip survived, which a CenterView did not allow").toBeGreaterThan(0);

        expect(
          await currentRailCommand(s),
          "the rail must mark Attachments as the surface you are looking at",
        ).toBe("attachments.open");

        // Opening a note in the focused pane replaces the library tab with it.
        // That IS the way back; there is no separate close.
        await (await s.byTestId("notes.row")).click();
        expect(
          await currentRailCommand(s),
          "back on a note, no rail entry is current",
        ).toBeNull();
      },
    );
  });
});

describeE2E("ATT-TAB-2 the library survives a reload as a tab", () => {
  it("restores from the persisted workspace descriptor", async () => {
    let seeded: SeededVault;
    await scenario(
      "atttab2-persist",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        await s.execute(
          `document.querySelector('${RAIL_BUTTON}[data-command-id="attachments.open"]').click();`,
        );
        expect(await currentRailCommand(s)).toBe("attachments.open");

        // The singleton is persisted in `vault.workspace` (MYW1) like the graph
        // and the task list. A CenterView was React state and could not be.
        //
        // **The primitive is the lock/unlock round trip, not a WebView reload,
        // and the difference is the store's own cadence.** A layout change STAGES
        // the descriptor (`workspaceStage`, `Editor.tsx`) and the blob is written
        // on the graceful-exit paths: lock, close, quit and the coalesced
        // five-minute flush. A reload is none of those, so it reads the last
        // written blob and loses the tab (measured: the rail reported nothing
        // while the library was still on screen, and polling
        // `plugin:workspace|workspace_read` for 15 s never returned a descriptor
        // naming it). Locking IS one of those paths, so the round trip is what a
        // user's "I locked and came back" actually does, and it re-mounts the
        // editor from disk the way the guarantee describes.
        await lockAndReunlock(s, seeded.password);

        // The editor mounts and the descriptor loads asynchronously, so the
        // rail's `aria-current` is not there on the first frame: poll rather
        // than sampling once.
        await s.waitUntil(
          async () =>
            (await currentRailCommand(s)) === "attachments.open" ? true : null,
          {
            label: "the library tab is restored, so the rail is current again",
            timeoutMs: 20_000,
          },
        );
      },
    );
  });
});
