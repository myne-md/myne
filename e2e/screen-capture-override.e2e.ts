// The pre-unlock escape hatch from screen-capture protection
// (myne-md/myne#482), at the five places a locked-out user meets it.
//
//   sc1  a fresh install: the escape is reachable by KEYBOARD from a cold boot
//        while being invisible, and taking it writes the device-local file.
//   sc2  a device that already opted out: the override survives a restart and
//        the same control offers the way back.
//   sc3  a run launched with `--disable-screen-capture-protection`: the flag is
//        reported apart from the file, and clearing the file does not clear it.
//   sc4  the same flag run over a PERSISTED override: restoring protection
//        records the intent for the next launch and does not overwrite the
//        file's `true` with the flag's answer, which is the data-loss defect
//        the short-circuited startup resolution shipped.
//   sc5  the Unlock screen specifically: the password field is autofocused, so
//        the route to the escape there is Shift+Tab rather than Tab, and it is
//        the screen carrying the account number.
//
// ## READ THIS BEFORE CHANGING AN ASSERTION HERE
//
// This harness is Linux-only (tauri-driver has no macOS support, SYNC-1), and
// `tauri::WebviewWindow::set_content_protected` is a compile-time no-op on Linux:
// tao gates it to macOS and Windows, and Tauri answers `Ok(())` regardless. So
// **nothing here proves the native state**, and it cannot: `decisions.md`
// 0378 already records that the native side is not E2E-observable, because
// `set_content_protected` is window state WebDriver cannot read.
//
// What IS proven here is everything on this side of that call, and it is the
// half a user actually meets:
//
//   * the control exists on a pre-unlock screen, is in the tab order, and is
//     off-screen until it takes focus. The property the whole design rests on,
//     since a magnifier user sees a black rectangle while a screen reader does
//     not;
//   * nothing is written until an explicit confirmation (the issue's acceptance
//     criterion, asserted by reading the filesystem rather than by the command's
//     Ok);
//   * the file is device-local, lands under `app_config_dir` and NOT in any
//     vault, and carries the boolean rather than anything else;
//   * a restart honours it, which is the difference between an escape hatch and
//     a per-session workaround;
//   * the process flag and the file are reported apart, so a flag-launched run
//     cannot be told "protection is back on" over a window that is still
//     capturable.
//
// Vault-count precondition: 0 in sc1 through sc4 (a fresh install is the case
// the issue is worst in. A first-run user reading a recovery phrase they cannot
// see), and the override is device-wide, so it needs no vault to exist. sc5 is
// the exception and seeds one, because the Unlock screen is the thing it is
// about: without a vault the app never routes there.
// SYNC-13: nothing here touches a password, a phrase or an account number.

import { expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { screenCaptureOverridePath, seedVault } from "./support/fixtures";
import { ipcOk } from "./support/flows";
import { activeTestId, tab, tabToTestId } from "./support/keyboard";
import { testIdSelector, type Session } from "./support/webdriver";

const TRIGGER = "screen-capture-escape.trigger";
const DIALOG = "screen-capture-escape.dialog";
const CONFIRM = "screen-capture-escape.confirm";
const CANCEL = "screen-capture-escape.cancel";
const FLAG_NOTICE = "screen-capture-escape.flag-notice";

const GET = "plugin:screen-capture|screen_capture_override_get";
const SET = "plugin:screen-capture|screen_capture_override_set";

interface OverrideView {
  disabled: boolean;
  via_flag: boolean;
  effective: boolean;
}

/** Read the override through the production command, on a locked screen. This
 *  doubles as the ACL check for `screen-capture:allow-screen-capture-override-get`
 *  pre-unlock, which is the only place it matters. */
async function readOverride(s: Session): Promise<OverrideView> {
  return (await ipcOk(s, GET)) as OverrideView;
}

/** What is actually on disk, or `null` when nothing has been written. */
function fileOnDisk(appConfigDir: string): { disabled?: boolean } | null {
  const path = screenCaptureOverridePath(appConfigDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as { disabled?: boolean };
}

/**
 * Open the escape dialog.
 *
 * **The focus is not decoration.** At rest the trigger is a 1x1 `position:
 * fixed` box at (0,0) whose only paint is `clip-path: inset(50%)`, so its
 * hit-test area is empty and a W3C Element Click can never land on it: the
 * harness would poll "not hit-testable yet" until its budget ran out, which
 * reads as a dead surface rather than as a test driving a hidden control. Tab
 * reveals it, which is also the path a real locked-out user takes.
 */
async function openEscape(s: Session): Promise<void> {
  const reached = await tabToTestId(s, TRIGGER);
  expect(reached, "the escape must be reachable by Tab, that is the design").toBe(true);
  // Focus is on the button, but React's onFocus setState has not necessarily
  // committed the FOCUSED_TRIGGER_STYLE yet. Until it does the button is still
  // the resting 1x1 clip-path box and a W3C click polls "not hit-testable".
  //
  // After a Cancel the trap restores focus with `.focus()`. When that restore
  // does not re-fire React's onFocus (focus already on the element, or the
  // handler ran while the dialog's unmount still owned the commit),
  // `tabToTestId` sees the active element and returns true WITHOUT pressing
  // Tab, the style stays clipped, and this wait times out. Re-fire focus by
  // hand when the active element is already the trigger but the paint says
  // otherwise — the same path a sighted user takes by clicking away and back.
  const paint = async (): Promise<boolean> => {
    const style = (await (await s.byTestId(TRIGGER)).attribute("style")) ?? "";
    return !style.includes("clip-path");
  };
  if (!(await paint())) {
    await s.execute(
      "var el = document.activeElement;" +
        "var t = document.querySelector('[data-testid=\"screen-capture-escape.trigger\"]');" +
        "if (el && el.blur) el.blur();" +
        "if (t && t.focus) t.focus();",
    );
  }
  await s.waitUntil(paint, {
    label: "the escape to paint its focused (unclipped) style after Tab",
    timeoutMs: 5_000,
  });
  await (await s.byTestId(TRIGGER)).click();
  await s.byTestId(DIALOG);
}

describeE2E("sc1 the escape is keyboard-reachable and consented (myne#482)", () => {
  // Vault-count precondition: 0 (a fresh install, which is the worst case in
  // the issue: a first-run user cannot read a recovery phrase they cannot see).
  it("is in the tab order while invisible, and writes nothing until confirmed", async () => {
    await scenario("sc1-escape-keyboard-and-consent", {}, async (app) => {
      const s = app.session;
      await s.byTestId("welcome.root", { timeoutMs: 20_000 });

      // Nobody has opted out: the shipped state of every install.
      expect(await readOverride(s)).toEqual({
        disabled: false,
        via_flag: false,
        effective: false,
      });
      expect(fileOnDisk(app.appConfigDir)).toBeNull();

      // The control is in the DOM on a pre-unlock screen, and it is CLIPPED
      // rather than removed. `display: none` / `visibility: hidden` would take
      // it out of the accessibility tree too, which would strand the screen
      // reader user who can still read this window perfectly well.
      const trigger = await s.byTestId(TRIGGER);
      const resting = (await trigger.attribute("style")) ?? "";
      expect(resting).toContain("clip-path: inset(50%)");
      expect(resting).not.toContain("display: none");
      expect(resting).not.toContain("visibility: hidden");

      // ONE Tab from a cold boot. This is the assertion that makes the design
      // work: it is first in DOM order precisely so a user who sees nothing can
      // find it without knowing it is there.
      await tab(s);
      expect(await activeTestId(s)).toBe(TRIGGER);
      // And focusing it draws it, so a sighted helper can see what the person
      // asking for help just landed on.
      expect((await (await s.byTestId(TRIGGER)).attribute("style")) ?? "").not.toContain(
        "clip-path: inset(50%)",
      );

      // Opening the dialog is not consenting to anything. (Still focused from
      // the Tab above, so a direct click lands; every later one goes through
      // `openEscape`, which re-focuses first.)
      await (await s.byTestId(TRIGGER)).click();
      await s.byTestId(DIALOG);
      expect(fileOnDisk(app.appConfigDir)).toBeNull();

      // Neither is backing out of it.
      await (await s.byTestId(CANCEL)).click();
      await s.waitForGone(testIdSelector(DIALOG));
      expect(fileOnDisk(app.appConfigDir)).toBeNull();

      // Confirming is. Cancel blurred the trigger back to its clipped state,
      // so this one has to re-focus.
      await openEscape(s);
      await (await s.byTestId(CONFIRM)).click();
      await s.waitForGone(testIdSelector(DIALOG));

      // Asserted on the medium, not on the command's Ok: what makes this an
      // escape hatch rather than a session workaround is the byte on disk.
      await s.waitUntil(
        async () => (fileOnDisk(app.appConfigDir)?.disabled === true ? true : null),
        { label: "screen-capture.json written", timeoutMs: 10_000 },
      );
      expect(await readOverride(s)).toEqual({
        disabled: true,
        via_flag: false,
        effective: true,
      });

      // Device-local: under app_config_dir, beside the other three
      // (`tor-routing.json`, `vault-names.json`, `ai-endpoint.json`), and NOT
      // inside any vault. A file in a vault directory would sync.
      // Asserted where the file is NOT, because that is the half that can
      // fail. `screenCaptureOverridePath` is `join(appConfigDir, ...)`, so a
      // line checking its output contains `appConfigDir` restates its own
      // input and passes no matter what the code does.
      expect(existsSync(screenCaptureOverridePath(app.appDataDir))).toBe(false);
      const vaultsDir = join(app.appDataDir, "vaults");
      // Annotated rather than inferred: `@types/node` is not a dependency, so
      // `readdirSync` is untyped here and `id` would be an implicit any, which
      // `check-test-typecheck.mjs` counts. That guard is the only reporter for
      // this tree, since `tsconfig.json` is `include: ["src"]`.
      const vaultIds: string[] = existsSync(vaultsDir) ? readdirSync(vaultsDir) : [];
      const strayInAVault = vaultIds.filter((id) =>
        existsSync(join(vaultsDir, id, "screen-capture.json")),
      );
      expect(strayInAVault, "the override must not land in any vault").toEqual([]);

      // And the label now offers the way back, which is what stops the escape
      // being one-way for a user who took it by accident.
      await s.waitUntil(
        async () => {
          const t = await s.byTestId(TRIGGER);
          return (await t.attribute("data-override")) === "true" ? true : null;
        },
        { label: "trigger flipped to restore", timeoutMs: 10_000 },
      );
    });
  });
});

describeE2E("sc2 the override survives a restart (myne#482)", () => {
  // Vault-count precondition: 0. The override is device-wide; no vault needed.
  it("boots honouring a pre-existing file and offers the way back", async () => {
    await scenario(
      "sc2-escape-survives-restart",
      {
        // Seeded rather than written by a first launch: this is the SECOND
        // process, and the property under test is that a cold start reads the
        // file before the first frame.
        seedConfig: (dir) => {
          writeFileSync(
            screenCaptureOverridePath(dir),
            JSON.stringify({ disabled: true }, null, 2),
          );
        },
      },
      async (app) => {
        const s = app.session;
        await s.byTestId("welcome.root", { timeoutMs: 20_000 });

        expect(await readOverride(s)).toEqual({
          disabled: true,
          via_flag: false,
          effective: true,
        });

        expect(
          await (await s.byTestId(TRIGGER)).attribute("data-override"),
        ).toBe("true");

        // Turning it back on writes `false` rather than removing the file: an
        // absent file and `disabled: false` mean the same thing to the reader,
        // and rewriting is the cheaper of the two to get right.
        await openEscape(s);
        await (await s.byTestId(CONFIRM)).click();
        await s.waitForGone(testIdSelector(DIALOG));
        await s.waitUntil(
          async () => (fileOnDisk(app.appConfigDir)?.disabled === false ? true : null),
          { label: "override cleared on disk", timeoutMs: 10_000 },
        );
        expect(await readOverride(s)).toEqual({
          disabled: false,
          via_flag: false,
          effective: false,
        });
      },
    );
  });
});

describeE2E("sc3 the process flag is reported apart from the file (myne#482)", () => {
  // Vault-count precondition: 0. Models the remote-support case: somebody reads
  // the flag out over the phone to a user who cannot see their own screen.
  it("cannot be cleared by the setting, and says so", async () => {
    await scenario(
      "sc3-escape-process-flag",
      { args: ["--disable-screen-capture-protection"] },
      async (app) => {
        const s = app.session;
        await s.byTestId("welcome.root", { timeoutMs: 20_000 });

        // The file says nothing and the window is unprotected anyway. A single
        // boolean would collapse these two and make every surface below lie.
        expect(fileOnDisk(app.appConfigDir)).toBeNull();
        expect(await readOverride(s)).toEqual({
          disabled: false,
          via_flag: true,
          effective: true,
        });

        // The dialog says so, so the offer is not misread as "protection is on",
        // and the control still offers to SET the override rather than only to
        // clear it. Keying that off `effective` instead of the file left a
        // flag-launched user unable to persist anything, so they had to re-pass
        // the flag on every launch forever.
        await openEscape(s);
        await s.byTestId(FLAG_NOTICE);
        expect(
          await (await s.byTestId(TRIGGER)).attribute("data-override"),
        ).toBe("false");
        await (await s.byTestId(CONFIRM)).click();
        await s.waitUntil(
          async () => (fileOnDisk(app.appConfigDir)?.disabled === true ? true : null),
          { label: "override persisted under the flag", timeoutMs: 10_000 },
        );

        // Writing `false` records the intent for the next launch and changes
        // nothing about this one. The failure this rules out is a control that
        // reports success and leaves the window exactly as capturable.
        const after = (await ipcOk(s, SET, { disabled: false })) as OverrideView;
        expect(after).toEqual({ disabled: false, via_flag: true, effective: true });
        expect(fileOnDisk(app.appConfigDir)).toEqual({ disabled: false });
      },
    );
  });
});

describeE2E("sc4 a flag-launched run honours what the file already said (myne#482)", () => {
  // Vault-count precondition: 0. The regression: the startup resolution used to
  // short-circuit on the flag and never read the file, so a persisted `true`
  // reported as `false`, the escape offered only "restore", and confirming
  // replaced it with `false`. The next launch without the flag then put the
  // black window back in front of the account number and the recovery-phrase
  // ceremony, which is the lockout the whole feature exists to open.
  it("reports the persisted value rather than assuming nothing was persisted", async () => {
    await scenario(
      "sc4-escape-flag-over-persisted-file",
      {
        args: ["--disable-screen-capture-protection"],
        seedConfig: (dir) => {
          writeFileSync(
            screenCaptureOverridePath(dir),
            JSON.stringify({ disabled: true }, null, 2),
          );
        },
      },
      async (app) => {
        const s = app.session;
        await s.byTestId("welcome.root", { timeoutMs: 20_000 });

        // Both sources true, and reported apart. `disabled: false` here would
        // be the defect: the file plainly says otherwise.
        expect(await readOverride(s)).toEqual({
          disabled: true,
          via_flag: true,
          effective: true,
        });
        expect(
          await (await s.byTestId(TRIGGER)).attribute("data-override"),
        ).toBe("true");

        // And the file is untouched by merely having been read.
        expect(fileOnDisk(app.appConfigDir)).toEqual({ disabled: true });
      },
    );
  });
});

describeE2E("sc5 the escape is one Shift+Tab from the unlock screen (myne#482)", () => {
  // Vault-count precondition: 1 (weak KDF). The Welcome-screen assertions above
  // cover the case where the claim cannot fail: nothing is autofocused there, so
  // the first Tab trivially lands on the first focusable element. `Unlock` is the
  // screen the lockout is actually about, and it DOES autofocus the password
  // field, so the design's own wording ("one Tab, or one Shift+Tab from the
  // autofocused password field") is only verified here.
  it("is reachable backwards from the autofocused password field", async () => {
    await scenario(
      "sc5-escape-from-unlock",
      { seed: (dir) => void seedVault(dir, { password: "e2e-sc5-unlock-pw" }) },
      async (app) => {
        const s = app.session;
        await s.byTestId("unlock.form", { timeoutMs: 20_000 });

        // The password field holds focus on arrival. Asserted rather than
        // assumed: if that ever stops being true, the Shift+Tab claim below is
        // measuring something else.
        await s.waitUntil(
          async () =>
            (await activeTestId(s)) === "unlock.password-input" ? true : null,
          { label: "password field autofocused", timeoutMs: 10_000 },
        );

        await tab(s, { shift: true });
        expect(await activeTestId(s)).toBe(TRIGGER);
      },
    );
  });
});
