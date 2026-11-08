import { describe, expect, it } from "vitest";
import {
  accountHeading,
  accountIdForVault,
  type AccountView,
} from "../../src/lib/account";

const VAULT_A = "11111111-1111-7111-8111-111111111111";
const VAULT_B = "22222222-2222-7222-8222-222222222222";
const VAULT_C = "33333333-3333-7333-8333-333333333333";

function view(id: string, vaults: string[]): AccountView {
  return { id, vaults };
}

describe("accountIdForVault", () => {
  it("returns the owning account id", () => {
    const accounts = [view("aa", [VAULT_A]), view("bb", [VAULT_B])];
    expect(accountIdForVault(accounts, VAULT_A)).toBe("aa");
    expect(accountIdForVault(accounts, VAULT_B)).toBe("bb");
  });

  it("returns null for a vault in no account", () => {
    const accounts = [view("aa", [VAULT_A])];
    expect(accountIdForVault(accounts, VAULT_C)).toBeNull();
  });

  it("returns null on an empty list", () => {
    expect(accountIdForVault([], VAULT_A)).toBeNull();
  });

  it("a vault in two accounts answers the first (record invariant: disjoint)", () => {
    const accounts = [view("aa", [VAULT_A]), view("bb", [VAULT_A])];
    expect(accountIdForVault(accounts, VAULT_A)).toBe("aa");
  });
});

// `myne-agents/docs/decisions/ui/0728`: an account has no name, so a surface identifies a
// group by the vaults inside it. One implementation, three callers (desktop
// picker, recover picker, mobile picker).
describe("accountHeading", () => {
  const names: Record<string, string> = {
    [VAULT_A]: "Personal",
    [VAULT_B]: "Work",
  };
  const nameOf = (id: string) => names[id] ?? null;

  it("joins the group's own vault names in the record's order", () => {
    expect(accountHeading(view("aa", [VAULT_B, VAULT_A]), nameOf, "Account")).toBe(
      "Work · Personal",
    );
  });

  it("drops a vault it cannot name rather than printing a placeholder inside the heading", () => {
    expect(accountHeading(view("aa", [VAULT_A, VAULT_C]), nameOf, "Account")).toBe(
      "Personal",
    );
  });

  it("falls back only when nothing in the group could be named", () => {
    expect(accountHeading(view("aa", [VAULT_C]), nameOf, "Account")).toBe("Account");
    expect(accountHeading(view("aa", []), nameOf, "Account")).toBe("Account");
  });
});
