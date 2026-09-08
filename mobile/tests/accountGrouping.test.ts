// @vitest-environment jsdom
//
// The mobile twin of the grouping helper (myne-md/myne#684): the same four
// cases as the desktop suite, against the mobile mirror, so one twin cannot
// silently diverge from the other.

import { describe, expect, it } from "vitest";
import {
  accountIdForVault,
  truncateLabelToBytes,
  type AccountView,
} from "../src/lib/account";

const VAULT_A = "11111111-1111-7111-8111-111111111111";
const VAULT_B = "22222222-2222-7222-8222-222222222222";
const VAULT_C = "33333333-3333-7333-8333-333333333333";

function view(id: string, vaults: string[]): AccountView {
  return { id, label: "", vaults };
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

describe("truncateLabelToBytes", () => {
  it("passes short drafts through", () => {
    expect(truncateLabelToBytes("Work", 512)).toBe("Work");
  });

  it("cuts ascii at the byte cap", () => {
    expect(truncateLabelToBytes("abcdef", 4)).toBe("abcd");
  });

  it("never splits a multibyte character", () => {
    expect(truncateLabelToBytes("aé", 3)).toBe("aé");
    expect(truncateLabelToBytes("a😀", 4)).toBe("a");
    expect(truncateLabelToBytes("a😀", 5)).toBe("a😀");
  });
});
