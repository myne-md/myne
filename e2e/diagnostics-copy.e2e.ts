// The opt-in diagnostic log and the bug-report surface (myne-md/myne#860).
//
// PRECONDITION: exactly ONE vault (the fixture seeds one and never opens the
// picker). `e2e/AGENTS.md` makes the count a per-scenario declaration because a
// >=2-vault fixture routes to the picker stage, and an undeclared one is how a
// scenario turns into three 45-second waits reported as a timeout on an element.
//
// WHY THIS SCENARIO EXISTS. The feature's whole value is one flow: turn the log
// on, hit a bug, produce a report. Everything it depends on is host-side and
// none of it is visible to Vitest — the ACL entry that authorizes each command,
// the `generate_handler!` registration that no tool verifies, the device-local
// flag file the sink reads at startup, and the fact that the About surface is
// assembled from a hook that talks to a plugin. A command with its permission
// block, its capability grant and its UI, but missing from `generate_handler!`,
// compiles, passes clippy, renders and is dead at runtime
// (`src-tauri/AGENTS.md`, MYND-441); the only thing that catches it is a real
// invoke over real IPC.
//
// It is also the scenario myne-md/myne#554 already owed for this surface, so it
// closes a debt rather than adding to one.
//
// WHY IT LIVES IN `e2e/` AND NOT `e2e-web/`. The feature is a shared-tree
// desktop flow: the web verdict for it is `adapted` (copy-only), and there is no
// web-specific behaviour here to drive. Per the root AGENTS.md the web lane owes
// this change nothing.
//
// WHY IT ASSERTS PRESENCE, THE TOGGLE'S OWN STATE, AND THE BLOCK'S CONTENT, and
// not the clipboard BY VALUE. `tauri-driver` drives W3C WebDriver against the
// app's WebView; it has no clipboard read, and a scenario that claimed to
// compare clipboard contents would be claiming something it did not do. What is
// asserted instead is that the affordance exists, that the switch really flips
// the device-local flag (its `aria-checked` follows the host's answer, so a
// handler missing from `generate_handler!` leaves it stuck), and that the block
// the surface previews is the real block rather than an empty string.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import type { Session } from "./support/webdriver";

/** `aria-checked` on the Switch primitive, which is what drives both state and paint. */
async function toggleState(s: Session): Promise<string | null> {
  const el = await s.byTestId("about.diagnostic-log-toggle");
  // The driver's element facade exposes `attribute`, not the DOM's
  // `getAttribute`; `tsconfig.tests.json` is the only thing that checks these
  // trees, since `tsconfig.json` is `include: ["src"]`.
  return await el.attribute("aria-checked");
}

async function blockPreview(s: Session): Promise<string> {
  const el = await s.byTestId("about.diagnostic-block-preview");
  return (await el.textContent()) ?? "";
}

describeE2E("diagnostic log and bug report", () => {
  it("dl1 — the switch is off, the block is real, and flipping it lands", async () => {
    let password = "";
    await scenario(
      "dl1-diagnostic-log-toggle",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await openSettings(s, "about");

        // The row renders, which is itself the ACL half: this panel is assembled
        // from a hook that invokes `plugin:diagnostics|diagnostic_log_enabled_get`
        // on mount, so a missing grant or registration leaves it at the loading
        // default with no error anywhere.
        await s.byTestId("about.diagnostic-log-toggle");

        // Off on a fresh profile, and the flag is read from a file this profile
        // has never written.
        await s.waitUntil(
          async () => ((await toggleState(s)) === "false" ? true : null),
          { label: "the log switch settles to off", timeoutMs: 15_000 },
        );

        // The block is the real nine-field allowlist document, not a placeholder.
        // `textContent` rather than `text()`: the driver's getText returns only
        // what is VISIBLE, and a tall preview is clipped by the modal's scroll
        // container (the trap `beta-terms-consent.e2e.ts` documents).
        const block = await blockPreview(s);
        expect(block).toContain("version:");
        expect(block).toContain("failureCode:");
        expect(block).toContain("engine:");

        // Turning it on is a write through the plugin, so the state coming back
        // as `true` is evidence the setter ran over IPC and the getter re-read
        // what it wrote.
        await (await s.byTestId("about.diagnostic-log-toggle")).click();
        await s.waitUntil(
          async () => ((await toggleState(s)) === "true" ? true : null),
          { label: "the log switch reports on", timeoutMs: 15_000 },
        );

        // Turning it off is the erase path, and it goes through the same
        // command; a failure there surfaces as the row's error text.
        await (await s.byTestId("about.diagnostic-log-toggle")).click();
        await s.waitUntil(
          async () => ((await toggleState(s)) === "false" ? true : null),
          { label: "the log switch reports off", timeoutMs: 15_000 },
        );
      },
    );
  });

  it("dl2 — the report actions are present, and no crash record is claimed", async () => {
    let password = "";
    await scenario(
      "dl2-diagnostic-report-actions",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await openSettings(s, "about");

        // Reveal and Save are the two ways a log leaves the device. Reveal is
        // the one whose path must never come from page context, and Save is the
        // one that writes a plaintext bundle to a destination the user chose, so
        // both are host commands and both are on this row.
        await s.byTestId("about.diagnostic-reveal");
        await s.byTestId("about.diagnostic-save");

        // The manifest says what a bundle would contain. Asserted only for
        // presence: the count and the size depend on how much the app logged
        // during this run, and a scenario that pinned a number would be pinning
        // a fact about the harness rather than about the feature.
        await s.byTestId("about.diagnostic-files-manifest");

        // No crash record this run, so the row that shows one is absent rather
        // than disabled: "no crash" is not a control. A build that rendered it
        // anyway would be claiming a crash that did not happen.
        expect((await s.byTestIdAll("about.crash-record-clear")).length).toBe(0);
      },
    );
  });
});
