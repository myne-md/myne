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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/** The hook's three states, switched per test. `ready` and `unavailable` cannot
 *  both be true in the real hook (there is no evaluator to be ready with), so the
 *  mock keeps them derived from one value rather than letting a fixture describe
 *  a state the product cannot reach. */
const strength = vi.hoisted(() => ({
  mode: "ready" as "ready" | "loading" | "unavailable",
}));

vi.mock("../../src/components/PasswordInput", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/components/PasswordInput")>();
  return {
    ...real,
    usePasswordStrength: () => ({
      ready: strength.mode === "ready",
      result: strength.mode === "ready" ? { score: 4 } : null,
      unavailable: strength.mode === "unavailable",
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { PasswordCreateForm } = await import("../../src/components/PasswordCreateForm");
const { MIN_PASSWORD_LEN } = await import("../../src/components/PasswordInput");

beforeEach(() => {
  strength.mode = "ready";
});
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

  // A strength chunk that cannot be loaded used to be indistinguishable from one
  // still loading: the caption said "Checking strength…" for the whole session and
  // the submit never enabled, with nothing said about why (measured 2026-10-24 off
  // a 504 on the lazy `@zxcvbn-ts/*` chunks). 2026-10-24, the owner's call: the
  // step falls back to the length floor and the screen says so.
  it("falls back to the length floor when the strength check cannot load", () => {
    strength.mode = "unavailable";
    const onSubmit = renderForm();
    const longButWeak = "aaaaaaaaaaaaaaaa";

    fill("t.password-input", longButWeak);
    fill("t.confirm-input", longButWeak);
    expect(screen.getByText("password.createForm.strengthUnavailable")).toBeTruthy();
    expect(submit().disabled).toBe(false);

    // The floor is untouched by the fallback: one character below it, still refused.
    const short = longButWeak.slice(0, MIN_PASSWORD_LEN - 1);
    fill("t.password-input", short);
    fill("t.confirm-input", short);
    expect(submit().disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // The other half of the same distinction: still loading is not the same state as
  // failed, and must not render the fallback's sentence or its open gate.
  it("stays closed and says it is checking while the check is still loading", () => {
    strength.mode = "loading";
    renderForm();
    const long = "aaaaaaaaaaaaaaaa";
    fill("t.password-input", long);
    fill("t.confirm-input", long);
    expect(screen.getByText("password.createForm.checkingStrength")).toBeTruthy();
    expect(screen.queryByText("password.createForm.strengthUnavailable")).toBeNull();
    expect(submit().disabled).toBe(true);
  });
});
