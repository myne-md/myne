// @vitest-environment jsdom
//
// Which heading the refusal screen shows.
//
// One surface serves two refusals — "your browser is missing X" and "this is a
// phone" — and the failure mode is silent: a phone shown "Myne can't run in this
// browser" reads as a browser problem, so the reader goes looking for a
// different browser instead of the app that is already on their home screen.
// Nothing else in the suite would notice; the gate's own tests are about the
// VERDICT, and every testid stays where it was.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UnsupportedEnvironment } from "../../web/src/UnsupportedEnvironment";
import { explainMissing, MOBILE_REFUSAL_TITLE } from "../../web/src/environment-gate";

afterEach(cleanup);

describe("the unsupported-environment screen", () => {
  it("shows the app-pointing heading for a device-class refusal", () => {
    render(<UnsupportedEnvironment missing={["desktop-form-factor"]} />);
    expect(screen.getByTestId("web.unsupported-title").textContent).toBe(MOBILE_REFUSAL_TITLE);
  });

  it("keeps the browser heading for a capability refusal", () => {
    render(<UnsupportedEnvironment missing={["opfs"]} />);
    const title = screen.getByTestId("web.unsupported-title").textContent ?? "";
    expect(title).not.toBe(MOBILE_REFUSAL_TITLE);
    expect(title).toMatch(/browser/i);
  });

  // The browser E2E reads this instead of the heading, because the runner's
  // browser decides the language and an English assertion there would be a
  // latent failure waiting for a locale change.
  it("marks which refusal fired in a language-independent discriminator", () => {
    const refusal = () => screen.getByTestId("web.unsupported-environment");
    const { rerender } = render(<UnsupportedEnvironment missing={["desktop-form-factor"]} />);
    expect(refusal().getAttribute("data-refusal")).toBe("device-class");
    rerender(<UnsupportedEnvironment missing={["opfs"]} />);
    expect(refusal().getAttribute("data-refusal")).toBe("capability");
  });

  // The reason list and the native handoff are what make the refusal
  // actionable; the heading swap must not have replaced them with itself.
  it("still explains the reason and names where to go instead", () => {
    render(<UnsupportedEnvironment missing={["desktop-form-factor"]} />);
    expect(screen.getByTestId("web.unsupported-reasons").textContent).toBe(
      explainMissing("desktop-form-factor"),
    );
    expect(screen.getByTestId("web.unsupported-handoff").textContent).toMatch(/iOS|Android/);
  });
});
