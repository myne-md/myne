// @vitest-environment jsdom
//
// The motion token readers (motion-system task 6, myne-md/myne#732).
//
// These pin the READERS' contract, not the sheets: a test cannot load
// `client-core/src/tokens.css` here, so it declares the property itself and asks
// whether the reader finds it. Which tokens exist is `check-token-parity.mjs`'s
// question, and the two together are what hold a Web Animations call to the same
// value its neighbouring CSS uses.
//
// The one assertion worth reading twice is the missing-token case. It returns 0
// rather than a plausible default on purpose: a token nobody declared should give
// a visibly instant animation somebody notices, not a reasonable-looking one that
// ships.

import { afterEach, describe, expect, it } from "vitest";
import {
  motionDurationMs,
  motionEasing,
  motionToken,
} from "../../client-core/src/motion";

function declare(name: string, value: string): void {
  document.documentElement.style.setProperty(name, value);
}

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("motion token readers", () => {
  it("reads a declared custom property", () => {
    declare("--probe-duration", "0.26s");

    expect(motionToken("--probe-duration")).toBe("0.26s");
  });

  it("converts a seconds value to milliseconds", () => {
    declare("--probe-duration", "0.26s");

    expect(motionDurationMs("--probe-duration")).toBeCloseTo(260);
  });

  it("leaves a milliseconds value alone", () => {
    declare("--probe-duration", "380ms");

    expect(motionDurationMs("--probe-duration")).toBe(380);
  });

  it("returns 0 for an undeclared token rather than a plausible default", () => {
    expect(motionDurationMs("--probe-never-declared")).toBe(0);
  });

  it("returns 0 for a value that is not a number", () => {
    declare("--probe-duration", "auto");

    expect(motionDurationMs("--probe-duration")).toBe(0);
  });

  it("returns the easing string as written", () => {
    declare("--probe-ease", "cubic-bezier(0.05, 0.7, 0.1, 1)");

    expect(motionEasing("--probe-ease")).toBe("cubic-bezier(0.05, 0.7, 0.1, 1)");
  });

  it("returns 0 under prefers-reduced-motion, which no stylesheet can reach", () => {
    // The blanket reduction that zeroes every CSS transition cannot touch a Web
    // Animations duration, because the API takes it as an argument. Without this
    // the same screen would give instant CSS transitions and a full-length
    // imperative one, which is the asymmetry the canon says it does not have.
    declare("--probe-duration", "0.4s");
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      expect(motionDurationMs("--probe-duration")).toBe(0);
    } finally {
      window.matchMedia = original;
    }
  });

  it("returns an empty easing for an undeclared token, which the API reads as linear", () => {
    expect(motionEasing("--probe-never-declared")).toBe("");
  });
});
