// The path a partial-delete banner points the user at (#253).
//
// When `vault_delete` cannot remove every file (an AV scanner, Spotlight, or a
// file-sync client holding a handle), the banner asks the user to clean up the
// residue and prints a directory. All three delete surfaces built that string
// by hand as `join(appDataDir(), "vault")` — the PRE-multi-vault single-vault
// path, which exists on no migrated or freshly-created install. Every vault
// created by `vault_creation::begin` lands at `vaults/<id>/`, so the banner sent
// users to a directory that is not there, while the leftover ciphertext sat
// somewhere else. Each of the three had the id in scope.

import { beforeEach, describe, expect, it, vi } from "vitest";

const hasMock = vi.fn((_cap: string) => true);
const appDataDirMock = vi.fn(async () => "/data");

vi.mock("../../src/platform/capabilities", () => ({
  has: (cap: string) => hasMock(cap),
}));

vi.mock("../../src/platform/path", () => ({
  appDataDir: () => appDataDirMock(),
  join: async (...parts: string[]) => parts.join("/"),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { vaultDirDisplayPath } from "../../src/lib/vault-delete";

beforeEach(() => {
  hasMock.mockReset();
  hasMock.mockReturnValue(true);
  appDataDirMock.mockReset();
  appDataDirMock.mockResolvedValue("/data");
});

describe("vaultDirDisplayPath", () => {
  it("names vaults/<id>, the directory the ciphertext is actually in", async () => {
    await expect(
      vaultDirDisplayPath("11111111-1111-7111-8111-111111111111"),
    ).resolves.toBe("/data/vaults/11111111-1111-7111-8111-111111111111");
  });

  it("falls back to the legacy vault/ only when there is no id", async () => {
    // A vault with no id can only be the pre-`vaults/` layout, whose directory
    // really is `<app_data_dir>/vault`.
    await expect(vaultDirDisplayPath(null)).resolves.toBe("/data/vault");
  });

  it("returns null where the platform has no such path", async () => {
    // `appDataDir` is a typed refusal in the browser seam, and an OPFS
    // container is not somewhere a user can open a file manager on. Callers
    // must render the banner without a path rather than skip the banner.
    hasMock.mockReturnValue(false);
    await expect(vaultDirDisplayPath("any-id")).resolves.toBeNull();
    expect(appDataDirMock).not.toHaveBeenCalled();
  });

  it("returns null rather than throwing inside a catch block", async () => {
    // Every call site is INSIDE the catch that maps a delete failure. A throw
    // here would swallow the mapping and leave the user with a failed delete
    // and no banner at all.
    appDataDirMock.mockRejectedValue(new Error("no path"));
    await expect(vaultDirDisplayPath("any-id")).resolves.toBeNull();
  });
});
