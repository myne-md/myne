// @vitest-environment jsdom
//
// The deboxed credential row (myne-md/myne#773) — the three behaviours that
// are load-bearing rather than cosmetic.
//
// This replaced a bordered input stacked on a full-width accent button on the
// two pre-unlock screens. Everything the button used to say in words, an icon
// now has to say some other way, and "some other way" is the part a redesign
// loses silently: the label went, so the accessible name took the job; the
// spinner-beside-the-label went, so the rule took the job.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InlineSubmitField } from "../../src/components/primitives/InlineSubmitField";

afterEach(cleanup);

function Field(props: Partial<Parameters<typeof InlineSubmitField>[0]> = {}) {
  return (
    <InlineSubmitField
      value=""
      onChange={() => {}}
      ariaLabel="Password"
      submitLabel="Unlock"
      busyLabel="Decrypting…"
      testId="field.input"
      submitTestId="field.submit"
      {...props}
    />
  );
}

describe("the submit is present before it is usable", () => {
  it("renders disabled on an empty field rather than not at all", () => {
    // A control that appears once you start typing reflows the row under the
    // caret mid-keystroke — and on a password field the user cannot see what
    // they typed, so a moving layout is the only feedback they get and it is
    // the wrong feedback.
    render(<Field value="" />);
    const submit = screen.getByTestId("field.submit") as HTMLButtonElement;
    expect(submit).toBeTruthy();
    expect(submit.disabled).toBe(true);
  });

  it("enables once there is something to submit", () => {
    render(<Field value="hunter2" />);
    expect((screen.getByTestId("field.submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("submits the form it is in", () => {
    // `type="submit"` rather than an onClick, so Enter in the field and a click
    // on the arrow go down the same path. The two screens using this both run
    // their attempt from the form's onSubmit.
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Field value="hunter2" />
      </form>,
    );
    fireEvent.click(screen.getByTestId("field.submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("the wait is reported without a label to report it in", () => {
  it("renames the control and locks the field while busy", () => {
    // Argon2id runs for seconds. The old CTA put a spinner beside the word
    // "Decrypting…"; an icon button has no words, so the accessible name is
    // the whole channel — for a screen-reader user it is the only signal that
    // the seconds of silence are expected.
    render(<Field value="hunter2" busy />);
    const submit = screen.getByTestId("field.submit") as HTMLButtonElement;
    expect(submit.getAttribute("aria-label")).toBe("Decrypting…");
    expect(submit.disabled, "a second attempt must not race the first").toBe(true);
    expect((screen.getByTestId("field.input") as HTMLInputElement).disabled).toBe(true);
  });

  it("marks the sweep state-carrying so reduced motion slows it, not stops it", () => {
    // MYND-630. A frozen progress indicator on the unlock screen reads as the
    // app having died mid-attempt, which is the one reading it must never have.
    const { container } = render(<Field value="hunter2" busy />);
    const row = container.querySelector(".myne-inline-field") as HTMLElement;
    expect(row.getAttribute("data-busy")).toBe("true");
    expect(row.getAttribute("data-motion")).toBe("essential");
  });

  it("carries neither attribute at rest", () => {
    // The sweep is not idle decoration: at rest there is nothing in flight to
    // report, and a row permanently marked essential would exempt a still
    // element from the reduced-motion rule for no reason.
    const { container } = render(<Field value="hunter2" />);
    const row = container.querySelector(".myne-inline-field") as HTMLElement;
    expect(row.getAttribute("data-busy")).toBeNull();
    expect(row.getAttribute("data-motion")).toBeNull();
  });
});

describe("the field is named, because nothing visible names it", () => {
  it("takes its accessible name from the prop, not a placeholder", () => {
    // A placeholder is not a label: it disappears the moment the user types,
    // and several screen readers do not announce it at all. Deboxed means
    // there is no visible label either, so this prop is the only name there is.
    render(<Field placeholder="Enter your password" />);
    const input = screen.getByTestId("field.input");
    expect(input.getAttribute("aria-label")).toBe("Password");
  });

  it("points at its footer so an error is announced with the field", () => {
    render(<Field value="x" invalid footer={<p>Wrong password</p>} />);
    const input = screen.getByTestId("field.input");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy, "the error is not tied to the field").toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Wrong password");
  });

  it("points at nothing when there is nothing to point at", () => {
    // A dangling `aria-describedby` is worse than none: it makes the field look
    // described to a tree walker and resolves to an empty node.
    render(<Field value="x" />);
    expect(screen.getByTestId("field.input").getAttribute("aria-describedby")).toBeNull();
  });
});

describe("the deboxed field does not get a box back on focus", () => {
  // The global `:focus-visible` rule in `tokens.css` paints a `--ring`
  // box-shadow on every `input` in the app. Right everywhere else, wrong here:
  // it puts the frame back at the one moment the user is looking at the field.
  // The accent rule IS this field's focus indicator, so SC 2.4.7 is satisfied
  // by a different shape rather than dropped — which is the distinction that
  // makes suppressing a focus ring legitimate at all.
  const sheet = readFileSync(
    resolve(process.cwd(), "client-core/src/components.css"),
    "utf8",
  );

  function ruleBody(selector: string): string {
    const at = sheet.indexOf(selector);
    expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
    const open = sheet.indexOf("{", at);
    return sheet.slice(open + 1, sheet.indexOf("}", open));
  }

  it("suppresses the global ring on the input", () => {
    const body = ruleBody(".myne-inline-field__input:focus-visible");
    expect(body).toContain("box-shadow: none");
    expect(body).toContain("outline: none");
    // The global rule is equally specific and may load later, so the
    // suppression has to outrank it rather than merely follow it.
    expect(
      body.match(/!important/g)?.length,
      "a load-order dependency between two stylesheets is not a cascade",
    ).toBe(2);
  });

  it("replaces it rather than removing it", () => {
    // The accent rule scaled out from the centre, 2px against the resting
    // hairline. Without this assertion the test above is a test that says "it
    // is fine to have no focus indicator".
    const active = ruleBody(".myne-inline-field__rule--active");
    expect(active).toContain("var(--accent)");
    expect(sheet).toContain('.myne-inline-field[data-focused="true"] .myne-inline-field__rule--active');
  });

  it("gives the ring back under forced colours", () => {
    // Forced colours strips backgrounds, which takes the accent rule with it —
    // so the one arm where the replacement does not exist is the one arm that
    // must keep the platform's own outline. This is the exact shape of the
    // defect `tokens.css` documents at length one file over: remove the
    // platform indicator, then have the replacement removed from under you.
    expect(sheet).toContain("outline: 2px solid Highlight !important");
  });
});
