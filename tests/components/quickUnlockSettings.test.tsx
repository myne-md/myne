// @vitest-environment jsdom
//
// A biometric affordance is ABSENT where biometrics cannot work, not disabled —
// myne-md/myne#557, the `vault.quick-unlock` bullet:
//
//   > the absent-not-disabled rule is a render decision over the capability
//   > descriptor: with the Windows platform value and a `HardwareUnavailable`
//   > backend, assert no Hello row exists in any form.
//
// # The rule, and why "disabled" is the wrong answer here
//
// Touch ID has a provider on exactly one desktop OS. On Windows and Linux the
// backend answers `HardwareUnavailable`, and on an unsigned macOS build it
// answers the same thing for a different reason. A greyed "Use Touch ID" button
// is an offer the platform cannot honour: it tells a Windows user the feature
// exists for them and is merely off right now, which is false and unfixable
// from where they are standing. The component's own comment puts it plainly —
// "a button that just errors again would be a lie".
//
// So the assertion is ABSENCE, and absence in every form. A test that only
// checked `disabled` would pass on a rendered-but-greyed button, which is the
// exact defect. A test that only looked for the testid would pass on a build
// that kept the label as static text. Both are checked.
//
// # Three gates, and the reason all three are exercised
//
// The affordance renders on `has("biometricQuickUnlock") && isMacPlatform() &&
// !biometricUnavailable`. Those are three genuinely different questions — does
// this CLIENT ship the path (web does not), does this OS have a provider, and
// did an enrolment attempt already prove it unusable on this machine — and any
// one of them alone is not the rule. Testing them one at a time is what
// distinguishes "the affordance is correctly hidden" from "the affordance is
// hidden because one gate happens to be closed on the runner".
//
// The third gate is the one a hand-walk on a Mac cannot reach at all: it opens
// only after a real enrolment has failed, which on a signed developer build it
// does not.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/** `navigator.platform` this simulated host reports. */
let platform = "MacIntel";
/** Whether this simulated build ships the biometric path at all. */
let hasBiometricCapability = true;
/** What the backend says when asked to enrol a biometric. */
let enrolmentError: { kind: string } | null = null;

vi.mock("../../src/platform/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform/capabilities")>();
  return {
    ...actual,
    has: (cap: string) =>
      cap === "biometricQuickUnlock" ? hasBiometricCapability : actual.has(cap as never),
  };
});

// `isMacPlatform()` reads `navigator.platform`, which jsdom makes read-only, so
// the module is stubbed rather than the global patched. The function itself is
// covered by `tests/platform/reservedChords.test.ts`; what matters here is which
// ANSWER produces which render.
vi.mock("../../src/commands/chord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/commands/chord")>();
  return { ...actual, isMacPlatform: () => /Mac|iP(hone|[oa]d)/.test(platform) };
});

vi.mock("../../src/lib/quick-unlock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/quick-unlock")>();
  return {
    ...actual,
    quickUnlockStatus: async () => ({ configured: false, method: null, available: true }),
    quickUnlockSetupPin: vi.fn(async () => {}),
    quickUnlockSetupBiometric: vi.fn(async () => {
      if (enrolmentError) throw enrolmentError;
    }),
  };
});

const { QuickUnlockSettings } = await import("../../src/components/settings/QuickUnlockSettings");
const enCatalog = (await import("../../locales/en/common.json")).default as Record<string, unknown>;

function copy(key: string): string {
  const value = key
    .split(".")
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], enCatalog);
  expect(typeof value, `\`${key}\` is missing from locales/en/common.json`).toBe("string");
  return value as string;
}

/** Turn the row's switch on, which is what reveals the setup block both
 *  buttons live in. */
async function openSetup() {
  render(<QuickUnlockSettings />);
  fireEvent.click(await screen.findByTestId("settings.quick-unlock-toggle"));
  return await screen.findByTestId("settings.quick-unlock-pin-input");
}

/**
 * Assert the Touch ID affordance is gone in EVERY form.
 *
 * Three separate absences, because each one is a different way of shipping the
 * defect: the control itself, any element still carrying its label as text, and
 * any control that merely went disabled. The last is the one the rule is named
 * after.
 */
function expectNoBiometricAffordance(why: string) {
  expect(screen.queryByTestId("settings.quick-unlock-setup-biometric"), why).toBeNull();

  const label = copy("settings.quickUnlock.useTouchId");
  expect(
    screen.queryByText(label, { exact: false }),
    `${why} — the control is gone but its label "${label}" is still on screen, ` +
      `which tells the user the feature exists here just as effectively`,
  ).toBeNull();

  const disabled = Array.from(document.querySelectorAll("button[disabled]")).map(
    (b) => b.textContent ?? "",
  );
  expect(
    disabled.filter((text) => text.includes(label)),
    `${why} — a DISABLED Touch ID button is rendered. Absent, not disabled: on a ` +
      `platform with no provider the greyed button says the feature exists for ` +
      `this user and is merely off, which is false and not fixable from where ` +
      `they are standing.`,
  ).toEqual([]);
}

beforeEach(() => {
  platform = "MacIntel";
  hasBiometricCapability = true;
  enrolmentError = null;
});

afterEach(cleanup);

describe("the Touch ID affordance is absent wherever it cannot work", () => {
  it("renders it on a mac build that ships the path", async () => {
    // Non-vacuity first. Without this, every absence below could be the
    // component failing to render anything at all.
    await openSetup();
    expect(
      await screen.findByTestId("settings.quick-unlock-setup-biometric"),
      "the positive case does not render, so the absences below prove nothing",
    ).toBeTruthy();
  });

  it("omits it on Windows", async () => {
    platform = "Win32";
    await openSetup();
    expectNoBiometricAffordance("Windows has no Touch ID provider");
  });

  it("omits it on Linux", async () => {
    platform = "Linux x86_64";
    await openSetup();
    expectNoBiometricAffordance("Linux has no Touch ID provider");
  });

  it("omits it on a build without the capability, even on a mac", async () => {
    // The web client: same OS, same `navigator.platform`, no keychain path. The
    // capability and the platform are separate questions and this is the case
    // that shows it — a platform-only gate would render the button here.
    hasBiometricCapability = false;
    await openSetup();
    expectNoBiometricAffordance("this build does not ship the biometric path");
  });

  it("stops offering it once an enrolment has answered HardwareUnavailable", async () => {
    // The gate no hand-walk reaches: an unsigned build, or a machine whose
    // biometric set changed. Retrying cannot succeed, so the button goes rather
    // than staying and erroring.
    enrolmentError = { kind: "HardwareUnavailable" };
    await openSetup();
    fireEvent.click(await screen.findByTestId("settings.quick-unlock-setup-biometric"));
    await waitFor(() =>
      expect(screen.queryByTestId("settings.quick-unlock-setup-biometric")).toBeNull(),
    );
    expectNoBiometricAffordance("enrolment proved the hardware unusable on this machine");
  });

  it("keeps the PIN path on every one of those", async () => {
    // The other half, and the reason the two are separate capabilities: the PIN
    // path is Argon2id plus three files under the vault root, with no OS secret
    // involved, so it is genuinely portable. Removing the biometric affordance
    // must not take quick unlock away with it.
    for (const [label, apply] of [
      ["Windows", () => void (platform = "Win32")],
      ["Linux", () => void (platform = "Linux x86_64")],
      ["no capability", () => void (hasBiometricCapability = false)],
    ] as const) {
      platform = "MacIntel";
      hasBiometricCapability = true;
      apply();
      await openSetup();
      expect(await screen.findByTestId("settings.quick-unlock-setup-pin"), label).toBeTruthy();
      cleanup();
    }
  });
});
