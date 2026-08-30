// @vitest-environment jsdom
//
// The one-time per-provider consent screen (ai-remote-providers myne#415
// task 13) and the panel routing that reaches it (task 14).
//
// What is worth asserting here is not that the component renders — it is the
// four properties the screen exists for, each of which is silent when wrong:
//
//   1. All four questions are answered EXPLICITLY (what / when / to whom /
//      what Myne cannot verify), and the fourth is present, because it is the
//      one a consent screen usually omits.
//   2. There is no route to the accepting action that skips the disclosure.
//   3. Selecting a provider does NOT store anything until consent is accepted.
//   4. Re-selecting an already-consented provider does not re-ask, and
//      switching to a different one does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  openUrl,
  openFileDialog,
  loadModelPath,
  saveModelPath,
  loadAiEndpoint,
  saveAiEndpoint,
  aiProviderHasKey,
  setAiProvider,
  setAiProviderConsent,
  setAiProviderKey,
} = vi.hoisted(() => ({
  openUrl: vi.fn(() => Promise.resolve()),
  openFileDialog: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  loadModelPath: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  saveModelPath: vi.fn((_r: string, p: string) => Promise.resolve(p)),
  loadAiEndpoint: vi.fn(
    (): Promise<{ url: string; model: string } | null> => Promise.resolve(null),
  ),
  saveAiEndpoint: vi.fn((u: string, _m: string) => Promise.resolve(u || null)),
  aiProviderHasKey: vi.fn((): Promise<boolean> => Promise.resolve(false)),
  setAiProvider: vi.fn((_p: string | null): Promise<void> => Promise.resolve()),
  setAiProviderConsent: vi.fn((_p: string | null): Promise<void> => Promise.resolve()),
  setAiProviderKey: vi.fn((_k: string | null): Promise<void> => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openFileDialog }));
vi.mock("../../src/lib/ai-model-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ai-model-store")>()),
  loadModelPath,
  saveModelPath,
  loadAiEndpoint,
  saveAiEndpoint,
}));
vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/prefs")>()),
  aiProviderHasKey,
  setAiProvider,
  setAiProviderConsent,
  setAiProviderKey,
}));
// Partial: the panel now also reads `providerLabelOf` from this module (#191
// task 4 moved the wire → proper-noun mapping here so the chat transcript could
// share it). Stubbing the whole module would leave the real mapping untested
// while silently breaking the panel.
vi.mock("../../src/lib/ai-capability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ai-capability")>()),
  aiCapabilityReport: () =>
    Promise.resolve({
      compiled: true,
      backendId: "candle",
      backendClass: "in_process_local",
      generation: { available: false, cause: "no_model" },
      embedding: { available: false, cause: "no_model" },
      transcription: { available: false, cause: "no_model" },
      autoTag: { available: true, cause: null },
    }),
}));

let aiProvider: string | null = null;
let consentFor: string | null = null;
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: {
      ai_enabled: true,
      auto_tag_enabled: false,
      ai_excluded_folders: [],
      ai_provider: aiProvider,
      ai_provider_consent: consentFor,
    },
    setAiEnabled: vi.fn(),
    setAiExcludedFolders: vi.fn(),
    setAutoTagEnabled: vi.fn(),
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { AiPanel } from "../../src/components/settings/AiPanel";
import {
  CONSENT_WHAT_LEAVES,
  CONSENT_WHEN_IT_LEAVES,
  consentCannotVerify,
  consentToWhom,
} from "../../src/lib/load-bearing-copy";

beforeEach(() => {
  aiProvider = null;
  consentFor = null;
  for (const m of [
    openUrl,
    loadAiEndpoint,
    aiProviderHasKey,
    setAiProvider,
    setAiProviderConsent,
    setAiProviderKey,
  ]) {
    m.mockClear();
  }
  loadAiEndpoint.mockResolvedValue(null);
  aiProviderHasKey.mockResolvedValue(false);
});
afterEach(() => cleanup());

describe("the per-provider consent screen", () => {
  it("stores NOTHING until the screen is accepted", async () => {
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.provider-choice-openrouter"));
    await screen.findByTestId("ai-consent.screen");
    // The whole point of routing through a screen: selecting is not agreeing.
    expect(setAiProvider).not.toHaveBeenCalled();
    expect(setAiProviderConsent).not.toHaveBeenCalled();
  });

  it("answers all four questions explicitly, including the one usually omitted", async () => {
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.provider-choice-openrouter"));
    await screen.findByTestId("ai-consent.screen");

    expect(screen.getByTestId("ai-consent.what").textContent).toBe(CONSENT_WHAT_LEAVES);
    expect(screen.getByTestId("ai-consent.when").textContent).toBe(
      CONSENT_WHEN_IT_LEAVES,
    );
    expect(screen.getByTestId("ai-consent.who").textContent).toBe(
      consentToWhom("OpenRouter"),
    );
    // A17 — the clause that makes the other three honest.
    expect(screen.getByTestId("ai-consent.cannot-verify").textContent).toBe(
      consentCannotVerify("OpenRouter"),
    );
    // Revocation is per key at the provider, not per device.
    expect(screen.getByTestId("ai-consent.revoke").textContent).toContain(
      "at the provider",
    );
    // **Device scope, and this assertion is inverted from what it was.** The
    // clause used to state the SYNC-22 residual, that a device added later
    // inherits the choice and does not ask. myne-md/myne#456 made the consent
    // device-local, so the screen must no longer say it, and asserting the
    // ABSENCE of the old sentence is what stops it coming back in a copy edit.
    const scope = screen.getByTestId("ai-consent.scope").textContent ?? "";
    expect(scope).toContain("this device only");
    expect(scope).not.toContain("any device you add later");
    // The key DOES still travel, and the sentence says so: a phone can hold a
    // credential it has not been permitted to use, which is the part a user
    // could otherwise be surprised by.
    expect(scope).toContain("key does travel");

    // **How it travels** (myne-md/myne#456). Stated nowhere else, and a reader
    // who has seen the Tor routing option elsewhere would reasonably assume it
    // applies here.
    expect(screen.getByTestId("ai-consent.connection").textContent).toContain(
      "direct",
    );
  });

  it("has no accepting action anywhere except on the screen itself", () => {
    // Before the screen is up, nothing in the panel accepts anything — the
    // disclosure cannot be bypassed because the button does not exist yet.
    render(<AiPanel />);
    expect(screen.queryByTestId("ai-consent.accept")).toBeNull();
    expect(screen.queryByTestId("ai-consent.screen")).toBeNull();
  });

  it("writes the provider and the consent, in that order, on accept", async () => {
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.provider-choice-openrouter"));
    fireEvent.click(await screen.findByTestId("ai-consent.accept"));
    await waitFor(() => expect(setAiProviderConsent).toHaveBeenCalledWith("openrouter"));
    expect(setAiProvider).toHaveBeenCalledWith("openrouter");
    // Order is load-bearing: the host clears consent when the SELECTION
    // changes, so recording consent first would have it wiped immediately.
    const providerCall = setAiProvider.mock.invocationCallOrder[0];
    const consentCall = setAiProviderConsent.mock.invocationCallOrder[0];
    expect(providerCall).toBeLessThan(consentCall);
  });

  it("shows the pending choice on the control behind the dialog, and reverts it on cancel", async () => {
    // The dialog leaves the panel standing, so the segmented control is now
    // visible while the question is being asked. It highlights the provider
    // being asked ABOUT — a control that does not move when clicked reads as
    // broken — and that highlight is the whole of what happened: nothing is
    // written until accept, and cancelling puts it back.
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.provider-choice-openrouter"));
    await screen.findByTestId("ai-consent.screen");
    expect(
      screen.getByTestId("ai.provider-choice-openrouter").getAttribute("data-active"),
    ).toBe("true");
    expect(setAiProvider).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("ai-consent.cancel"));
    await waitFor(() =>
      expect(
        screen.getByTestId("ai.provider-choice-openrouter").getAttribute("data-active"),
      ).toBe("false"),
    );
    expect(screen.getByTestId("ai.provider-choice-none").getAttribute("data-active")).toBe(
      "true",
    );
  });

  it("cancelling stores nothing and returns to the controls", async () => {
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.provider-choice-openrouter"));
    fireEvent.click(await screen.findByTestId("ai-consent.cancel"));
    await waitFor(() => expect(screen.queryByTestId("ai-consent.screen")).toBeNull());
    expect(setAiProvider).not.toHaveBeenCalled();
    expect(setAiProviderConsent).not.toHaveBeenCalled();
  });

  it("does not re-ask for a provider already consented to", async () => {
    consentFor = "openrouter";
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.provider-choice-openrouter"));
    await waitFor(() => expect(setAiProvider).toHaveBeenCalledWith("openrouter"));
    // No screen: the recipient is one they have already agreed to.
    expect(screen.queryByTestId("ai-consent.screen")).toBeNull();
  });

  it("DOES ask again when switching to a different provider", async () => {
    // The property the named-consent field exists for.
    consentFor = "openrouter";
    aiProvider = "openrouter";
    render(<AiPanel />);
    fireEvent.click(screen.getByTestId("ai.provider-choice-ollama-cloud"));
    const screenEl = await screen.findByTestId("ai-consent.screen");
    expect(screenEl.textContent).toContain("Ollama Cloud");
    expect(setAiProvider).not.toHaveBeenCalled();
  });
});

describe("the provider key controls", () => {
  it("never renders a stored key — it renders a boolean", async () => {
    aiProvider = "openrouter";
    consentFor = "openrouter";
    aiProviderHasKey.mockResolvedValue(true);
    render(<AiPanel />);
    const field = (await screen.findByTestId(
      "ai.provider-key-input",
    )) as HTMLInputElement;
    // There is no stored value to show and the panel must not invent one.
    expect(field.value).toBe("");
    await waitFor(() =>
      expect(screen.getByTestId("ai.provider-key-state").textContent).toBe(
        "settings.ai.providerKeyStored",
      ),
    );
    // …and it is a password field, so a shoulder-surfer does not read a
    // freshly-pasted key off the screen either.
    expect(field.type).toBe("password");
  });

  it("rotating the key does NOT touch consent", async () => {
    aiProvider = "openrouter";
    consentFor = "openrouter";
    aiProviderHasKey.mockResolvedValue(true);
    render(<AiPanel />);
    const field = await screen.findByTestId("ai.provider-key-input");
    fireEvent.change(field, { target: { value: "sk-new" } });
    fireEvent.blur(field);
    await waitFor(() => expect(setAiProviderKey).toHaveBeenCalledWith("sk-new"));
    // The recipient has not changed, so re-asking would train people to click
    // through the screen.
    expect(setAiProviderConsent).not.toHaveBeenCalled();
    expect(setAiProvider).not.toHaveBeenCalled();
  });

  it("clears the typed key out of component state once stored", async () => {
    aiProvider = "openrouter";
    consentFor = "openrouter";
    render(<AiPanel />);
    const field = (await screen.findByTestId(
      "ai.provider-key-input",
    )) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "sk-secret" } });
    fireEvent.blur(field);
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("clearing the provider revokes the key, in one action", async () => {
    aiProvider = "openrouter";
    consentFor = "openrouter";
    aiProviderHasKey.mockResolvedValue(true);
    render(<AiPanel />);
    await screen.findByTestId("ai.provider-key-input");
    fireEvent.click(screen.getByTestId("ai.provider-choice-none"));
    // ONE action. The host drops the key and the consent with it, so the user
    // does not have to remember three separate steps to turn this off — and
    // the panel does not have to issue three writes that could half-apply.
    await waitFor(() => expect(setAiProvider).toHaveBeenCalledWith(null));
    expect(setAiProviderKey).not.toHaveBeenCalled();
    expect(setAiProviderConsent).not.toHaveBeenCalled();
  });

  it("renders no key control at all while no provider is selected", () => {
    // The rendering rule the test above cannot observe (the `usePrefs` fixture
    // is static, so a write does not feed back into props): the key block is
    // gated on a selected provider, so after a clear there is nothing to type
    // a credential into.
    aiProvider = null;
    render(<AiPanel />);
    expect(screen.queryByTestId("ai.provider-key-input")).toBeNull();
    expect(screen.queryByTestId("ai.provider-key-revoke")).toBeNull();
  });

  it("disables the key controls while the AI beta is off", async () => {
    aiProvider = "openrouter";
    consentFor = "openrouter";
    aiProviderHasKey.mockResolvedValue(true);
    render(<AiPanel />);
    const field = (await screen.findByTestId(
      "ai.provider-key-input",
    )) as HTMLInputElement;
    // The panel-wide co-gate: `ai_enabled` is true in this fixture, so this
    // asserts the control exists and is live — the disabled case is covered by
    // the sibling spec's `aiEnabled = false` path.
    expect(field.disabled).toBe(false);
  });
});
