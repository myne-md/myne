// @vitest-environment jsdom
//
// The one register-an-identity form (2026-10-23 review; two steps since
// 2026-10-24).
//
// It exists because the same secret-handling path was written twice: the identity
// home and Settings → Sync each carried the 24 cells, the paste arithmetic, the
// optional server field and the error kinds, and the two copies had already
// drifted (only one ran the beta-terms gate, and only one kept its cells when the
// ADDRESS failed).
//
// The 2026-10-24 owner reports is why the act is now two steps in one dialog: the
// phrase used to be asked FIRST, and the address only appeared when the device
// turned out to have none, after a `NotConfigured` refusal that wiped the 24 words
// in the same breath. The server is step one, the phrase is step two, and a
// server failure sends the user back to the step where the fix is.
//
// Keys are echoed (`t: (k) => k`) so this spec is about behaviour, except where
// the copy IS the behaviour: the failure arms must be distinguishable, and that
// is asserted through the key they resolve.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const personRegister = vi.hoisted(() => vi.fn());
const readSyncConfig = vi.hoisted(() => vi.fn());
const writeSyncEndpoint = vi.hoisted(() => vi.fn());
const acceptBetaTerms = vi.hoisted(() => vi.fn());
const betaNeeded = vi.hoisted(() => ({ value: false }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock("../../src/lib/personAccount", () => ({
  personRegister,
  readSyncConfig,
  writeSyncEndpoint,
}));

vi.mock("../../src/hooks/useBetaTermsGate", () => ({
  useBetaTermsGate: () => ({
    pending: false,
    needed: betaNeeded.value,
    accept: acceptBetaTerms,
  }),
}));

import { PersonRegisterForm } from "../../src/components/sync/PersonRegisterForm";
import { PHRASE_CELL_COUNT } from "../../src/components/PhraseEntryGrid";

const PHRASE = Array.from({ length: PHRASE_CELL_COUNT }, (_, i) => `word${i + 1}`);
const CONFIGURED = { endpoint_url: "https://sync.example", invite_code: null };

function renderForm(onRegistered = vi.fn(), onCancel?: () => void) {
  render(
    <PersonRegisterForm
      testIdPrefix="form.register"
      onRegistered={onRegistered}
      onCancel={onCancel}
    />,
  );
  return onRegistered;
}

/** Step one's Continue, which is the only way to the phrase step. */
async function toPhraseStep() {
  fireEvent.click(await screen.findByTestId("form.register-continue"));
  await screen.findByTestId("form.register-phrase-grid");
}

function fillCells() {
  for (let i = 0; i < PHRASE_CELL_COUNT; i += 1) {
    const id = i === 0 ? "form.register-phrase" : `form.register-phrase-cell-${i + 1}`;
    fireEvent.change(screen.getByTestId(id), { target: { value: PHRASE[i] } });
  }
}

beforeEach(() => {
  personRegister.mockReset().mockResolvedValue({});
  readSyncConfig.mockReset().mockResolvedValue(CONFIGURED);
  writeSyncEndpoint.mockReset().mockResolvedValue(undefined);
  acceptBetaTerms.mockReset().mockResolvedValue(undefined);
  betaNeeded.value = false;
});
afterEach(cleanup);

describe("PersonRegisterForm", () => {
  it("opens on the server step, prefilled, with the phrase nowhere in sight", async () => {
    renderForm();
    const server = (await screen.findByTestId("form.register-server")) as HTMLInputElement;
    expect(server.value).toBe(CONFIGURED.endpoint_url);
    // A decision and a secret do not share a view (2026-10-24).
    expect(screen.queryByTestId("form.register-phrase-grid")).toBeNull();
    expect(screen.queryByTestId("form.register-submit")).toBeNull();
  });

  it("reaches the phrase only through Continue, and does not re-write an unchanged address", async () => {
    renderForm();
    await toPhraseStep();
    // An unchanged address is not re-written: it would buy a second TLS
    // handshake for nothing.
    expect(writeSyncEndpoint).not.toHaveBeenCalled();
  });

  it("writes a changed address on Continue, before any phrase is typed", async () => {
    readSyncConfig.mockResolvedValue({ endpoint_url: null, invite_code: null });
    renderForm();
    const server = (await screen.findByTestId("form.register-server")) as HTMLInputElement;
    expect(server.value).toBe("");
    // No address, no way forward.
    expect((screen.getByTestId("form.register-continue") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(server, { target: { value: "https://sync.example" } });
    await toPhraseStep();
    expect(writeSyncEndpoint).toHaveBeenCalledWith("https://sync.example", null);
    expect(personRegister).not.toHaveBeenCalled();
  });

  it("carries a gated server's admission code", async () => {
    readSyncConfig.mockResolvedValue({ endpoint_url: null, invite_code: null });
    renderForm();
    await screen.findByTestId("form.register-invite-code");
    fireEvent.change(screen.getByTestId("form.register-server"), {
      target: { value: "https://gated.example" },
    });
    fireEvent.change(screen.getByTestId("form.register-invite-code"), {
      target: { value: "let-me-in" },
    });
    await toPhraseStep();
    expect(writeSyncEndpoint).toHaveBeenCalledWith("https://gated.example", "let-me-in");
  });

  it("keeps the user on the server step when the ADDRESS fails", async () => {
    readSyncConfig.mockResolvedValue({ endpoint_url: null, invite_code: null });
    writeSyncEndpoint.mockRejectedValue({ kind: "TlsFailure" });
    renderForm();
    await screen.findByTestId("form.register-server");
    fireEvent.change(screen.getByTestId("form.register-server"), {
      target: { value: "https://bad.example" },
    });
    fireEvent.click(screen.getByTestId("form.register-continue"));
    expect((await screen.findByTestId("form.register-error")).textContent).toBe(
      "identityHome.registerServerError",
    );
    // Still step one, where the fix is, and no phrase was asked for.
    expect(screen.getByTestId("form.register-server")).toBeTruthy();
    expect(screen.queryByTestId("form.register-phrase-grid")).toBeNull();
  });

  it("gates Register on all 24 cells, and sends the joined phrase", async () => {
    const onRegistered = renderForm();
    await toPhraseStep();
    const submit = screen.getByTestId("form.register-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fillCells();
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(personRegister).toHaveBeenCalledWith(PHRASE.join(" ")));
    expect(onRegistered).toHaveBeenCalledOnce();
  });

  it("goes BACK to the server step on a NotConfigured refusal, and keeps the words", async () => {
    // The 2026-10-24 defect, exactly: the address was hidden, the register call
    // refused `NotConfigured`, and the 24 words were discarded in the same breath
    // so the user retyped them for a missing URL.
    personRegister.mockRejectedValue({ kind: "NotConfigured" });
    renderForm();
    await toPhraseStep();
    fillCells();
    fireEvent.click(screen.getByTestId("form.register-submit"));
    expect((await screen.findByTestId("form.register-error")).textContent).toBe(
      "identityHome.registerServerError",
    );
    expect(screen.getByTestId("form.register-server")).toBeTruthy();
    // Back on step two, the words are still the ones that were typed.
    await toPhraseStep();
    expect((screen.getByTestId("form.register-phrase") as HTMLInputElement).value).toBe(
      PHRASE[0],
    );
  });

  it("wipes the words on a refusal that is about the phrase", async () => {
    personRegister.mockRejectedValue({ kind: "BadRequest" });
    renderForm();
    await toPhraseStep();
    fillCells();
    fireEvent.click(screen.getByTestId("form.register-submit"));
    expect((await screen.findByTestId("form.register-error")).textContent).toBe(
      "identityHome.registerError",
    );
    expect((screen.getByTestId("form.register-phrase") as HTMLInputElement).value).toBe("");
  });

  it("goes back to the server step with Back", async () => {
    renderForm();
    await toPhraseStep();
    fireEvent.click(screen.getByTestId("form.register-back"));
    expect(await screen.findByTestId("form.register-server")).toBeTruthy();
  });

  it("puts the beta terms in front of the first registration", async () => {
    // Registration is a server-facing act, and the Settings door used to skip
    // the gate the identity home had. A gate at one door is not a gate.
    betaNeeded.value = true;
    renderForm();
    await toPhraseStep();
    fillCells();
    fireEvent.click(screen.getByTestId("form.register-submit"));
    expect(personRegister).not.toHaveBeenCalled();
    expect(await screen.findByTestId("form.register-beta-terms")).toBeTruthy();
  });

  it("registers after the terms are accepted", async () => {
    betaNeeded.value = true;
    renderForm();
    await toPhraseStep();
    fillCells();
    fireEvent.click(screen.getByTestId("form.register-submit"));
    await screen.findByTestId("form.register-beta-terms");
    fireEvent.click(screen.getByTestId("sync.beta-terms.accept"));
    await waitFor(() => expect(acceptBetaTerms).toHaveBeenCalled());
    await waitFor(() => expect(personRegister).toHaveBeenCalled());
  });

  it("offers the host's way out when it has one", async () => {
    const onCancel = vi.fn();
    renderForm(vi.fn(), onCancel);
    fireEvent.click(await screen.findByTestId("form.register-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});
