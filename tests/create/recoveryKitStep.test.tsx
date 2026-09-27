// @vitest-environment jsdom
//
// The recovery-kit step: one screen, two secrets, one file (myne-md/myne#468).
//
// What this pins is the set of claims the merge rests on, each of which was a
// separate screen or a separate control before and so has nothing else asserting
// it:
//
//   - both secrets are on ONE screen, inside ONE sheet. The argument for merging
//     is that the sheet is a preview of the file, which is only true while both
//     are in it.
//   - Save writes the KIT, not the phrase. The old step saved
//     `phrase.join(" ")`, and a save path that kept doing that would still
//     report success, so the file's contents are read off the IPC.
//   - there is no acknowledgement CHECKBOX. `protocol.md` §7.1.3 says a bare
//     checkbox is insufficient evidence; the old account step had one anyway.
//     Deleting it is the change, so its absence is the assertion.
//   - the account number's stated reason is adding a device. It used to say
//     "required to register for sync later", which is not a thing a first-time
//     user does or can act on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
const saveMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (...a: unknown[]) => saveMock(...a) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

import { KitStep } from "../../src/screens/vault-creation/KitStep";
import i18n from "../../src/i18n";

const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);
const ACCOUNT = "MY-4K7P-N3RM-9QXC-VBHT-2";

function renderKit(over: { vaultName?: string; dispatch?: () => void } = {}) {
  return render(
    <KitStep
      phrase={PHRASE}
      accountNumber={ACCOUNT}
      vaultName={over.vaultName ?? "Research"}
      revealed={true}
      dispatch={over.dispatch ?? (() => {})}
    />,
  );
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  saveMock.mockReset();
});
afterEach(cleanup);

describe("both secrets, one sheet", () => {
  it("shows the phrase grid and the account number", () => {
    renderKit();
    expect(screen.getByTestId("create.phrase-grid")).toBeTruthy();
    expect(screen.getByTestId("create.account-number").textContent).toBe(ACCOUNT);
  });

  it("puts both INSIDE the one sheet, which is what makes it a document", () => {
    // Rendering both somewhere on the screen is not the claim. The claim is that
    // they are in the same bordered document, so the user can see they go into
    // one file. Two sibling cards would satisfy the test above and break this.
    renderKit();
    const sheet = screen.getByTestId("create.kit-sheet");
    expect(sheet.contains(screen.getByTestId("create.phrase-grid"))).toBe(true);
    expect(sheet.contains(screen.getByTestId("create.account-number"))).toBe(true);
  });

  it("heads the sheet with the vault's own name and a date", () => {
    renderKit({ vaultName: "Research" });
    const meta = screen.getByTestId("create.kit-meta").textContent ?? "";
    expect(meta).toContain("Research");
    expect(meta).toContain("·");
  });

  it("drops the separator when the vault was left unnamed", () => {
    renderKit({ vaultName: "" });
    expect(screen.getByTestId("create.kit-meta").textContent).not.toContain("·");
  });

  it("says why the words are English, where the question occurs", () => {
    renderKit();
    const note = screen.getByTestId("create.kit-english-note").textContent ?? "";
    expect(note).toContain("BIP-39");
  });
});

describe("Save writes the whole kit", () => {
  it("sends BOTH secrets to the write command, not just the phrase", async () => {
    saveMock.mockResolvedValue("/tmp/kit.txt");
    renderKit();
    fireEvent.click(screen.getByTestId("create.kit-save"));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some((c) => c[0] === "plugin:secret-export|save_secret_text"),
        "nothing was written",
      ).toBe(true),
    );
    const call = invokeMock.mock.calls.find(
      (c) => c[0] === "plugin:secret-export|save_secret_text",
    )!;
    const contents = String((call[1] as { contents: string }).contents);
    expect(contents, "the account number is missing from the kit file").toContain(ACCOUNT);
    expect(contents, "the phrase is missing from the kit file").toContain(
      PHRASE.join(" "),
    );
  });

  it("offers a filename naming the kit rather than one of its halves", async () => {
    saveMock.mockResolvedValue(null);
    renderKit();
    fireEvent.click(screen.getByTestId("create.kit-save"));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(
      (saveMock.mock.calls[0][0] as { defaultPath: string }).defaultPath,
    ).toBe("myne-recovery-kit.txt");
  });

  it("Copy puts the same bytes on the clipboard as Save writes to disk", async () => {
    // One artefact, two destinations. They drifted apart in the old shape: Copy
    // copied the phrase and Save wrote the phrase, while the account number's
    // own Copy and Save were a step away writing something else.
    saveMock.mockResolvedValue("/tmp/kit.txt");
    renderKit();
    fireEvent.click(screen.getByTestId("create.kit-save"));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some((c) => c[0] === "plugin:secret-export|save_secret_text"),
      ).toBe(true),
    );
    const saved = String(
      (
        invokeMock.mock.calls.find(
          (c) => c[0] === "plugin:secret-export|save_secret_text",
        )![1] as { contents: string }
      ).contents,
    );

    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    fireEvent.click(screen.getByTestId("create.kit-copy"));
    await waitFor(() => expect(vi.mocked(writeText)).toHaveBeenCalled());
    expect(vi.mocked(writeText).mock.calls[0][0]).toBe(saved);
  });
});

describe("what the merge removed", () => {
  it("offers no acknowledgement checkbox", () => {
    // §7.1.3: a bare checkbox is not evidence. What gates the commit is the
    // type-back challenge on the next step.
    const { container } = renderKit();
    expect(
      container.querySelector('input[type="checkbox"]'),
      "the acknowledgement checkbox came back",
    ).toBeNull();
  });

  it("states the account number's reason as adding a device", () => {
    renderKit();
    const reason = i18n.t("vaultCreation.kit.accountFor");
    expect(screen.getByText(reason)).toBeTruthy();
    expect(reason.toLowerCase()).toContain("device");
    // And it does NOT send the user off to register for sync, which is neither
    // the next thing they do nor something they can do from here.
    expect(reason.toLowerCase()).not.toContain("register");
  });

  it("advances on a single acknowledgement, with no second secret screen after it", () => {
    const dispatch = vi.fn();
    renderKit({ dispatch });
    fireEvent.click(screen.getByTestId("create.phrase-continue"));
    expect(dispatch).toHaveBeenCalledWith({ type: "PHRASE_ACKED" });
  });
});
