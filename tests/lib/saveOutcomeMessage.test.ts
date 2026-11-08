// The save-outcome policy for a shown-once credential (myne-md/myne#522,
// `agent-tooling/docs/spec/recovery-flow.md` §2.2, decision 0530).
//
// Three sentences, and the one that had no test is the one the spec singles out
// as the clause implementers get wrong. A native save dialog returns after the
// write, so "Saved" is true. A browser download is `<a download>.click()`: it
// returns when the page has handed the bytes over and throws on none of a
// blocked download, a cancelled destination prompt or a failed write, so the
// only true sentence there is that the download started.
//
// Replacing the whole capability branch with `return sentences.saved` left the
// tree green before this file existed: `tests/screens/secret-save-feedback.test.tsx`
// mocks the Tauri dialog and exercises the native arm only, and nothing under
// `tests/`, `e2e/` or `e2e-web/` mentioned `nativeSaveAs`. A normative MUST with
// no rejection case is an assertion that nothing happens.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const has = vi.fn();
vi.mock("../../src/platform/capabilities", () => ({ has: (c: string) => has(c) }));

import { saveOutcomeMessage } from "../../src/lib/secret-export";

const SENTENCES = { saved: "Saved.", started: "Download started.", failed: "Save failed." };

beforeEach(() => has.mockReset());
afterEach(() => vi.clearAllMocks());

describe("saveOutcomeMessage", () => {
  it("says SAVED where the client can write the file itself", () => {
    has.mockReturnValue(true);
    expect(saveOutcomeMessage(true, SENTENCES)).toBe("Saved.");
    expect(has).toHaveBeenCalledWith("nativeSaveAs");
  });

  it("says STARTED where it only handed the bytes to a browser", () => {
    // The arm the spec names, and the one that had no coverage. It is not a
    // nicety: this runs on the screen that shows a recovery phrase once and
    // never again, so "Saved" here is a claim about a file the client never
    // observed, and the user advances believing it exists.
    has.mockReturnValue(false);
    expect(saveOutcomeMessage(true, SENTENCES)).toBe("Download started.");
  });

  it("says FAILED on both platforms, because a failure is observed on both", () => {
    // The capability decides only what a SUCCESS may claim. A `deliverFile`
    // throw is rare but real, and the failure arm has to stay reachable on the
    // download path or the screen goes silent on the one outcome that matters.
    for (const capable of [true, false]) {
      has.mockReturnValue(capable);
      expect(saveOutcomeMessage(false, SENTENCES)).toBe("Save failed.");
    }
  });
});
