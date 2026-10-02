// @vitest-environment jsdom
//
// The account step's invite-code field (myne-md/myne#800).
//
// The field exists only where creation registers with a server
// (`showInviteCode = REQUIRES_PROVISIONING`). The web client creates accounts
// and has no sync-settings panel before the vault exists, so this field is the
// ONLY place a browser user can enter an invite code for a gated server; a
// local-only client has no gate to pass and must not render it. Two directions,
// because "renders when it should" alone would pass on a field that also
// renders where it should not.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AccountStep } from "../../src/screens/vault-creation/AccountStep";

afterEach(() => {
  cleanup();
});

function renderAccount(showInviteCode: boolean) {
  return render(
    <AccountStep
      accountNumber="MY-4K7P-9QRS-2TVW-XYZ0-1234"
      acknowledged={false}
      committing={false}
      error={null}
      inviteCode=""
      onInviteCodeChange={() => {}}
      showInviteCode={showInviteCode}
      dispatch={() => {}}
    />,
  );
}

describe("AccountStep invite-code field", () => {
  it("renders the field where creation registers with a server", () => {
    renderAccount(true);
    expect(screen.getByTestId("create.invite-code")).toBeTruthy();
  });

  it("omits the field where creation does not register (local-only client)", () => {
    renderAccount(false);
    expect(screen.queryByTestId("create.invite-code")).toBeNull();
  });
});
