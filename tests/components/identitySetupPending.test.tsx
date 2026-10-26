// @vitest-environment jsdom
//
// The identity ceremony's "waiting for approval" note (myne-md/myne#911).
//
// The defect this file exists for: the note was gated on
// `PersonSetupView.approved`, and `sync_person_setup` registers nothing, so both
// of its arms answer `approved: false` unconditionally. The result was a first
// device, which is `reserved` and waiting for nobody, being told another device
// had to approve it. The gate is now the disk lifecycle (`pending`), and every
// case below hands `personSetup` the real `approved: false`, so a regression to
// the old condition fails the first test immediately.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const personSetupMock = vi.fn();
const personStatusMock = vi.fn();

vi.mock("../../src/lib/personAccount", () => ({
  personSetup: (...args: unknown[]) => personSetupMock(...args),
  personStatus: (...args: unknown[]) => personStatusMock(...args),
}));

// `forgetAndCreate` reaches the lock path; nothing in these cases takes it, but
// the module has to resolve.
vi.mock("../../src/lib/invite", () => ({
  personLock: vi.fn(async () => {}),
}));

import { IdentitySetupPanel } from "../../src/components/IdentitySetupPanel";

function statusOf(state: "reserved" | "pending" | "enrolled") {
  return {
    enrolled: state === "enrolled",
    state,
    identity_unlocked: true,
    person_id_hex: null,
    identity_code: null,
    // False so the fork renders and the Create arm is reachable; a held
    // identity would hide it behind the recover grid, and filling 24 cells is
    // not what this file is about.
    sealed_keypair_present: false,
  };
}

// A recovery: no phrase echoed, and the backend's hardcoded `approved: false`,
// because that is exactly what `person_setup` answers on both arms.
const SETUP_VIEW = {
  phrase: null,
  fingerprint_hex: "00".repeat(32),
  person_id_hex: "11".repeat(16),
  identity_code: "MYNE-PERSON-1:00:00:00:00",
  approved: false,
};

const PENDING_TESTID = "identity-setup.pending";

async function runCreateArm() {
  render(<IdentitySetupPanel onDone={() => {}} />);
  // The create arm: one press, no phrase grid. The mocked view echoes no
  // phrase, so the ceremony lands on the recovered body, and the note's gate is
  // independent of which body is showing.
  fireEvent.click(await screen.findByTestId("identity-setup.create-cta"));
  await screen.findByTestId("identity-setup.close-cta");
}

beforeEach(() => {
  personSetupMock.mockReset();
  personStatusMock.mockReset();
  personSetupMock.mockResolvedValue(SETUP_VIEW);
});

afterEach(cleanup);

describe("identitySetup pending note", () => {
  it("is absent on a reserved device, which is waiting for nobody", async () => {
    personStatusMock.mockResolvedValue(statusOf("reserved"));
    await runCreateArm();
    expect(screen.queryByTestId(PENDING_TESTID)).toBeNull();
  });

  it("is absent on an enrolled device", async () => {
    personStatusMock.mockResolvedValue(statusOf("enrolled"));
    await runCreateArm();
    expect(screen.queryByTestId(PENDING_TESTID)).toBeNull();
  });

  it("is present on a pending device, which is the one state that waits", async () => {
    personStatusMock.mockResolvedValue(statusOf("pending"));
    await runCreateArm();
    await waitFor(() => expect(screen.getByTestId(PENDING_TESTID)).toBeTruthy());
  });

  it("is absent when the lifecycle probe fails, rather than claiming a wait", async () => {
    personStatusMock.mockRejectedValue({ kind: "Transport" });
    await runCreateArm();
    expect(screen.queryByTestId(PENDING_TESTID)).toBeNull();
  });
});
