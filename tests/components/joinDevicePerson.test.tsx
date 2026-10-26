// @vitest-environment jsdom
//
// The PERSON door of the join screen (myne-md/myne#911 task 9).
//
// Desktop has no camera, so a code from another device arrives as text and is
// decoded by the same command a phone's scanner calls. What this file pins is the
// step machine and the two calls it exists to make: a person code replaces the
// account form with the phrase step, a pending answer waits and then finishes
// itself through `sync_person_claim_device`, and finishing means `listed` before
// the caller is told the account is on this device. The refusals matter as much
// as the happy path: a member code names a shared vault and belongs on the
// identity screen, and a phrase for a different identity must not be reported as
// a bad server or a bad password.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { JoinDeviceModal } from "../../src/components/sync/JoinDeviceModal";

const PERSON_ID = "ab".repeat(16);

type Router = Record<string, unknown | ((args?: unknown) => unknown)>;

function mount(router: Router) {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    const answer = router[cmd];
    if (answer === undefined) return undefined;
    return typeof answer === "function" ? (answer as (a?: unknown) => unknown)(args) : answer;
  });
  const props = {
    onCancel: vi.fn(),
    onJoined: vi.fn(),
    onRecovering: vi.fn(),
    onAccountJoined: vi.fn(),
  };
  render(<JoinDeviceModal {...props} />);
  return props;
}

/** The modal's own dependencies, answered as a device with nothing configured. */
function baseRouter(over: Router = {}): Router {
  return {
    "plugin:sync|sync_beta_terms_accepted": true,
    "plugin:prefs|prefs_read": { device_names: {} },
    ...over,
  };
}

async function pasteCodeAndContinue(code: string) {
  fireEvent.click(await screen.findByTestId("join.code-open"));
  const input = await screen.findByTestId("join.code-input");
  fireEvent.change(input, { target: { value: code } });
  fireEvent.click(screen.getByTestId("join.code-submit"));
}

/** Fill all 24 phrase cells. They share one testid by design (the grid's cells
 *  are anonymous), so this walks them in DOM order. */
async function fillPhrase(words: string) {
  const cells = await screen.findAllByTestId("join.person-phrase-cell");
  expect(cells).toHaveLength(24);
  for (const cell of cells) {
    fireEvent.change(cell, { target: { value: words } });
  }
}

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe("JoinDeviceModal: the person door", () => {
  it("decodes a person code, takes the phrase, then finishes itself after approval", async () => {
    const props = mount(
      baseRouter({
        "plugin:sync|sync_decode_join_qr": {
          kind: "person",
          endpoint_url: "https://sync.example.org",
          person_id_hex: PERSON_ID,
          fresh: true,
        },
        "plugin:sync|sync_person_join_device": (args?: unknown) => {
          expect(args).toEqual({
            personIdHex: PERSON_ID,
            endpointUrl: "https://sync.example.org",
            phrase: expect.any(String),
          });
          return { person_id_hex: PERSON_ID, approved: false };
        },
        "plugin:sync|sync_person_claim_device": { person_id_hex: PERSON_ID, approved: true },
        "plugin:sync|sync_person_list_vaults": [],
      }),
    );

    await pasteCodeAndContinue(`MYQR3|p|https://sync.example.org|${PERSON_ID}|-|1`);

    // The code named the person, so the account form is gone: the phrase is the
    // only thing left to give.
    await screen.findByTestId("join.person-phrase");
    expect(screen.queryByTestId("join.account-input")).toBeNull();
    await fillPhrase("abandon");
    fireEvent.click(screen.getByTestId("join.person-phrase-submit"));

    // Pending is a real step, and the claim poll is what moves it.
    await screen.findByTestId("join.person-pending");
    await waitFor(() => expect(props.onAccountJoined).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });
    const listed = invokeMock.mock.calls.filter(
      (c) => c[0] === "plugin:sync|sync_person_list_vaults",
    );
    expect(listed).toHaveLength(1);
    // No vault route out of a person join: there is no single vault to open.
    expect(props.onJoined).not.toHaveBeenCalled();
  });

  it("says the code and the phrase disagree instead of blaming the password", async () => {
    mount(
      baseRouter({
        "plugin:sync|sync_decode_join_qr": {
          kind: "person",
          endpoint_url: "https://sync.example.org",
          person_id_hex: PERSON_ID,
          fresh: true,
        },
        "plugin:sync|sync_person_join_device": () => {
          throw { kind: "PersonMismatch" };
        },
      }),
    );

    await pasteCodeAndContinue(`MYQR3|p|https://sync.example.org|${PERSON_ID}|-|1`);
    await screen.findByTestId("join.person-phrase");
    await fillPhrase("abandon");
    fireEvent.click(screen.getByTestId("join.person-phrase-submit"));

    const banner = await screen.findByTestId("join.error");
    expect(banner.textContent).toContain("different identity");
    expect(screen.queryByTestId("join.person-pending")).toBeNull();
  });

  it("sends a shared-vault code to the identity screen rather than a dead form", async () => {
    mount(
      baseRouter({
        "plugin:sync|sync_decode_join_qr": {
          kind: "member_vault",
          endpoint_url: "https://sync.example.org",
          account_hash_hex: "cd".repeat(16),
          fresh: true,
        },
      }),
    );

    await pasteCodeAndContinue(`MYQR3|m|https://sync.example.org|${"cd".repeat(16)}|-|1`);
    const banner = await screen.findByTestId("join.error");
    expect(banner.textContent).toContain("shared vault");
  });

  it("prefills the account form from a legacy account code", async () => {
    mount(
      baseRouter({
        "plugin:sync|sync_decode_join_qr": {
          kind: "account",
          endpoint_url: "https://sync.example.org",
          account_number: "MY-0000-0000-0000-0000-0000",
          fresh: true,
        },
      }),
    );

    await pasteCodeAndContinue("MYQR2|a|https://sync.example.org|MY-0000-0000-0000-0000-0000|-|1");
    const server = (await screen.findByTestId("join.server-input")) as HTMLInputElement;
    expect(server.value).toBe("https://sync.example.org");
    const account = (await screen.findByTestId("join.account-input")) as HTMLInputElement;
    expect(account.value.length).toBeGreaterThan(0);
  });

  it("refuses an expired code and keeps the user on the code step", async () => {
    mount(
      baseRouter({
        "plugin:sync|sync_decode_join_qr": {
          kind: "person",
          endpoint_url: "https://sync.example.org",
          person_id_hex: PERSON_ID,
          fresh: false,
        },
      }),
    );

    await pasteCodeAndContinue(`MYQR3|p|https://sync.example.org|${PERSON_ID}|-|1`);
    const banner = await screen.findByTestId("join.error");
    expect(banner.textContent).toContain("expired");
    expect(screen.getByTestId("join.code-input")).toBeTruthy();
  });
});
