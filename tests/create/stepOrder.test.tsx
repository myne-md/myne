// @vitest-environment jsdom
//
// The step counter comes from ONE roster, and the roster matches the flow
// (myne-md/myne#468).
//
// Before this the eyebrows read `"Step 1 of 4: master password"` as a single
// translated string per step, so inserting a step renumbered four strings in
// thirty-two catalogs. A locale left behind would say "Step 1 of 4" on the
// second of five screens: plausible, wrong, and invisible to every gate in this
// repository, because `check-i18n.mjs` proves a key EXISTS and says nothing
// about what it claims.
//
// So the number is derived, and these are the two ways a derived number can go
// wrong: the roster disagreeing with the flow's real steps, and a step
// rendering a number it did not get from the roster.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../../src/lib/app-window", () => ({ HAS_TAURI: false }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }),
}));

import {
  NUMBERED_STEPS,
  stepPosition,
  isNumberedStep,
} from "../../src/screens/vault-creation/stepOrder";
import { NameStep } from "../../src/screens/vault-creation/NameStep";

afterEach(cleanup);

const src = (rel: string): string =>
  readFileSync(resolve(process.cwd(), rel), "utf8");

describe("the roster describes the flow the reducer implements", () => {
  it("names only steps the reducer has", () => {
    // A renamed step would otherwise leave the roster holding a name nothing
    // routes to, and `stepPosition` would keep returning a confident number for
    // a screen that no longer exists.
    const reducer = src("src/screens/vault-creation/reducer.ts");
    for (const step of NUMBERED_STEPS) {
      expect(reducer, `the reducer has no "${step}" step`).toContain(`| "${step}"`);
      expect(isNumberedStep(step)).toBe(true);
    }
  });

  it("numbers every step the user always walks, and nothing conditional", () => {
    // `briefing` is first-run only: numbering it promises a length the flow does
    // not have on the picker's "create another" entry. The three waits
    // (`encrypting`, `provisioning`, `committing`) are not steps the user acts
    // on, and `provisioning` is web-only besides.
    for (const notAStep of [
      "briefing",
      "encrypting",
      "provisioning",
      "committing",
      "ready",
      "session-lost",
    ]) {
      expect(isNumberedStep(notAStep as never), `${notAStep} is numbered`).toBe(false);
    }
  });

  it("positions are one-based, contiguous, and share one total", () => {
    const seen = NUMBERED_STEPS.map((s) => stepPosition(s));
    expect(seen.map((p) => p.n)).toEqual(
      NUMBERED_STEPS.map((_, i) => i + 1),
    );
    expect(new Set(seen.map((p) => p.total)).size, "the total is not one number").toBe(1);
    expect(seen[0].total).toBe(NUMBERED_STEPS.length);
  });
});

describe("no step writes its own number", () => {
  it("every numbered step renders the shared counter rather than a bare eyebrow", () => {
    // The mechanism, asserted because it is the mechanism: a step reaching for
    // `<StepEyebrow>` with a hand-written number compiles, renders, and
    // reintroduces exactly the drift this file exists to prevent.
    for (const step of NUMBERED_STEPS) {
      const file =
        step === "name"
          ? "NameStep.tsx"
          : step === "password"
            ? "PasswordStep.tsx"
            : step === "kit"
              ? "KitStep.tsx"
              : "ConfirmStep.tsx";
      const code = src(`src/screens/vault-creation/${file}`);
      expect(code, `${file} does not render <StepCounter>`).toContain("<StepCounter");
      expect(code, `${file} still renders a bare <StepEyebrow>`).not.toContain(
        "<StepEyebrow",
      );
    }
  });

  it("no catalog value spells a step number", () => {
    // The other half, and the one that actually rotted: a value like
    // "Step 1 of 4: master password" anywhere under `vaultCreation` means a
    // number is back inside a translated string.
    const catalog = JSON.parse(src("locales/en/common.json")) as Record<
      string,
      unknown
    >;
    const vc = catalog.vaultCreation as Record<string, Record<string, string>>;
    const offenders: string[] = [];
    for (const [block, entries] of Object.entries(vc)) {
      if (typeof entries !== "object" || entries === null) continue;
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value !== "string") continue;
        if (/\bof\s+\d/i.test(value) || /\bStep\s+\d/i.test(value)) {
          offenders.push(`vaultCreation.${block}.${key} = ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // …and the one string that IS the indicator interpolates all three parts,
    // so a translator can move them and cannot hardcode them.
    const indicator = catalog.vaultCreation as Record<string, string>;
    expect(indicator.stepIndicator).toContain("{{n}}");
    expect(indicator.stepIndicator).toContain("{{total}}");
    expect(indicator.stepIndicator).toContain("{{label}}");
  });
});

describe("the rendered eyebrow carries the derived number", () => {
  it("the first step says 1 of 4, not 1 of 5 or 2 of 4", () => {
    // The end-to-end version of the two halves above: a wired step, rendered,
    // read off the screen. `i18next` is initialised for real in the test setup,
    // so this is the actual interpolation.
    render(
      <NameStep value="" onChange={() => {}} onSubmit={() => {}} onBack={() => {}} />,
    );
    const { n, total } = stepPosition("name");
    expect(screen.getByText(new RegExp(`${n}\\b.*\\b${total}\\b`))).toBeTruthy();
  });
});
