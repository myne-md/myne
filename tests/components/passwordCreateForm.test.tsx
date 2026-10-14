// @vitest-environment jsdom
//
// `PasswordCreateForm` is the ACCEPT path's gate as well as vault creation's
// (myne-md/myne#851 task 7: an accepted vault must always carry a device-local
// credential), so its ready gate is asserted here rather than assumed from a flow
// test. A change that widened it would make "the accept form cannot be completed
// without a password meeting the project floor" untrue, on a path where the
// consequence is a member vault nobody can reopen without the phrase.
//
// zxcvbn is stubbed to a ready, passing score: the unit under test is the gate, and
// the real hook's dynamic import would only make the assertions asynchronous. The
// length gate's UNIT (Unicode scalar values, not UTF-16 code units) is pinned
// separately by `tests/components/passwordLengthGate.test.tsx`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../src/components/PasswordInput", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/components/PasswordInput")>();
  return { ...real, usePasswordStrength: () => ({ ready: true, result: { score: 4 } }) };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { PasswordCreateForm } = await import("../../src/components/PasswordCreateForm");
const { MIN_PASSWORD_LEN } = await import("../../src/components/PasswordInput");

afterEach(cleanup);

const submit = () => screen.getByTestId("t.submit") as HTMLButtonElement;
const fill = (testId: string, value: string) => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
};

function renderForm(): ReturnType<typeof vi.fn> {
  const onSubmit = vi.fn();
  render(<PasswordCreateForm submitLabel="Accept" onSubmit={onSubmit} testIdPrefix="t" />);
  return onSubmit;
}

describe("PasswordCreateForm ready gate", () => {
  const OK = "correct horse battery staple";

  it("stays disabled until the two fields match and clear the floor", () => {
    const onSubmit = renderForm();
    expect(submit().disabled).toBe(true);

    // Below the floor, and matching: still refused.
    const short = OK.slice(0, MIN_PASSWORD_LEN - 1);
    fill("t.password-input", short);
    fill("t.confirm-input", short);
    expect(submit().disabled).toBe(true);

    // Over the floor, and mismatched: still refused.
    fill("t.password-input", OK);
    fill("t.confirm-input", `${OK}x`);
    expect(submit().disabled).toBe(true);

    // Both: ready.
    fill("t.confirm-input", OK);
    expect(submit().disabled).toBe(false);

    fireEvent.click(submit());
    expect(onSubmit).toHaveBeenCalledWith(OK);
  });

  it("cannot be submitted while it is disabled", () => {
    const onSubmit = renderForm();
    fireEvent.click(submit());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("honours a caller's extra disable without narrowing its own gate", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <PasswordCreateForm submitLabel="Accept" onSubmit={onSubmit} testIdPrefix="t" disabled />,
    );
    const ok = OK;
    fill("t.password-input", ok);
    fill("t.confirm-input", ok);
    // Ready by its own gate, and still refused: `disabled` only widens.
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(onSubmit).not.toHaveBeenCalled();

    // Dropping the caller's flag leaves the internal gate in charge.
    rerender(<PasswordCreateForm submitLabel="Accept" onSubmit={onSubmit} testIdPrefix="t" />);
    expect(submit().disabled).toBe(false);
  });
});
