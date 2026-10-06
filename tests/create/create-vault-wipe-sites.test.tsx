// @vitest-environment jsdom
//
// VC-7/VC-8 downgrade targets (MYND-124 task 7; SYNC-5):
//
// (a) passwordRef wipe-sites. The ref is component-internal by design
//     (never in reducer state), so each wipe is asserted through the
//     OBSERVABLE contract that shares its code path:
//     - auto-unlock resolve (success AND failure): the only consumer of
//       the ref is the chained `vault_unlock` — after one resolve, a
//       second Done click MUST take the defensive no-password arm
//       (no second unlock IPC; `onAutoUnlockFailed` fires). That is the
//       reference-release, observed.
//     - Phrase-Back / unmount: the wipe lives inside the same handler /
//       cleanup that fires the session-`cancel` IPC and (for Back)
//       remounts an EMPTY password form — both observable.
//     - begin error: the wipe shares the BEGIN_ERR arm with the inline
//       banner + step regression.
//     SYNC-5: reference-release assertions only — no zeroization claim
//     (JS strings are immutable; the load-bearing zeroize is Rust-side).
//
// (b) SessionLostStep rendering (VC-7): SessionExpired vs
//     SessionNotFound produce DISTINCT copies; "Start over" dispatches
//     RESET. No TTL hook, no 10-minute wait — the mapping + screen are
//     pinned directly.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("../../src/lib/app-window", () => ({
  HAS_TAURI: true,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: async () => true,
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/tmp/app-data",
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: async () => {},
}));

import { CreateVault } from "../../src/screens/CreateVault";
import { SessionLostStep } from "../../src/screens/vault-creation/SessionLostStep";
import { mapAppErrorToUserMessage } from "../../src/lib/vault-creation-errors";

const PASSWORD = "Tk9#mQ4!wX7&zR2p-cmp";
const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);
const TOKEN = "11111111-2222-4333-8444-555555555555";
const VAULT_NAME = "Research";
const NEW_VAULT_ID = "00000000-0000-7000-8000-0000000000aa";

function beginResult() {
  // secret-scan:allow — test fixture, not a credential
  return { phrase: PHRASE, account_number: "MY-0000-0000-0000-0000-0000", session_token: TOKEN };
}

/** Default invoke behavior: begin/commit/cancel/unlock all succeed. */
function happyInvoke(cmd: string): Promise<unknown> {
  switch (cmd) {
    case "plugin:vault-creation|begin":
      return Promise.resolve(beginResult());
    case "plugin:vault-creation|commit":
      return Promise.resolve(NEW_VAULT_ID);
    case "plugin:vault-creation|cancel":
      return Promise.resolve(undefined);
    case "plugin:vault-unlock|unlock":
      return Promise.resolve(undefined);
    default:
      return Promise.resolve(undefined);
  }
}

function renderCreateVault(overrides?: {
  onAutoUnlockSuccess?: (id: string | null) => void;
  onAutoUnlockFailed?: (id: string | null) => void;
}) {
  return render(
    <CreateVault
      onBack={() => {}}
      onAutoUnlockSuccess={overrides?.onAutoUnlockSuccess ?? (() => {})}
      onAutoUnlockFailed={overrides?.onAutoUnlockFailed ?? (() => {})}
    />,
  );
}

/**
 * Step over the vault-name step, which is the flow's first screen since
 * myne-md/myne#468. A name is typed rather than skipped: the value rides in
 * reducer state all the way to the auto-unlock, so a test that left it empty
 * would exercise the one branch where nothing is applied.
 */
async function submitName(): Promise<void> {
  fireEvent.change(await screen.findByTestId("create.name-input"), {
    target: { value: VAULT_NAME },
  });
  fireEvent.click(screen.getByTestId("create.name-continue"));
  await screen.findByTestId("create.password-input");
}

async function submitPassword(): Promise<void> {
  await submitName();
  fireEvent.change(screen.getByTestId("create.password-input"), {
    target: { value: PASSWORD },
  });
  fireEvent.change(screen.getByTestId("create.confirm-input"), {
    target: { value: PASSWORD },
  });
  const submit = screen.getByTestId("create.submit") as HTMLButtonElement;
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.click(submit);
}

/** Drive begin → recovery kit → confirm (which commits) → ReadyStep. */
async function driveToReady(): Promise<void> {
  await submitPassword();
  await screen.findByTestId("create.phrase-grid");
  fireEvent.click(screen.getByTestId("create.phrase-reveal"));
  fireEvent.click(screen.getByTestId("create.phrase-continue"));
  const cells = await screen.findAllByTestId("create.confirm-input");
  expect(cells.length).toBe(4);
  for (const cell of cells) {
    const pos = Number(cell.getAttribute("data-index"));
    fireEvent.change(cell, { target: { value: PHRASE[pos - 1] } });
  }
  // The challenge's Continue IS the commit now: the account number moved into
  // the kit step and its acknowledgement checkbox was deleted rather than moved,
  // because `protocol.md` §7.1.3 says a checkbox is not evidence and the
  // type-back this button is gated on already is.
  const cont = screen.getByTestId("create.confirm-continue") as HTMLButtonElement;
  await waitFor(() => expect(cont.disabled).toBe(false));
  fireEvent.click(cont);
  await screen.findByTestId("create.ready-done");
}

function unlockCalls(): number {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === "plugin:vault-unlock|unlock").length;
}

function cancelCalls(): Array<Record<string, unknown> | undefined> {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "plugin:vault-creation|cancel")
    .map(([, args]) => args);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("passwordRef wipe-sites (SYNC-5 reference-release contracts)", () => {
  it("auto-unlock SUCCESS releases the password: a second Done cannot re-fire unlock", async () => {
    invokeMock.mockImplementation(happyInvoke);
    const onSuccess = vi.fn();
    const onFailed = vi.fn();
    renderCreateVault({ onAutoUnlockSuccess: onSuccess, onAutoUnlockFailed: onFailed });
    await driveToReady();

    fireEvent.click(screen.getByTestId("create.ready-done"));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(NEW_VAULT_ID));
    expect(unlockCalls()).toBe(1);

    // The parent (mocked) did not unmount us — a real App would have.
    // Second Done: the ref is gone, so the defensive no-password arm
    // fires WITHOUT a second unlock IPC.
    fireEvent.click(screen.getByTestId("create.ready-done"));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(NEW_VAULT_ID));
    expect(unlockCalls()).toBe(1);
  });

  it("auto-unlock FAILURE releases the password: retry takes the no-password arm", async () => {
    invokeMock.mockImplementation((cmd) =>
      cmd === "plugin:vault-unlock|unlock"
        ? Promise.reject({ kind: "JoinFailure" })
        : happyInvoke(cmd),
    );
    const onFailed = vi.fn();
    renderCreateVault({ onAutoUnlockFailed: onFailed });
    await driveToReady();

    fireEvent.click(screen.getByTestId("create.ready-done"));
    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
    expect(unlockCalls()).toBe(1);

    fireEvent.click(screen.getByTestId("create.ready-done"));
    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(2));
    // Still exactly one unlock IPC — the released ref cannot retry.
    expect(unlockCalls()).toBe(1);
  });

  it("Phrase-Back cancels the backend session and remounts an EMPTY password form", async () => {
    invokeMock.mockImplementation(happyInvoke);
    renderCreateVault();
    await submitPassword();
    await screen.findByTestId("create.phrase-grid");

    fireEvent.click(screen.getByTestId("create.phrase-back"));
    const pw = await screen.findByTestId("create.password-input");
    expect((pw as HTMLInputElement).value).toBe("");
    expect(
      (screen.getByTestId("create.confirm-input") as HTMLInputElement).value,
    ).toBe("");
    await waitFor(() => expect(cancelCalls()).toHaveLength(1));
    expect(cancelCalls()[0]).toEqual({ sessionToken: TOKEN });
  });

  it("unmount mid-flow fires the cancel cleanup (the same cleanup releases the ref)", async () => {
    invokeMock.mockImplementation(happyInvoke);
    const { unmount } = renderCreateVault();
    await submitPassword();
    await screen.findByTestId("create.phrase-grid");

    unmount();
    await waitFor(() => expect(cancelCalls()).toHaveLength(1));
    expect(cancelCalls()[0]).toEqual({ sessionToken: TOKEN });
  });

  it("begin error regresses to the password step with an inline banner (wipe co-located)", async () => {
    invokeMock.mockImplementation((cmd) =>
      cmd === "plugin:vault-creation|begin"
        ? Promise.reject({ kind: "Io", detail: { kind: "Other" } })
        : happyInvoke(cmd),
    );
    renderCreateVault();
    await submitPassword();

    // BEGIN_ERR: stays on the password step, inline banner mounted.
    const banner = await screen.findByRole("alert");
    expect(banner.textContent ?? "").not.toBe("");
    expect(screen.getByTestId("create.password-input")).toBeTruthy();
  });
});

describe("SessionLostStep rendering (VC-7 downgrade: no TTL hook, no wait)", () => {
  it("SessionExpired and SessionNotFound render DISTINCT dedicated copies", () => {
    const expired = mapAppErrorToUserMessage({ kind: "SessionExpired" });
    const notFound = mapAppErrorToUserMessage({ kind: "SessionNotFound" });
    expect(expired.displayMode).toBe("dedicated");
    expect(notFound.displayMode).toBe("dedicated");

    const { unmount } = render(<SessionLostStep error={expired} dispatch={() => {}} />);
    expect(screen.getByText("Session expired")).toBeTruthy();
    expect(
      screen.getByText(
        "For your security, vault creation times out after 10 minutes. Start over.",
      ),
    ).toBeTruthy();
    unmount();

    render(<SessionLostStep error={notFound} dispatch={() => {}} />);
    expect(screen.getByText("Session not found")).toBeTruthy();
    expect(screen.getByText("Start over from the beginning.")).toBeTruthy();
  });

  it("Start over dispatches RESET", () => {
    const dispatch = vi.fn();
    render(
      <SessionLostStep
        error={mapAppErrorToUserMessage({ kind: "SessionExpired" })}
        dispatch={dispatch}
      />,
    );
    fireEvent.click(screen.getByTestId("create.session-lost-start-over"));
    expect(dispatch).toHaveBeenCalledWith({ type: "RESET" });
  });
});
