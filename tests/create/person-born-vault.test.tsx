// @vitest-environment jsdom
//
// The person-born creation flow has no vault phrase (myne-md/myne#911 task 5).
//
// A phrase-less `BEGIN_OK` is the one case where the recovery kit would have
// nothing to show and the type-back would have nothing to ask for: rendering
// either of them would put an empty 24-word grid in front of the user and gate
// "finish" behind words that do not exist. So the reducer skips both and goes
// straight to writing the vault.
//
// The interesting half is the failure path, because that is where the missing
// steps bite. `COMMIT_ERR` normally returns to `confirm`, which for a
// phrase-less run is a screen the user never saw and cannot answer; the reducer
// must send them back to the password step instead, with the error attached
// there.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../../src/lib/app-window", () => ({ HAS_TAURI: false }));

import {
  initialState,
  vaultCreationReducer,
  type ErrorState,
} from "../../src/screens/vault-creation/reducer";

afterEach(cleanup);

const error: ErrorState = {
  title: "Couldn't save the vault",
  body: "Try again.",
  primaryAction: "retry",
  displayMode: "inline",
};

const beginOk = (phrase: string[] | null) =>
  ({
    type: "BEGIN_OK" as const,
    phrase,
    accountNumber: "MY-4K7P-N3RM-9QXC-VBHT-2",
    sessionToken: "11111111-1111-7111-8111-111111111111",
  });

describe("a person-born vault skips the kit and the type-back", () => {
  it("goes straight to committing when there is no phrase", () => {
    const next = vaultCreationReducer(initialState, beginOk(null));
    expect(next.step).toBe("committing");
    expect(next.phrase).toBeNull();
    // No challenge positions: there is no phrase to draw them from, and the
    // confirm screen is never reached.
    expect(next.confirmPositions).toBeNull();
    // The account number still stands in, because it is the PERSON's and the
    // user may want to see it.
    expect(next.accountNumber).toBe("MY-4K7P-N3RM-9QXC-VBHT-2");
  });

  it("skips the kit when provisioning ran for a phrase-less vault (web)", () => {
    // The browser registers the vault before writing it, so provisioning runs
    // even for a person-born vault. `PROVISION_OK` used to return `kit`
    // unconditionally, on the assumption that a phrase always exists there; the
    // identity-first web entry made that false, and the failure is an empty
    // 24-word grid with a dead "next" button.
    const begun = vaultCreationReducer(initialState, {
      ...beginOk(null),
      requiresProvisioning: true,
    });
    expect(begun.step, "provisioning takes precedence on web").toBe("provisioning");

    const provisioned = vaultCreationReducer(begun, { type: "PROVISION_OK" });
    expect(provisioned.step, "a phrase-less vault goes straight to writing").toBe("committing");
    expect(provisioned.phrase).toBeNull();
  });

  it("still shows the kit when a phrase exists", () => {
    const next = vaultCreationReducer(
      initialState,
      beginOk(Array.from({ length: 24 }, (_, i) => `w${i}`)),
    );
    expect(next.step).toBe("kit");
    expect(next.confirmPositions).not.toBeNull();
  });

  it("keeps provisioning ahead of committing when sync is required", () => {
    // The web client still mints a phrase, so its ordering is unchanged: the
    // vault is written and registered before the words are shown.
    const next = vaultCreationReducer(initialState, {
      ...beginOk(["a"]),
      requiresProvisioning: true,
    });
    expect(next.step).toBe("provisioning");
  });

  it("returns a failed phrase-less commit to the password step, not to confirm", () => {
    const committing = vaultCreationReducer(initialState, beginOk(null));
    const failed = vaultCreationReducer(committing, {
      type: "COMMIT_ERR",
      error,
    });
    expect(failed.step).toBe("password");
    expect(failed.error).toEqual(error);
    // Whatever the user typed as a name survives, like every other reset.
    expect(failed.vaultName).toBe(initialState.vaultName);
  });

  it("returns a failed phrase-backed commit to confirm, unchanged", () => {
    const withPhrase = vaultCreationReducer(
      initialState,
      beginOk(Array.from({ length: 24 }, (_, i) => `w${i}`)),
    );
    const failed = vaultCreationReducer(withPhrase, {
      type: "COMMIT_ERR",
      error,
    });
    expect(failed.step).toBe("confirm");
  });
});
