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

    fireEvent.focus(trigger);
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

    expect(await screen.findByTestId("screen-capture-escape.status")).toBeTruthy();
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

describe("Privacy panel: the override supersedes the per-vault switch", () => {
  const PREFS_SET = "plugin:prefs|set_screen_capture_protection";

  it("leaves the per-vault switch live while no override is set", async () => {
    // The positive half. Without it, "the switch does nothing while
    // superseded" would pass for a switch that does nothing ever.
    stub({ [PREFS_SET]: () => Promise.resolve(undefined) });
    render(<PrivacyPanel />);
    const row = await screen.findByTestId("settings.screen-capture");
    await waitFor(() =>
      expect(row.getAttribute("data-superseded")).toBe("false"),
    );
    fireEvent.click(screen.getByTestId("settings.screen-capture-toggle"));
    await waitFor(() =>
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === PREFS_SET)).toBe(true),
    );
  });

  it("makes the per-vault switch inert while the override is on", async () => {
    // Asserted as a STATE, not as an attribute: a click must not reach the
    // `vault.prefs` setter. Checking `aria-disabled` alone would pass for a
    // switch that renders disabled and still fires.
    stub({
      [GET]: () =>
        Promise.resolve({ disabled: true, via_flag: false, effective: true }),
      [PREFS_SET]: () => Promise.resolve(undefined),
    });
    render(<PrivacyPanel />);
    const row = await screen.findByTestId("settings.screen-capture");
    await waitFor(() =>
      expect(row.getAttribute("data-superseded")).toBe("true"),
    );
    expect(screen.getByText(t("settings.privacy.screenCaptureSuperseded"))).toBeTruthy();

    const toggle = screen.getByTestId("settings.screen-capture-toggle");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(toggle);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === PREFS_SET)).toBe(false);
  });

  it("mirrors the override as its own row, and writes through it", async () => {
    stub();
    render(<PrivacyPanel />);
    const row = await screen.findByTestId("settings.screen-capture-override");
    await waitFor(() => expect(row.getAttribute("data-disabled")).toBe("false"));

    fireEvent.click(screen.getByTestId("settings.screen-capture-override-toggle"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(SET, { disabled: true }),
    );
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
    const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
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

  it("is in the settings search index and is NOT developer-gated", () => {
    // The person this exists for is on a black window. A setting behind
    // Developer mode cannot be found by them, and search resolves straight to a
    // panel id, so a `developerGated` tag there would hide it from the one
    // surface a user reaches for when they cannot find a setting.
    const entry = SETTINGS_SEARCH_INDEX.find(
      (e) => e.id === "privacy.screen-capture-override",
    );
    expect(entry, "no settings-search entry for privacy.screen-capture-override")
      .toBeDefined();
    expect(entry!.panelId).toBe("privacy");
    expect(entry!.capability).toBe("screenCaptureProtection");
    expect(entry!.developerGated ?? false).toBe(false);
  });
});
