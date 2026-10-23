// @vitest-environment jsdom
//
// The one register-an-identity form (2026-10-23 review).
//
// It exists because the same secret-handling path was written twice: the identity
// home and Settings → Sync each carried the 24 cells, the paste arithmetic, the
// optional server field and the error kinds, and the two copies had already
// drifted (only one ran the beta-terms gate, and only one kept its cells when the
// ADDRESS failed). Every case below is one of those arms.
//
// Keys are echoed (`t: (k) => k`) so this spec is about behaviour, except where
// the copy IS the behaviour: the two failure arms must be distinguishable, and
// that is asserted through the key they resolve.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const personRegister = vi.hoisted(() => vi.fn());
const readSyncEndpoint = vi.hoisted(() => vi.fn());
const writeSyncEndpoint = vi.hoisted(() => vi.fn());
const acceptBetaTerms = vi.hoisted(() => vi.fn());
const betaNeeded = vi.hoisted(() => ({ value: false }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock("../../src/lib/personAccount", () => ({
  personRegister,
  readSyncEndpoint,
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

function fillCells() {
  for (let i = 0; i < PHRASE_CELL_COUNT; i += 1) {
    const id = i === 0 ? "form.register-phrase" : `form.register-phrase-cell-${i + 1}`;
    fireEvent.change(screen.getByTestId(id), { target: { value: PHRASE[i] } });
  }
}

beforeEach(() => {
  personRegister.mockReset().mockResolvedValue({});
  readSyncEndpoint.mockReset().mockResolvedValue("https://sync.example");
  writeSyncEndpoint.mockReset().mockResolvedValue(undefined);
  acceptBetaTerms.mockReset().mockResolvedValue(undefined);
  betaNeeded.value = false;
});
afterEach(cleanup);

describe("PersonRegisterForm", () => {
  it("gates submit on all 24 cells, and sends the joined phrase", async () => {
    const onRegistered = renderForm();
    await waitFor(() => expect(readSyncEndpoint).toHaveBeenCalled());
    const submit = screen.getByTestId("form.register-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fillCells();
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(personRegister).toHaveBeenCalledWith(PHRASE.join(" ")));
    expect(onRegistered).toHaveBeenCalledOnce();
  });

  it("asks for an address only when the device has none, and writes it first", async () => {
    readSyncEndpoint.mockResolvedValue(null);
    renderForm();
    const server = await screen.findByTestId("form.register-server");
    fillCells();
    // The submit stays disabled until the address it asked for exists.
    expect((screen.getByTestId("form.register-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(server, { target: { value: "https://sync.example" } });
    fireEvent.click(screen.getByTestId("form.register-submit"));
    await waitFor(() => expect(writeSyncEndpoint).toHaveBeenCalledWith("https://sync.example"));
    await waitFor(() => expect(personRegister).toHaveBeenCalled());
    // The address is written BEFORE the phrase crosses IPC.
    expect(writeSyncEndpoint.mock.invocationCallOrder[0]!).toBeLessThan(
      personRegister.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps the words when the ADDRESS fails, and blames the address", async () => {
    readSyncEndpoint.mockResolvedValue(null);
    writeSyncEndpoint.mockRejectedValue({ kind: "TlsFailure" });
    renderForm();
    await screen.findByTestId("form.register-server");
    fillCells();
    fireEvent.change(screen.getByTestId("form.register-server"), {
      target: { value: "https://bad.example" },
    });
    fireEvent.click(screen.getByTestId("form.register-submit"));
    expect((await screen.findByTestId("form.register-error")).textContent).toBe(
      "identityHome.registerServerError",
    );
    expect(personRegister).not.toHaveBeenCalled();
    // The one arm that must NOT wipe: the phrase was never the problem.
    expect((screen.getByTestId("form.register-phrase") as HTMLInputElement).value).toBe(
      PHRASE[0],
    );
  });

  it("reveals the address field on a NotConfigured refusal, and wipes the words", async () => {
    personRegister.mockRejectedValue({ kind: "NotConfigured" });
    renderForm();
    await waitFor(() => expect(readSyncEndpoint).toHaveBeenCalled());
    expect(screen.queryByTestId("form.register-server")).toBeNull();
    fillCells();
    fireEvent.click(screen.getByTestId("form.register-submit"));
    expect((await screen.findByTestId("form.register-error")).textContent).toBe(
      "identityHome.registerNeedsServer",
    );
    expect(await screen.findByTestId("form.register-server")).toBeTruthy();
    expect((screen.getByTestId("form.register-phrase") as HTMLInputElement).value).toBe("");
  });

  it("wipes the words on any other registration refusal", async () => {
    personRegister.mockRejectedValue({ kind: "BadRequest" });
    renderForm();
    fillCells();
    fireEvent.click(screen.getByTestId("form.register-submit"));
    expect((await screen.findByTestId("form.register-error")).textContent).toBe(
      "identityHome.registerError",
    );
    expect((screen.getByTestId("form.register-phrase") as HTMLInputElement).value).toBe("");
  });

  it("puts the beta terms in front of the first registration", async () => {
    // Registration is a server-facing act, and the Settings door used to skip
    // the gate the identity home had. A gate at one door is not a gate.
    betaNeeded.value = true;
    renderForm();
    fillCells();
    fireEvent.click(screen.getByTestId("form.register-submit"));
    expect(personRegister).not.toHaveBeenCalled();
    expect(await screen.findByTestId("form.register-beta-terms")).toBeTruthy();
  });

  it("registers after the terms are accepted", async () => {
    betaNeeded.value = true;
    renderForm();
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
