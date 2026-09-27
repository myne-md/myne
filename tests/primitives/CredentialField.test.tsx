// @vitest-environment jsdom
//
// The credential field (myne-md/myne#773): the app's own `<Input>` and
// `<Button>`, on the auth screens.
//
// What it replaced was bespoke — a borderless input at `--text-xl` with a
// hairline under it and a round accent arrow at its right end, every piece of
// it invented for this one screen. That is what made the first surface a new
// user meets read as somewhere else in the product.

import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";

import { CredentialField } from "../../src/components/primitives/CredentialField";

afterEach(() => cleanup());

function Field(props: Partial<Parameters<typeof CredentialField>[0]> = {}) {
  return (
    <CredentialField
      value=""
      onChange={() => {}}
      ariaLabel="Master password"
      busyLabel="Decrypting…"
      submitLabel="Unlock"
      testId="cred.input"
      submitTestId="cred.submit"
      {...props}
    />
  );
}

describe("it is the app's primitives, not a second design", () => {
  it("renders the shared Input and the shared Button", () => {
    render(<Field value="hunter2" />);
    // The classes are the contract: `.myne-input` and `.myne-btn` are what
    // carry the app's fill, hairline, radius and focus ring, and a hand-rolled
    // element that merely looked similar is the thing this replaced.
    expect(screen.getByTestId("cred.input").className).toContain("myne-input");
    const submit = screen.getByTestId("cred.submit");
    expect(submit.className).toContain("myne-btn");
    expect(submit.getAttribute("data-variant")).toBe("primary");
  });

  it("gives the button the width of the field", () => {
    // `.myne-btn` is inline-flex and sized to its label — correct in a toolbar,
    // wrong as the one action on a screen, where it would sit as a small chip
    // under a full-width input.
    render(<Field value="hunter2" />);
    const submit = screen.getByTestId("cred.submit");
    expect(submit.style.width).toBe("100%");
    // And centred with it, or the label sits left in a full-width button.
    expect(submit.style.justifyContent).toBe("center");
  });
});

describe("the submit is present before it is usable", () => {
  it("is disabled rather than absent when the field is empty", () => {
    // A control that appears once you start typing reflows the layout under
    // the caret mid-keystroke, and on a password field the user cannot see
    // what they typed — so a moving layout is the only feedback they get, and
    // it is the wrong feedback.
    render(<Field value="" />);
    const submit = screen.getByTestId("cred.submit") as HTMLButtonElement;
    expect(submit).toBeTruthy();
    expect(submit.disabled).toBe(true);
  });

  it("comes alive with a value", () => {
    render(<Field value="h" />);
    expect((screen.getByTestId("cred.submit") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("one indicator for the wait", () => {
  it("says what is happening in the button, in words", () => {
    // Argon2id runs for seconds. The label is load-bearing rather than
    // decorative: it is the only channel a screen-reader user has on a screen
    // whose normal case is several seconds of nothing happening.
    render(<Field value="hunter2" busy />);
    const submit = screen.getByTestId("cred.submit") as HTMLButtonElement;
    expect(submit.textContent).toContain("Decrypting…");
    expect(submit.disabled).toBe(true);
    // The field locks too, so a second attempt cannot race the in-flight one.
    expect((screen.getByTestId("cred.input") as HTMLInputElement).disabled).toBe(true);
  });

  it("claims no motion exemption anywhere on the row", () => {
    // A sweeping rule under the field used to report the same wait
    // (`docs/decisions/ui/0626` withdrew it). Nothing here carries state
    // through motion now, so a reduced-motion exemption would be an exemption
    // for nothing — and `check-motion-canon.mjs` no longer knows this file.
    const { container } = render(<Field value="hunter2" busy />);
    expect(container.querySelector("[data-motion]")).toBeNull();
  });
});

describe("the error belongs to the field, not to the retry", () => {
  it("renders the footer between the input and the button, and describes the input with it", () => {
    render(<Field value="hunter2" invalid footer={<p>Wrong password</p>} />);
    const input = screen.getByTestId("cred.input");
    const submit = screen.getByTestId("cred.submit");
    const footer = screen.getByText("Wrong password").parentElement as HTMLElement;
    // Order: an error under the control that will retry it reads as being
    // about the retry.
    expect(
      input.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      footer.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // And a screen reader reaches it from the field itself.
    expect(input.getAttribute("aria-describedby")).toBe(footer.id);
    expect(input.getAttribute("data-invalid")).toBe("true");
  });

  it("wires no describedby when there is nothing to describe", () => {
    render(<Field value="hunter2" />);
    expect(screen.getByTestId("cred.input").getAttribute("aria-describedby")).toBeNull();
  });
});

describe("it is named, because nothing visible names it", () => {
  it("carries the accessible name onto the input", () => {
    render(<Field value="hunter2" />);
    expect(screen.getByTestId("cred.input").getAttribute("aria-label")).toBe(
      "Master password",
    );
  });

  it("reports typing to its caller", () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    fireEvent.change(screen.getByTestId("cred.input"), { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledWith("abc");
  });
});
