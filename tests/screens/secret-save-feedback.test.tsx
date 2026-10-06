// @vitest-environment jsdom
//
// "Save as file" reports which way it went, on both surfaces that show a
// credential once (myne-md/myne#522).
//
// The pair changed shape in myne-md/myne#468 and the reason is worth keeping: it
// used to be the vault-creation phrase step and its account-number step, which
// merged into ONE recovery-kit step. So the second surface here is now the shared
// `SecretPhraseReveal`, driven directly — that is the OTHER save row in the tree
// (the identity phrase's, `decisions/protocol/0604`), and the two rows are
// separate implementations because the kit exports two secrets as one file while
// the reveal exports one. Two implementations is exactly why both are driven.
//
// Two properties, and the second is the one the issue is about:
//
//   1. A save says something. Both outcomes used to end in a `console.error`
//      nobody sees, so a failed save and a successful one looked identical on
//      the one screen where the user has a single chance to keep a recovery
//      phrase.
//   2. It says the SAVE sentence. Copy and Save share one status line, and the
//      failed-copy string reads `Couldn't copy. Use "Save as file" instead.` A
//      failed save rendering that sentence sends the user back to the thing
//      that just failed.
//
// The Tauri boundary is mocked and the real `saveSecretAsTextFile` runs, so the
// announce plumbing between the lib and the screen is under test rather than
// stubbed out. Asserting on the rendered live region rather than on a callback
// is deliberate: what the user is told is the whole subject here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
const saveMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

import { KitStep } from "../../src/screens/vault-creation/KitStep";
import { SecretPhraseReveal } from "../../src/components/SecretPhraseReveal";

const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);

beforeEach(() => {
  invokeMock.mockReset();
  saveMock.mockReset();
});

afterEach(() => {
  cleanup();
});

/** The two surfaces, each with the testid of the status line it renders. */
const SCREENS = [
  {
    name: "recovery kit step",
    statusId: "create.kit-action-status",
    saveLabel: "Save recovery kit",
    saved:
      "Saved. It is a plain text file holding both secrets, so keep it somewhere only you can read.",
    saveFailed: "Couldn't save the file. Copy the kit instead, or write both parts down.",
    copyFailed: 'Couldn\'t copy. Use \u201cSave recovery kit\u201d instead.',
    render: () =>
      render(
        <KitStep
          phrase={PHRASE}
          accountNumber="MY-4K7P-9QRS-2TVW-XYZ0-1234"
          vaultName="Research"
          revealed={true}
          dispatch={() => {}}
        />,
      ),
  },
  {
    name: "shared phrase reveal",
    statusId: "identity-setup.phrase-action-status",
    saveLabel: "Save as file",
    saved: "Saved. It is a plain text file, so keep it somewhere only you can read.",
    saveFailed: "Couldn't save the file. Copy the words instead, or write them down.",
    copyFailed: 'Couldn\'t copy. Use "Save as file" instead.',
    render: () =>
      render(
        <SecretPhraseReveal
          phrase={PHRASE}
          revealed={true}
          onReveal={() => {}}
          onHide={() => {}}
          testIdPrefix="identity-setup.phrase"
          saveFilename="myne-identity-phrase.txt"
        />,
      ),
  },
] as const;

describe.each(SCREENS)("$name: Save as file feedback", (s) => {
  const status = () => screen.getByTestId(s.statusId).textContent;
  const clickSave = () => fireEvent.click(screen.getByText(s.saveLabel));

  it("says nothing before the user presses anything", () => {
    s.render();
    expect(status()).toBe("");
  });

  it("announces a successful save", async () => {
    saveMock.mockResolvedValue("/tmp/secret.txt");
    invokeMock.mockResolvedValue(undefined);
    s.render();
    clickSave();
    await waitFor(() => expect(status()).toBe(s.saved));
  });

  it("announces a failed save, in the SAVE sentence and not the copy one", async () => {
    // Two halves, because one status line serves two affordances. The failed
    // COPY sentence reads `Couldn't copy. Use "Save as file" instead.`, so a
    // failed save rendering it sends the user back to what just failed.
    //
    // The distinctness assertion is separate and NOT a second `expect` on
    // `status()`: once the line below has matched `saveFailed`, asserting it is
    // not `copyFailed` cannot fail while the two strings differ, so the check
    // that means something is that they differ at all.
    expect(s.saveFailed).not.toBe(s.copyFailed);
    saveMock.mockResolvedValue("/tmp/secret.txt");
    invokeMock.mockRejectedValue(new Error("io boom"));
    s.render();
    clickSave();
    await waitFor(() => expect(status()).toBe(s.saveFailed));
  });

  it("stays silent when the user cancels the dialog", async () => {
    saveMock.mockResolvedValue(null);
    s.render();
    clickSave();
    // Nothing to wait FOR, so wait for the save path to have completed and then
    // assert the line is still empty. `saveMock` resolving is the observable
    // end of that path.
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(status()).toBe("");
  });
});
