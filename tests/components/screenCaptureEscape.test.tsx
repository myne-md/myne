// @vitest-environment jsdom
//
// The pre-unlock escape hatch from screen-capture protection
// (myne-md/myne#482), and the Privacy row that mirrors it.
//
// Four things are worth a test here, and "does the switch flip" is not one of
// them.
//
// 1. **It is reachable by keyboard while being invisible.** That combination is
//    the whole design: `SetWindowDisplayAffinity` blacks out what the
//    compositor hands to capture without touching the accessibility tree, so a
//    screen reader still reads the control and a magnifier user sees nothing.
//    A control hidden with `display: none` or `visibility: hidden` would leave
//    the tree too and strand the reader it exists for.
// 2. **Turning it off is consented, never a side effect of finding it.** The
//    acceptance criterion on the issue asks for exactly this: nothing is
//    written until the user confirms in a dialog that states the cost.
// 3. **A flag-launched run says so.** The process flag has an empty file and an
//    unprotected window; a surface that read only the file would offer to turn
//    protection back on, write `disabled: false`, and change nothing visible.
// 4. **The per-vault switch goes inert while the device override is on.** Two
//    live controls over one native state is how a settings screen comes to
//    disagree with the window beside it.
//
// Copy is asserted through the catalog rather than pasted, so wording stays the
// catalog's business; what is pinned is the behaviour, which no translation may
// cross either.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
// The capability seam, mocked so this suite can render the panel as a client
// with no capture affinity sees it. `capabilityPresent` is flipped per test.
let capabilityPresent = true;
vi.mock("../../src/platform/capabilities", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    has: (name: string) =>
      name === "screenCaptureProtection"
        ? capabilityPresent
        : (actual.has as (n: string) => boolean)(name),
  };
});

vi.mock("../../src/platform/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [])),
}));

const { ScreenCaptureEscape } = await import(
  "../../src/components/ScreenCaptureEscape"
);
const { PrivacyPanel } = await import("../../src/components/settings/PrivacyPanel");
const { SETTINGS_SEARCH_INDEX } = await import(
  "../../src/components/settings/search/settingsSearchIndex"
);
const { resetScreenCaptureOverrideForTest } = await import(
  "../../src/hooks/useScreenCaptureOverride"
);
const i18n = (await import("../../src/i18n")).default;

const t = (key: string): string => i18n.t(key);

const GET = "plugin:screen-capture|screen_capture_override_get";
const SET = "plugin:screen-capture|screen_capture_override_set";

interface View {
  disabled: boolean;
  via_flag: boolean;
  effective: boolean;
}

const OFF: View = { disabled: false, via_flag: false, effective: false };

/** Drive IPC by command name; anything unstubbed rejects loudly, so a renamed
 *  command fails here instead of quietly resolving `undefined`. */
function stub(overrides: Partial<Record<string, () => Promise<unknown>>> = {}) {
  invokeMock.mockImplementation((cmd: string) => {
    const override = overrides[cmd];
    if (override) return override();
    switch (cmd) {
      case GET:
        return Promise.resolve(OFF);
      case "plugin:prefs|prefs_read":
        return Promise.resolve({});
      case "plugin:vault-label|hide_vault_names":
        return Promise.resolve({ hidden: false });
      case "plugin:vault-label|vault_label_keychain_status":
        return Promise.resolve({ available: true });
      default:
        return Promise.reject(new Error(`unstubbed command: ${cmd}`));
    }
  });
}

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  // The override view is a MODULE-level cell shared by both surfaces (that is
  // the point of it), so a spec that did not reset it would read the previous
  // spec's answer and pass for the wrong reason.
  resetScreenCaptureOverrideForTest();
});

describe("pre-unlock escape: reachable without being visible", () => {
  it("renders a focusable trigger that is off-screen until it takes focus", async () => {
    stub();
    render(<ScreenCaptureEscape />);
    const trigger = await screen.findByTestId("screen-capture-escape.trigger");

    // Off-screen, and still in the tree: `clipPath` rather than `display: none`
    // or `visibility: hidden`, either of which would remove it from the
    // accessibility tree and hide it from the screen-reader user it is for.
    expect(trigger.style.clipPath).toBe("inset(50%)");
    expect(trigger.style.display).not.toBe("none");
    expect(trigger.style.visibility).not.toBe("hidden");
    // Focusable: a real button, never `tabIndex={-1}`.
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("tabindex")).toBeNull();

    // A real `.focus()`, not `fireEvent.focus`: the component syncs `focused`
    // from `document.activeElement` in a layout effect (so a Cancel-restore that
    // does not re-fire React's onFocus still paints). `fireEvent.focus` dispatches
    // the event without moving focus, so that sync immediately flips `focused`
    // back to false and the clip never lifts, which is why this failed on CI
    // while the resting assertions above still passed.
    trigger.focus();
    await waitFor(() => expect(trigger.style.clipPath).toBe(""));
    expect(trigger.textContent).toBe(t("screenCaptureEscape.disableTrigger"));
  });

  it("writes nothing until the user confirms in the dialog", async () => {
    stub();
    render(<ScreenCaptureEscape />);
    fireEvent.click(await screen.findByTestId("screen-capture-escape.trigger"));

    // The dialog is up, the cost is stated, and no write has happened.
    expect(await screen.findByTestId("screen-capture-escape.dialog")).toBeTruthy();
    expect(
      screen.getByText(t("screenCaptureEscape.disableCost")),
    ).toBeTruthy();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === SET)).toBe(false);

    fireEvent.click(screen.getByTestId("screen-capture-escape.confirm"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(SET, { disabled: true }),
    );
  });

  it("cancelling writes nothing at all", async () => {
    stub();
    render(<ScreenCaptureEscape />);
    fireEvent.click(await screen.findByTestId("screen-capture-escape.trigger"));
    fireEvent.click(await screen.findByTestId("screen-capture-escape.cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("screen-capture-escape.dialog")).toBeNull(),
    );
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === SET)).toBe(false);
  });

  it("offers the way back when the override is already on", async () => {
    stub({
      [GET]: () =>
        Promise.resolve({ disabled: true, via_flag: false, effective: true }),
    });
    render(<ScreenCaptureEscape />);
    const trigger = await screen.findByTestId("screen-capture-escape.trigger");
    await waitFor(() =>
      expect(trigger.getAttribute("data-override")).toBe("true"),
    );
    expect(trigger.textContent).toBe(t("screenCaptureEscape.restoreTrigger"));

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("screen-capture-escape.confirm"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(SET, { disabled: false }),
    );
  });

  it("says the process flag is in force, so the offer is not misread", async () => {
    // The file is empty and the window is unprotected. Without this the dialog
    // would read as "protection is on, turn it off" over a window that is
    // already capturable.
    stub({
      [GET]: () =>
        Promise.resolve({ disabled: false, via_flag: true, effective: true }),
    });
    render(<ScreenCaptureEscape />);
    fireEvent.click(await screen.findByTestId("screen-capture-escape.trigger"));
    expect(
      await screen.findByTestId("screen-capture-escape.flag-notice"),
    ).toBeTruthy();
  });

  it("reports a failed write instead of closing on it", async () => {
    stub({ [SET]: () => Promise.reject({ kind: "Io" }) });
    render(<ScreenCaptureEscape />);
    fireEvent.click(await screen.findByTestId("screen-capture-escape.trigger"));
    fireEvent.click(await screen.findByTestId("screen-capture-escape.confirm"));

    // The CONTENT, not the node: `ActionStatus` is persistently mounted with
    // `message={null}` for as long as the dialog is open, so asserting the node
    // exists passes on every path. Injecting `false` for the `status ===
    // "failed"` condition left all 18 cases green, which is how this was found.
    await waitFor(() =>
      expect(
        screen.getByTestId("screen-capture-escape.status").textContent,
      ).toBe(t("screenCaptureEscape.saveFailed")),
    );
    // Still open: the window is unchanged, and a silent close would leave the
    // user looking at the same black rectangle with no reason given.
    expect(screen.getByTestId("screen-capture-escape.dialog")).toBeTruthy();
  });

  it("on a flag-launched run it offers what the FILE says, not what the window is doing", async () => {
    // The regression this exists for. The startup resolution used to skip the
    // file read whenever the flag was set, so a persisted `true` reported as
    // `false`, the escape offered only "restore", and confirming wrote `false`
    // over it. The next launch without the flag then put the black window back
    // in front of the account number and the recovery-phrase ceremony.
    stub({
      [GET]: () =>
        Promise.resolve({ disabled: true, via_flag: true, effective: true }),
    });
    render(<ScreenCaptureEscape />);
    const trigger = await screen.findByTestId("screen-capture-escape.trigger");
    await waitFor(() =>
      expect(trigger.getAttribute("data-override")).toBe("true"),
    );
    expect(trigger.textContent).toBe(t("screenCaptureEscape.restoreTrigger"));
  });

  it("a flag-launched run with nothing persisted still lets the override be SET", async () => {
    // The mirror half. Keying off `effective` left only "restore" on offer, so
    // a locked-out user could never persist the override and had to re-pass the
    // flag on every launch forever.
    stub({
      [GET]: () =>
        Promise.resolve({ disabled: false, via_flag: true, effective: true }),
    });
    render(<ScreenCaptureEscape />);
    const trigger = await screen.findByTestId("screen-capture-escape.trigger");
    await waitFor(() =>
      expect(trigger.getAttribute("data-override")).toBe("false"),
    );
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("screen-capture-escape.confirm"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(SET, { disabled: true }),
    );
  });

  it("a restore under the flag reports the next launch rather than closing", async () => {
    // Dialog dismissal is this flow's only success signal, so closing here
    // would tell the user protection is back over a window that stays
    // capturable for the rest of the session.
    stub({
      [GET]: () =>
        Promise.resolve({ disabled: true, via_flag: true, effective: true }),
      [SET]: () =>
        Promise.resolve({ disabled: false, via_flag: true, effective: true }),
    });
    render(<ScreenCaptureEscape />);
    fireEvent.click(await screen.findByTestId("screen-capture-escape.trigger"));
    fireEvent.click(await screen.findByTestId("screen-capture-escape.confirm"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(SET, { disabled: false }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("screen-capture-escape.status").textContent,
      ).toBe(t("screenCaptureEscape.savedForNextLaunch")),
    );
    expect(screen.getByTestId("screen-capture-escape.dialog")).toBeTruthy();
  });

  it("does not re-offer the opposite action under its own success message", async () => {
    // The write that produces `savedForNextLaunch` flips `view.disabled` to
    // false, so every control keyed off it re-rendered INVERTED: the person who
    // had just turned protection back on was looking at "Turn protection off"
    // under "Saved", one Enter press from undoing it. Asserted as the ABSENCE
    // of the confirm control rather than as its label, because a relabelled
    // button that still fires `apply(true)` is the same defect.
    stub({
      [GET]: () =>
        Promise.resolve({ disabled: true, via_flag: true, effective: true }),
      [SET]: () =>
        Promise.resolve({ disabled: false, via_flag: true, effective: true }),
    });
    render(<ScreenCaptureEscape />);
    fireEvent.click(await screen.findByTestId("screen-capture-escape.trigger"));
    fireEvent.click(await screen.findByTestId("screen-capture-escape.confirm"));
    await waitFor(() =>
      expect(
        screen.getByTestId("screen-capture-escape.status").textContent,
      ).toBe(t("screenCaptureEscape.savedForNextLaunch")),
    );

    expect(screen.queryByTestId("screen-capture-escape.confirm")).toBeNull();
    // The title stays the one the user opened, not the inverted one.
    expect(screen.getByText(t("screenCaptureEscape.restoreTitle"))).toBeTruthy();
    expect(screen.queryByText(t("screenCaptureEscape.disableBody"))).toBeNull();
    // The one control left dismisses, and it writes nothing on the way out.
    const setCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === SET).length;
    fireEvent.click(screen.getByTestId("screen-capture-escape.cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("screen-capture-escape.dialog")).toBeNull(),
    );
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === SET)).toHaveLength(
      setCalls,
    );
  });

  it("still offers the escape when the override could not be read", async () => {
    // The person who needs this is the one who cannot see what went wrong, so a
    // failed read must not remove the control.
    stub({ [GET]: () => Promise.reject({ kind: "Parse" }) });
    render(<ScreenCaptureEscape />);
    expect(
      await screen.findByTestId("screen-capture-escape.trigger"),
    ).toBeTruthy();
  });
});

describe("Privacy panel: one switch, two stores (myne-md/myne#482)", () => {
  const PREFS_SET = "plugin:prefs|set_screen_capture_protection";

  /** Index of the first invocation of `cmd`, or -1. */
  function callIndex(cmd: string): number {
    return invokeMock.mock.calls.findIndex(([c]) => c === cmd);
  }

  it("turns BOTH halves off, device file first", async () => {
    // The merge this spec exists for: the setting used to render as two peer
    // rows, which read as one setting duplicated. ORDER is asserted rather than
    // only the pair, because the device file is what governs the window
    // immediately and what the pre-unlock surface reads. It goes first, and a
    // failure there writes nothing anywhere.
    stub({
      [SET]: () =>
        Promise.resolve({ disabled: true, via_flag: false, effective: true }),
      [PREFS_SET]: () => Promise.resolve(undefined),
    });
    render(<PrivacyPanel />);
    const row = await screen.findByTestId("settings.screen-capture");
    await waitFor(() =>
      expect(row.getAttribute("data-protection-on")).toBe("true"),
    );

    fireEvent.click(screen.getByTestId("settings.screen-capture-toggle"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(SET, { disabled: true }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(PREFS_SET, { enabled: false }),
    );
    expect(callIndex(SET)).toBeLessThan(callIndex(PREFS_SET));
  });

  it("reads the DEVICE state: a device already opted out shows OFF and restores both", async () => {
    // The half a preference-keyed switch would get wrong. A user who took the
    // pre-unlock escape has the file off and the sealed preference untouched, so
    // a switch reading the preference would claim protection that is not there.
    stub({
      [GET]: () =>
        Promise.resolve({ disabled: true, via_flag: false, effective: true }),
      [SET]: () =>
        Promise.resolve({ disabled: false, via_flag: false, effective: false }),
      [PREFS_SET]: () => Promise.resolve(undefined),
    });
    render(<PrivacyPanel />);
    const row = await screen.findByTestId("settings.screen-capture");
    await waitFor(() =>
      expect(row.getAttribute("data-protection-on")).toBe("false"),
    );
    expect(
      screen.getByText(t("settings.privacy.screenCaptureHelperOff")),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("settings.screen-capture-toggle"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(SET, { disabled: false }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(PREFS_SET, { enabled: true }),
    );
  });

  it("renders NO row on a client without the capability", async () => {
    // **myne-md/myne#556 supersedes myne-md/myne#482's web arm, and both halves
    // of that are worth stating.**
    //
    // #482 found the switch INERT on web: `useScreenCaptureOverride` returns
    // early where there is no capture affinity to suppress, so `override` stays
    // `null` there permanently, `superseded` read true forever, and the control
    // sat dead under a sentence about a control that client does not have. Its
    // fix was the `overrideApplies` gate, which made the switch live again.
    //
    // #556 asked the prior question and answered it differently: a page cannot
    // stop a screenshot at all, so `screenCaptureProtection` is absent on web
    // and `decisions.md` 2026-07-26 makes OMISSION normative for an absent
    // capability. A live switch there is worse than an inert one - it reports a
    // change the platform never makes, on the one panel whose whole job is
    // saying what is and is not protected. So the row is not rendered, which
    // removes #482's state rather than fixing it.
    //
    // The `overrideApplies` gate stays and is still asserted by the cases
    // above, for a client that HAS the capability. What changed is only what a
    // client WITHOUT it sees, which is nothing.
    //
    // `e2e-web/capability-row-coherence.e2e.ts` is the same assertion against a
    // real browser; this is the one that fails fast.
    capabilityPresent = false;
    try {
      stub({});
      const { container } = render(<PrivacyPanel />);
      // The panel MOUNTED, checked positively. The probe is the panel's own
      // root rather than a row, and myne-md/myne#885 is why: every row in this
      // topic is capability-gated, and the row the panel always renders
      // (auto-lock) moved into the OTHER topic, where selecting it would unmount
      // the very topic asserted absent below. A row-based probe that unmounts
      // its subject is the trap this comment exists for, so the probe is the
      // root the panel returns, and a panel that rendered nothing fails here.
      expect(container.firstElementChild).not.toBeNull();
      expect(screen.queryByTestId("settings.screen-capture")).toBeNull();
      expect(screen.queryByTestId("settings.screen-capture-toggle")).toBeNull();
    } finally {
      capabilityPresent = true;
    }
  });

  it("names the process flag and stays locked when only the flag holds", async () => {
    // `{disabled: false, via_flag: true, effective: true}`. The flag is an argv,
    // so it cannot be un-passed from here: a click could only write a preference
    // the window will not follow, which is a report of a change that did not
    // happen. Locked as a STATE rather than as an attribute, so a switch that
    // renders disabled and still fires fails here.
    stub({
      [GET]: () =>
        Promise.resolve({ disabled: false, via_flag: true, effective: true }),
      [PREFS_SET]: () => Promise.resolve(undefined),
    });
    render(<PrivacyPanel />);
    const row = await screen.findByTestId("settings.screen-capture");
    await waitFor(() => expect(row.getAttribute("data-locked")).toBe("true"));
    expect(
      screen.getByText(t("settings.privacy.screenCaptureSupersededByFlag")),
    ).toBeTruthy();

    const toggle = screen.getByTestId("settings.screen-capture-toggle");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(toggle);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === SET)).toBe(false);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === PREFS_SET)).toBe(false);
  });

  it("locks the switch when the override could not be read", async () => {
    // `null` is UNKNOWN, and collapsing it to "no override" would leave this
    // switch LIVE on a device whose override may be on: a click would write
    // `vault.prefs`, which is AEAD-sealed and synced, then report success while
    // the window stays capturable.
    stub({
      [GET]: () => Promise.reject({ kind: "Io" }),
      [PREFS_SET]: () => Promise.resolve(undefined),
    });
    render(<PrivacyPanel />);
    const row = await screen.findByTestId("settings.screen-capture");
    await waitFor(() => expect(row.getAttribute("data-locked")).toBe("true"));
    expect(
      screen.getByText(t("settings.privacy.screenCaptureOverrideUnknown")),
    ).toBeTruthy();

    const toggle = screen.getByTestId("settings.screen-capture-toggle");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(toggle);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === SET)).toBe(false);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === PREFS_SET)).toBe(false);
  });

  it("writes no preference when the device write fails, and says so", async () => {
    // The device write is the one that can fail with nothing written anywhere,
    // so it must not be reported as a change: the switch stays where it was, the
    // sealed preference is untouched, and the row carries the failure.
    stub({
      [SET]: () => Promise.reject({ kind: "Io" }),
      [PREFS_SET]: () => Promise.resolve(undefined),
    });
    render(<PrivacyPanel />);
    const row = await screen.findByTestId("settings.screen-capture");
    await waitFor(() =>
      expect(row.getAttribute("data-protection-on")).toBe("true"),
    );

    fireEvent.click(screen.getByTestId("settings.screen-capture-toggle"));
    await waitFor(() =>
      expect(screen.getByText(t("screenCaptureEscape.saveFailed"))).toBeTruthy(),
    );
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === PREFS_SET)).toBe(false);
    expect(row.getAttribute("data-protection-on")).toBe("true");
  });

  it("a write on this surface reaches the pre-unlock escape without a remount", async () => {
    // The regression the shared module cell was introduced for, and the half
    // nobody asserted: two independent `view` cells meant turning the override
    // ON in Settings left the Unlock screen's escape still reporting it off,
    // offering "turn protection off" over a window that was already capturable
    // and offering no way back on the one surface that has no Settings.
    //
    // Both surfaces are mounted in ONE tree here, which is the arrangement the
    // module header says is real.
    stub({
      [SET]: () =>
        Promise.resolve({ disabled: true, via_flag: false, effective: true }),
      [PREFS_SET]: () => Promise.resolve(undefined),
    });
    render(
      <>
        <ScreenCaptureEscape />
        <PrivacyPanel />
      </>,
    );

    const trigger = await screen.findByTestId("screen-capture-escape.trigger");
    await waitFor(() =>
      expect(trigger.getAttribute("data-override")).toBe("false"),
    );

    fireEvent.click(screen.getByTestId("settings.screen-capture-toggle"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(SET, { disabled: true }),
    );

    // The escape, which nobody touched, now reports the new value.
    await waitFor(() =>
      expect(trigger.getAttribute("data-override")).toBe("true"),
    );
    // And the switch itself follows the device, not the preference it just also
    // wrote: the panel reads whichever store is suppressing protection.
    expect(
      screen
        .getByTestId("settings.screen-capture")
        .getAttribute("data-protection-on"),
    ).toBe("false");
  });

  it("is mounted by App without a stage predicate", () => {
    // Asserted against the SOURCE, because the failure is a mount-site edit no
    // component test can see. The first revision gated this on
    // `stage.name !== "editor"`, reasoning that Settings carries the same
    // control after unlock. False on the three screens `Editor.tsx` returns
    // before `EditorChrome`, one of which renders with the vault LOCKED and
    // protection forced back on. Same shape as the settings-search index spec,
    // which greps panel sources for the testids it claims to reach.
    // `process.cwd()` rather than `import.meta.url`: this spec runs under the
    // jsdom environment, where `import.meta.url` is not a file URL. Vitest runs
    // from the repo root.
    // Annotated rather than inferred: `@types/node` is not a dependency, so
    // `readFileSync` is untyped here and `app` would be `any`, which makes the
    // `filter` callback below an implicit-any that `check-test-typecheck.mjs`
    // counts. `pnpm build` never sees this file, so CI is the only reporter.
    const app: string = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
    // Asserted on the LINE rather than on one conditional shape. The first
    // version rejected only `{cond && <ScreenCaptureEscape />}`, which a
    // ternary, a predicate containing a `}`, or a wrapper component all walk
    // straight past. A mount with nothing else on its line cannot be
    // conditional at all.
    const mounts = app
      .split("\n")
      .filter((l) => l.includes("<ScreenCaptureEscape"));
    expect(mounts, "App must mount ScreenCaptureEscape exactly once").toHaveLength(1);
    expect(
      mounts[0].trim(),
      "ScreenCaptureEscape must not be gated on a stage: the screens with no Settings live inside `editor`",
    ).toBe("<ScreenCaptureEscape />");
  });

  it("has ONE settings-search entry, and it is not developer-gated", () => {
    // The device override no longer has an entry of its own, because its row is
    // gone and an entry would navigate to an anchor that is never rendered. The
    // single row keeps its entry, and it has to stay out of Developer mode: the
    // person this setting is about is on a black window, and a mode-gated
    // setting cannot be found by them.
    expect(
      SETTINGS_SEARCH_INDEX.find((e) => e.id === "privacy.screen-capture-override"),
      "the device override must not keep an entry with no row behind it",
    ).toBeUndefined();
    const entry = SETTINGS_SEARCH_INDEX.find(
      (e) => e.id === "privacy.screen-capture",
    );
    expect(entry, "no settings-search entry for privacy.screen-capture").toBeDefined();
    expect(entry!.panelId).toBe("privacy");
    expect(entry!.capability).toBe("screenCaptureProtection");
    expect(entry!.developerGated ?? false).toBe(false);
  });
});
