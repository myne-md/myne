// @vitest-environment jsdom
//
// The frontend password floor must count the unit the backend floor counts.
//
// `protocol::password_policy::validate_min_length` counts Unicode scalar
// values (`str::chars().count()`); `String.prototype.length` counts UTF-16
// code units. Every astral scalar — most emoji, the CJK extension blocks,
// the historic scripts — is one of the former and two of the latter, so a
// form gating on `.length` enables Submit for an eleven-character password
// that the Argon2id-bound command then refuses. The user meets that refusal
// after the ceremony has already started, which on vault creation is a
// spinner rather than a banner.
//
// Both credential-creating forms are asserted from both sides of the floor
// with an astral scalar in play, so a regression to `.length` fails here
// instead of at the IPC boundary. The companion `password-policy` vectors
// cannot catch it: every case there is byte-vs-USV and none straddles the
// floor in UTF-16.
//
// zxcvbn is stubbed to a ready, passing score — the unit under test is the
// length gate, and the real hook's dynamic import would only make the
// assertion asynchronous.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../src/components/PasswordInput", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/components/PasswordInput")>();
  return { ...real, usePasswordStrength: () => ({ ready: true, result: { score: 4 } }) };
});

const { PasswordCreateForm } = await import("../../src/components/PasswordCreateForm");
const { PasswordChangeForm } = await import("../../src/components/PasswordChangeForm");
const { MIN_PASSWORD_LEN, passwordLength } = await import("../../src/components/PasswordInput");
// The suite loads the real English catalog, so resolving the expected caption
// through it keeps this a test of the GATE, not of the wording.
const i18n = (await import("../../src/i18n")).default;

/** Ten ASCII letters + one astral scalar: 11 USVs, 12 UTF-16 code units. */
const BELOW_FLOOR = "abcdefghij🔐";
/** Eleven ASCII letters + one astral scalar: 12 USVs, 13 UTF-16 code units. */
const AT_FLOOR = "abcdefghijk🔐";

afterEach(cleanup);

function fill(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function submitButton(testId: string) {
  return screen.getByTestId(testId) as HTMLButtonElement;
}

describe("password length gate counts Unicode scalar values", () => {
  it("the fixtures straddle the floor in scalar values but clear it in code units", () => {
    expect(passwordLength(BELOW_FLOOR)).toBe(MIN_PASSWORD_LEN - 1);
    expect(BELOW_FLOOR.length).toBe(MIN_PASSWORD_LEN);
    expect(passwordLength(AT_FLOOR)).toBe(MIN_PASSWORD_LEN);
  });

  describe("PasswordCreateForm (vault creation + post-recovery reset)", () => {
    const tooShort = () => i18n.t("password.createForm.tooShort", { n: MIN_PASSWORD_LEN });

    function renderForm() {
      render(
        <PasswordCreateForm
          submitLabel="Continue"
          onSubmit={() => {}}
          testIdPrefix="create"
        />,
      );
    }

    it("refuses an eleven-scalar password whose UTF-16 length reaches the floor", () => {
      renderForm();
      fill("create.password-input", BELOW_FLOOR);
      fill("create.confirm-input", BELOW_FLOOR);

      expect(screen.getByText(tooShort())).toBeTruthy();
      expect(submitButton("create.submit").disabled).toBe(true);
    });

    it("accepts a twelve-scalar password", () => {
      renderForm();
      fill("create.password-input", AT_FLOOR);
      fill("create.confirm-input", AT_FLOOR);

      expect(screen.queryByText(tooShort())).toBeNull();
      expect(submitButton("create.submit").disabled).toBe(false);
    });
  });

  describe("PasswordChangeForm (Settings → Account)", () => {
    const tooShort = () => i18n.t("settings.changePassword.tooShort", { n: MIN_PASSWORD_LEN });

    function renderForm() {
      render(<PasswordChangeForm onSubmit={() => {}} />);
      fill("change-password.current", "current-password");
    }

    it("refuses an eleven-scalar new password whose UTF-16 length reaches the floor", () => {
      renderForm();
      fill("change-password.new", BELOW_FLOOR);
      fill("change-password.confirm", BELOW_FLOOR);

      expect(screen.getByText(tooShort())).toBeTruthy();
      expect(submitButton("change-password.submit").disabled).toBe(true);
    });

    it("accepts a twelve-scalar new password", () => {
      renderForm();
      fill("change-password.new", AT_FLOOR);
      fill("change-password.confirm", AT_FLOOR);

      expect(screen.queryByText(tooShort())).toBeNull();
      expect(submitButton("change-password.submit").disabled).toBe(false);
    });
  });
});
