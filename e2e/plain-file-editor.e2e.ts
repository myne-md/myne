// The plain-file editor (myne-md/myne#788), end to end through the one
// ingress the harness can drive honestly.
//
//   pf1  a vault-less device, gate on, `myne <file.md>` in argv: the marked
//        surface opens over Welcome, typing autosaves, and the bytes land on
//        disk exactly once.
//   pf2  the same launch with the gate off: nothing opens.
//   pf3  a seeded (locked) vault: the surface still opens over the Unlock
//        screen; an external write raises the conflict banner; Myne writes
//        NOTHING until the user chooses, and Reload adopts the disk text.
//   pf4  a vault-less device with NO gate file: the surface STILL opens,
//        because the gate is on by default (amended 2026-10-01). Absent and
//        false are different states now; pf2 covers the false one.
//
// ## Why argv is the ingress here
//
// On Linux the OS delivers "open this .md with Myne" by launching the binary
// with the file as its argument, and `tauri:options.args` hands the app the
// real bytes of that launch (`theme-deep-link.e2e.ts` records the same
// argument for `myne://`). The native open dialog is undrivable from
// tauri-driver, and the in-app surface it reaches is the same code path.
//
// ## The gate is device-local and written by the test process
//
// `plain-file.json` lives under `app_config_dir`, not in a vault, which is
// what lets pf1 open a file on a device that has never had a vault and pf3
// open one with the vault LOCKED. `seedConfig` writes it both ways (pf2 false,
// pf3 true); pf4 leaves it ABSENT to pin the default-on read. The three are
// genuinely different inputs: absent resolves to enabled, while a malformed or
// unreadable file resolves to disabled (myne-md/myne#788, amended 2026-10-01).
//
// The file the app edits is a real file in the container's `/tmp`, written and
// read by the test process, so "what landed on disk" is asserted against the
// filesystem rather than against Myne's own report of it.

import { expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { typeIntoEditor } from "./support/flows";
import { testIdSelector } from "./support/webdriver";

/** `<app_config_dir>/plain-file.json`: the device-local gate. */
function gatePath(appConfigDir: string): string {
  return join(appConfigDir, "plain-file.json");
}

/** A path the app process can read: the harness shares the container fs. */
function scratchFile(name: string): string {
  return join(process.env.MYNE_E2E_TMPDIR ?? "/tmp", name);
}

describeE2E("plain-file editor", () => {
  it("pf1: a vault-less launch with a file in argv opens the marked surface and autosaves", async () => {
    const file = scratchFile(`myne-plain-pf1-${process.pid}.md`);
    const initial = "# From disk\n\nA line that was here first.\n";
    writeFileSync(file, initial);

    await scenario(
      "pf1-plain-open",
      {
        args: [file],
        seedConfig: (configDir) => {
          writeFileSync(gatePath(configDir), JSON.stringify({ enabled: true }));
        },
      },
      async (app) => {
        // The marker and the tab: the surface is up, and it says what it is.
        await app.session.waitForElement(testIdSelector("plain-file.marker"));
        const tab = await app.session.byTestId("plain-file.tab");
        expect(await tab.text()).toContain("pf1");

        await typeIntoEditor(app.session, "typed by the scenario");

        // The autosave is a debounce; poll the FILE, which is the oracle.
        await app.session.waitUntil(async () => {
          const disk = readFileSync(file, "utf8") as string;
          return disk.includes("typed by the scenario") ? true : null;
        });

        const disk = readFileSync(file, "utf8") as string;
        expect(disk).toContain("A line that was here first.");
        expect(disk).not.toContain("typed by the scenario\n\n\n");
      },
    );
  });

  it("pf2: with the gate off the same launch opens nothing", async () => {
    const file = scratchFile(`myne-plain-pf2-${process.pid}.md`);
    writeFileSync(file, "# Not for you\n");

    await scenario(
      "pf2-gate-off",
      {
        args: [file],
        seedConfig: (configDir) => {
          writeFileSync(gatePath(configDir), JSON.stringify({ enabled: false }));
        },
      },
      async (app) => {
        // The Welcome screen is the vault-less boot stage; wait for it, then
        // assert the surface never appeared. A wait-for-element would pass on
        // the wrong thing here, so the assertion is the absence.
        await app.session.waitForElement(
          `${testIdSelector("welcome.create-cta")}, ${testIdSelector("welcome.identity-cta")}`,
        );
        const markers = await app.session.byTestIdAll("plain-file.marker");
        expect(markers).toHaveLength(0);
        expect(readFileSync(file, "utf8")).toBe("# Not for you\n");
      },
    );
  });

  it("pf3: a locked vault still opens the surface; an external write raises the conflict banner", async () => {
    const file = scratchFile(`myne-plain-pf3-${process.pid}.md`);
    writeFileSync(file, "# Mine\n");

    await scenario(
      "pf3-plain-conflict",
      {
        args: [file],
        seed: (appDataDir) => {
          seedVault(appDataDir);
        },
        seedConfig: (configDir) => {
          writeFileSync(gatePath(configDir), JSON.stringify({ enabled: true }));
        },
      },
      async (app) => {
        // Q3's locked-vault arm: the surface opens OVER the Unlock screen.
        await app.session.waitForElement(testIdSelector("plain-file.marker"));

        await typeIntoEditor(app.session, "first edit");
        await app.session.waitUntil(async () => {
          const disk = readFileSync(file, "utf8") as string;
          return disk.includes("first edit") ? true : null;
        });

        // Somebody else writes the file while the surface holds it.
        const theirs = "# Theirs\n";
        writeFileSync(file, theirs);

        // The next autosave must refuse rather than clobber.
        await typeIntoEditor(app.session, "second edit");
        await app.session.waitForElement(testIdSelector("plain-file.conflict"));
        expect(readFileSync(file, "utf8")).toBe(theirs);

        // Reload adopts what is on disk.
        await (await app.session.byTestId("plain-file.conflict.reload")).click();
        await app.session.waitUntil(async () => {
          const disk = readFileSync(file, "utf8") as string;
          if (!disk.includes("Theirs")) return null;
          return disk.includes("first edit") || disk.includes("second edit")
            ? null
            : true;
        });
        expect(readFileSync(file, "utf8")).toBe(theirs);
      },
    );
  });

  it("pf4: with NO gate file the surface opens (the feature is on by default)", async () => {
    const file = scratchFile(`myne-plain-pf4-${process.pid}.md`);
    writeFileSync(file, "# Default on\n");

    await scenario(
      "pf4-default-on",
      {
        args: [file],
        // No `seedConfig`: the device has never written `plain-file.json`, and
        // an absent gate resolves to ENABLED. This is the half pf2 does not
        // cover, because absent and false are different states (amended
        // 2026-10-01).
      },
      async (app) => {
        await app.session.waitForElement(testIdSelector("plain-file.marker"));
        const tab = await app.session.byTestId("plain-file.tab");
        expect(await tab.text()).toContain("pf4");
      },
    );
  });
});
