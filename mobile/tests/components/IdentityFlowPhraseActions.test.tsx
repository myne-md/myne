// @vitest-environment jsdom
//
// Copy and Save on the identity phrase screen (myne-md/myne#970 item 20).
//
// The screen said "write these 24 words down and keep them safe" and offered no
// way to move the words off the screen. Every other secret-bearing surface in the
// app does (`CreateVaultFlow`'s kit), and the gap is what pushes people to
// screenshot a phrase — the thing `screen_guard` exists to prevent. So what this
// spec pins is the pair of actions, what they hand over, and the one thing that
// must NOT happen: a Copy button on a device whose clipboard cannot hold a secret.
//
// The transports are mocked at the module boundary, because the tier is the
// screen rather than the platform: `copySecretToClipboard` and
// `saveSecretToDocuments` are the two calls whose ARGUMENTS are the assertion.
// `canHoldSecretOnClipboard` is mocked per test, which is how the absent case is
// exercised at all.
//
// The document itself is the assertion that matters most. A copy of the wrong 24
// words, or a save of a file missing the identity code, is silent: the user gets
// a confirmation and a file they cannot recover from.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personSetup = vi.hoisted(() => vi.fn());
const personStatus = vi.hoisted(() => vi.fn());
const personListInvites = vi.hoisted(() => vi.fn());
const personAccountNumber = vi.hoisted(() => vi.fn());
const canHoldSecretOnClipboard = vi.hoisted(() => vi.fn());
const copySecretToClipboard = vi.hoisted(() => vi.fn());
const saveSecretToDocuments = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/app-window", () => ({ HAS_TAURI: true }));
vi.mock("../../src/lib/personAccount", () => ({
  personSetup,
  personStatus,
  personListInvites,
  personAccountNumber,
  personLock: vi.fn(),
  personAcceptInvite: vi.fn(),
  personJoinVault: vi.fn(),
  personJoinDevice: vi.fn(),
  personClaimDevice: vi.fn(),
  personListVaults: vi.fn(),
  personRegister: vi.fn(),
  personUnlock: vi.fn(),
}));
vi.mock("../../src/lib/clipboardTransport", () => ({ canHoldSecretOnClipboard }));
vi.mock("../../src/lib/secret-export", async (importOriginal) => ({
  // The real `secretSaveMessage`, so the sentence asserted below is the shipped
  // mapping rather than a second copy of it in this file.
  ...(await importOriginal<typeof import("../../src/lib/secret-export")>()),
  copySecretToClipboard,
  saveSecretToDocuments,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import { IdentityFlow } from "../../src/app/flows/IdentityFlow";

/** BIP-39, in order, so the phrase is valid-shaped and 24 words wide. */
const PHRASE = [
  "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
  "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid",
  "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual",
];
const IDENTITY_CODE = "MYNE-PERSON-1:" + "ab".repeat(16);

const SETUP_VIEW = {
  phrase: PHRASE.join(" "),
  fingerprint_hex: "cd".repeat(32),
  person_id_hex: "ef".repeat(16),
  identity_code: IDENTITY_CODE,
  approved: true,
};

/** Walk to the phrase screen with the words already revealed. */
async function revealPhrase(): Promise<void> {
  render(<IdentityFlow onCancel={() => {}} />);
  fireEvent.click(await screen.findByTestId("identity-flow.start"));
  fireEvent.click(await screen.findByTestId("identity-flow.create"));
  fireEvent.click(await screen.findByTestId("identity-flow.phrase-reveal"));
}

beforeEach(() => {
  personSetup.mockResolvedValue(SETUP_VIEW);
  personStatus.mockResolvedValue({ enrolled: false, state: null });
  personListInvites.mockResolvedValue([]);
  personAccountNumber.mockResolvedValue(null);
  canHoldSecretOnClipboard.mockResolvedValue(true);
  copySecretToClipboard.mockResolvedValue(null);
  saveSecretToDocuments.mockResolvedValue({ kind: "shared" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("IdentityFlow phrase actions (myne-md/myne#970 item 20)", () => {
  it("offers Copy and Save once the words are on screen, and not before", async () => {
    render(<IdentityFlow onCancel={() => {}} />);
    fireEvent.click(await screen.findByTestId("identity-flow.start"));
    fireEvent.click(await screen.findByTestId("identity-flow.create"));

    // The words are hidden behind Reveal, and a Copy button beside a hidden grid
    // would copy a phrase the user has not looked at.
    expect(screen.queryByTestId("identity-flow.phrase-copy")).toBeNull();
    expect(screen.queryByTestId("identity-flow.phrase-save")).toBeNull();

    fireEvent.click(await screen.findByTestId("identity-flow.phrase-reveal"));

    expect(await screen.findByTestId("identity-flow.phrase-copy")).toBeTruthy();
    expect(await screen.findByTestId("identity-flow.phrase-save")).toBeTruthy();
  });

  it("copies the whole phrase and the identity code, not a fragment", async () => {
    await revealPhrase();

    fireEvent.click(await screen.findByTestId("identity-flow.phrase-copy"));

    await waitFor(() => expect(copySecretToClipboard).toHaveBeenCalledTimes(1));
    const [text] = copySecretToClipboard.mock.calls[0] as [string, unknown];
    for (const word of PHRASE) expect(text).toContain(word);
    expect(text).toContain(IDENTITY_CODE);
    // The words in ORDER, which `toContain` per word does not prove: a document
    // holding all 24 in the wrong sequence is not a recoverable phrase.
    expect(text).toContain(PHRASE.join(" "));
  });

  it("saves the same document under a name that says which secret it holds", async () => {
    await revealPhrase();

    fireEvent.click(await screen.findByTestId("identity-flow.phrase-save"));

    await waitFor(() => expect(saveSecretToDocuments).toHaveBeenCalledTimes(1));
    const [filename, text] = saveSecretToDocuments.mock.calls[0] as [string, string];
    expect(filename).toBe("myne-identity-phrase.txt");
    expect(text).toContain(PHRASE.join(" "));
    // The outcome sentence is the SHIPPED mapping for the delivery the platform
    // reported, not a generic "saved": `shared` is the arm that says the file is
    // inside the app where a file browser cannot reach it.
    expect(
      await screen.findByText("createVault.savedToShareSheet"),
    ).toBeTruthy();
  });

  it("hides Copy where the OS cannot hold a secret on the clipboard", async () => {
    canHoldSecretOnClipboard.mockResolvedValue(false);
    await revealPhrase();

    // The absence has to be read AFTER the probe settles, or it is satisfied by
    // the first frame of every device. Save is the control that must remain: it
    // is the route that works everywhere.
    expect(await screen.findByTestId("identity-flow.phrase-save")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByTestId("identity-flow.phrase-copy")).toBeNull(),
    );
  });
});
