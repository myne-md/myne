// @vitest-environment jsdom
//
// The second-tab refusal surface (#254).
//
// The lock module itself was already unit-tested; what was missing was anything
// that used it. This covers the half the boot path now owns: a tab that could
// not take the lock renders a refusal instead of the app, and it only offers a
// reload once the other tab has actually released — not a button the user can
// press five times against a vault that is still open.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

let releaseResolve: (() => void) | null = null;
const waitForVaultLockRelease = vi.fn(
  () =>
    new Promise<void>((res) => {
      releaseResolve = res;
    }),
);

vi.mock("../../web/src/vault-lock", () => ({
  waitForVaultLockRelease: (...a: unknown[]) =>
    waitForVaultLockRelease(...(a as [])),
  WEB_CONTAINER_ID: "container",
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k,
  }),
}));

import { VaultOpenElsewhere } from "../../web/src/VaultOpenElsewhere";

beforeEach(() => {
  // No global auto-cleanup in this config, so a second render would otherwise
  // leave two copies of the surface in the document.
  cleanup();
  waitForVaultLockRelease.mockClear();
  releaseResolve = null;
});

describe("VaultOpenElsewhere", () => {
  it("reports rather than takes over, and offers no reload while the other tab holds", async () => {
    render(<VaultOpenElsewhere vaultId="container" />);
    const main = screen.getByTestId("web.vault-open-elsewhere");
    // The discriminator the browser E2E reads — not the heading text, which is
    // whatever language the runner's browser is set to.
    expect(main.getAttribute("data-freed")).toBe("false");
    expect(screen.queryByTestId("web.vault-open-elsewhere-reload")).toBeNull();
  });

  it("offers the reload only once the lock is released", async () => {
    render(<VaultOpenElsewhere vaultId="container" />);
    await waitFor(() => expect(releaseResolve).not.toBeNull());
    expect(screen.queryByTestId("web.vault-open-elsewhere-reload")).toBeNull();

    releaseResolve?.();

    await waitFor(() =>
      expect(
        screen.getByTestId("web.vault-open-elsewhere").getAttribute("data-freed"),
      ).toBe("true"),
    );
    expect(screen.getByTestId("web.vault-open-elsewhere-reload")).toBeTruthy();
  });
});
