// A number field keeps Myne's input skin and none of the platform's stepper.
//
// myne-md/myne#1098. The WebView draws the spinner itself, so it is the one part
// of a field's appearance the token sheet cannot reach by style alone: on
// WebKitGTK it arrived white-on-grey inside an otherwise dark field, and it was
// the only control in the settings tree wearing a foreign widget. Every number in
// Myne is typed rather than counted up, so the stepper had no job to do.
//
// A CSS assertion in its own file for the reason `tests/styles/` exists: jsdom
// does not apply an external stylesheet, so a component test can see the input
// and cannot see that the spinner is gone.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHEET: string = readFileSync(
  fileURLToPath(new URL("../../client-core/src/components.css", import.meta.url)),
  "utf8",
);

/** The declaration body of the rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const at = SHEET.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector} in components.css`).toBeGreaterThan(-1);
  const open = SHEET.indexOf("{", at);
  const close = SHEET.indexOf("}", open);
  return SHEET.slice(open + 1, close);
}

describe("a number field's stepper is not the platform's", () => {
  it("turns the stepper off with the standard property", () => {
    expect(
      ruleBody('.myne-input[type="number"]'),
      "without this the WebView paints its own stepper inside the field",
    ).toContain("appearance: textfield");
  });

  it("and with the two WebKit pseudo-elements, which is how WebKit honours it", () => {
    const body = ruleBody(
      '.myne-input[type="number"]::-webkit-outer-spin-button,\n' +
        '.myne-input[type="number"]::-webkit-inner-spin-button',
    );
    expect(body).toContain("appearance: none");
  });
});
