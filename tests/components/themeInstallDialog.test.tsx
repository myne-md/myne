// @vitest-environment jsdom
//
// Component tests for `src/components/ThemeInstallDialog.tsx` (MYND-567) — the
// confirmation gate between a `myne://theme/install` link and the vault.
//
// The load-bearing assertions are the NEGATIVE ones: Cancel must leave the vault
// completely untouched, and a link the parser rejected must never reach
// `themes_import` at all. Both are acceptance criteria on the work item, and
// both are the kind of thing a refactor can quietly break while the happy path
// keeps passing.
//
// Drives the component's real handler wiring against mocked IPC-boundary
// wrappers; the deep-link parser itself is the real module (its own matrix is
// covered by `tests/lib/themeDeepLink.test.ts`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";

const listCustomThemes = vi.fn();
const importCustomTheme = vi.fn();
const activateCustomTheme = vi.fn();

vi.mock("../../src/lib/themes", async () => {
  // Pure helpers (`themePreview`, `nextAvailableThemeName`) come from the REAL
  // module — mocking them would only test the mock. Only the IPC-boundary
  // wrappers are stubbed.
  const real = await vi.importActual<typeof import("../../src/lib/themes")>(
    "../../src/lib/themes",
  );
  return {
    ...real,
    listCustomThemes: (...a: unknown[]) => listCustomThemes(...a),
    importCustomTheme: (...a: unknown[]) => importCustomTheme(...a),
    activateCustomTheme: (...a: unknown[]) => activateCustomTheme(...a),
  };
});

import { ThemeInstallDialog } from "../../src/components/ThemeInstallDialog";
import { nextAvailableThemeName } from "../../src/lib/themes";
import { clearPendingThemeInstall, handleThemeDeepLinkUrl } from "../../src/lib/themeDeepLink";
import { PALETTE, b64url, link } from "../lib/_themeLink";

/** Deliver a deep link the way the plugin does, then let the dialog react. */
async function arrive(url: string) {
  await act(async () => {
    handleThemeDeepLinkUrl(url);
  });
}

beforeEach(() => {
  listCustomThemes.mockResolvedValue([]);
  importCustomTheme.mockResolvedValue(undefined);
  activateCustomTheme.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  clearPendingThemeInstall();
  vi.clearAllMocks();
});

describe("arrival", () => {
  it("renders nothing until a link arrives", () => {
    render(<ThemeInstallDialog />);
    expect(screen.queryByTestId("theme-install.dialog")).toBeNull();
  });

  it("shows the theme's claimed identity and its palette preview", async () => {
    render(<ThemeInstallDialog />);
    await arrive(link({ author: "Myne", src: "https://myne.md/themes/" }));

    expect(await screen.findByTestId("theme-install.dialog")).toBeTruthy();
    expect(screen.getByTestId("theme-install.name").textContent).toBe("Warm Paper");
    // Attribution, not assertion — the link author picked these strings.
    expect(screen.getByTestId("theme-install.author").textContent).toContain("Myne");
    expect(screen.getByTestId("theme-install.source").textContent).toBe("https://myne.md/themes/");
    expect(screen.getByTestId("theme-install.preview")).toBeTruthy();
  });

  it("drains a link that arrived BEFORE mount (the cold-launch / locked-vault path)", async () => {
    // No dialog exists yet — this is a link that landed on the unlock screen.
    handleThemeDeepLinkUrl(link({ name: "Latched" }));
    render(<ThemeInstallDialog />);
    expect((await screen.findByTestId("theme-install.name")).textContent).toBe("Latched");
  });

  it("writes nothing merely by being shown", async () => {
    render(<ThemeInstallDialog />);
    await arrive(link());
    await screen.findByTestId("theme-install.dialog");
    expect(importCustomTheme).not.toHaveBeenCalled();
    expect(activateCustomTheme).not.toHaveBeenCalled();
  });
});

describe("the accept path", () => {
  it("imports, persists the selection, then paints the palette", async () => {
    render(<ThemeInstallDialog />);
    await arrive(link());

    (await screen.findByTestId("theme-install.apply")).click();

    await waitFor(() => expect(importCustomTheme).toHaveBeenCalledTimes(1));
    expect(importCustomTheme).toHaveBeenCalledWith("Warm Paper", JSON.stringify(PALETTE));
    // Disk-first ordering: the selection is persisted before the live flip.
    // Activation is one call now (disk-first ordering lives in `themes.ts`).
    expect(activateCustomTheme).toHaveBeenCalledWith("Warm Paper", PALETTE);
    // The dialog closes on success.
    await waitFor(() => expect(screen.queryByTestId("theme-install.dialog")).toBeNull());
  });

  it("hands the host the payload VERBATIM, not a re-serialization", async () => {
    // Key order and spacing must survive: the host validates exactly the bytes
    // the link carried, so any normalization here would validate something else.
    const odd = '{"--ink-1":"#2b2720",  "--paper":"#faf6ee"}';
    render(<ThemeInstallDialog />);
    await arrive(link({ payload: b64url(odd) }));

    (await screen.findByTestId("theme-install.apply")).click();
    await waitFor(() => expect(importCustomTheme).toHaveBeenCalledWith("Warm Paper", odd));
  });
});

describe("the cancel path", () => {
  it("writes absolutely nothing and closes", async () => {
    render(<ThemeInstallDialog />);
    await arrive(link());

    (await screen.findByTestId("theme-install.cancel")).click();

    await waitFor(() => expect(screen.queryByTestId("theme-install.dialog")).toBeNull());
    expect(importCustomTheme).not.toHaveBeenCalled();
    expect(activateCustomTheme).not.toHaveBeenCalled();
  });

  it("does not re-open for the same link after cancelling", async () => {
    render(<ThemeInstallDialog />);
    await arrive(link());
    (await screen.findByTestId("theme-install.cancel")).click();
    await waitFor(() => expect(screen.queryByTestId("theme-install.dialog")).toBeNull());

    // A re-render must not resurrect a consumed request.
    cleanup();
    render(<ThemeInstallDialog />);
    expect(screen.queryByTestId("theme-install.dialog")).toBeNull();
  });
});

describe("name collision", () => {
  it("offers keep-both vs replace, defaulting to the non-destructive choice", async () => {
    listCustomThemes.mockResolvedValue([{ name: "Warm Paper", palette: PALETTE }]);
    render(<ThemeInstallDialog />);
    await arrive(link());

    expect(await screen.findByTestId("theme-install.collision")).toBeTruthy();
    expect((screen.getByTestId("theme-install.keep-both") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("theme-install.replace") as HTMLInputElement).checked).toBe(false);
  });

  it("keep-both installs under a suffixed name, leaving the original alone", async () => {
    listCustomThemes.mockResolvedValue([{ name: "Warm Paper", palette: PALETTE }]);
    render(<ThemeInstallDialog />);
    await arrive(link());
    await screen.findByTestId("theme-install.collision");

    (await screen.findByTestId("theme-install.apply")).click();
    await waitFor(() =>
      expect(importCustomTheme).toHaveBeenCalledWith("Warm Paper (2)", expect.any(String)),
    );
  });

  it("replace overwrites the existing name", async () => {
    listCustomThemes.mockResolvedValue([{ name: "Warm Paper", palette: PALETTE }]);
    render(<ThemeInstallDialog />);
    await arrive(link());
    (await screen.findByTestId("theme-install.replace")).click();

    (await screen.findByTestId("theme-install.apply")).click();
    await waitFor(() =>
      expect(importCustomTheme).toHaveBeenCalledWith("Warm Paper", expect.any(String)),
    );
  });

  it("offers no collision choice when the name is free", async () => {
    render(<ThemeInstallDialog />);
    await arrive(link());
    await screen.findByTestId("theme-install.dialog");
    expect(screen.queryByTestId("theme-install.collision")).toBeNull();
  });
});

describe("nextAvailableThemeName", () => {
  it("returns the name untouched when it is free", () => {
    expect(nextAvailableThemeName("Nord", [])).toBe("Nord");
  });
  it("skips past every taken suffix", () => {
    expect(nextAvailableThemeName("Nord", ["Nord", "Nord (2)", "Nord (3)"])).toBe("Nord (4)");
  });
});

describe("failure surfaces", () => {
  it("shows an error for a link the parser rejected, and never calls the host", async () => {
    render(<ThemeInstallDialog />);
    await arrive(link({ v: "2" })); // minted by a newer website

    expect(await screen.findByTestId("theme-install.rejected")).toBeTruthy();
    expect(screen.getByTestId("theme-install.error").textContent).toBeTruthy();
    expect(importCustomTheme).not.toHaveBeenCalled();
    // No confirm affordance at all — there is nothing to confirm.
    expect(screen.queryByTestId("theme-install.apply")).toBeNull();
  });

  it("surfaces a host validation failure and leaves the theme unapplied", async () => {
    importCustomTheme.mockRejectedValue({
      kind: "Invalid",
      detail: { error: { kind: "MissingKey", key: "--accent" } },
    });
    render(<ThemeInstallDialog />);
    await arrive(link());

    (await screen.findByTestId("theme-install.apply")).click();

    const error = await screen.findByTestId("theme-install.error");
    expect(error.textContent).toContain("--accent");
    // Rejected before any write: no selection persisted, no palette painted,
    // and the dialog stays open so the user knows it did not happen.
    expect(activateCustomTheme).not.toHaveBeenCalled();
    expect(screen.getByTestId("theme-install.dialog")).toBeTruthy();
  });
});

describe("deferral behind the first-run importer offer", () => {
  it("stays closed while deferred, then opens when the offer clears", async () => {
    const { rerender } = render(<ThemeInstallDialog deferred />);
    await arrive(link());
    // Two focus-trapping modals at the same z-index would fight over focus, so
    // the onboarding offer wins and this one waits its turn.
    expect(screen.queryByTestId("theme-install.dialog")).toBeNull();

    rerender(<ThemeInstallDialog deferred={false} />);
    // Deferral must not DROP the request — it is still there to be confirmed.
    expect(await screen.findByTestId("theme-install.dialog")).toBeTruthy();
    expect(screen.getByTestId("theme-install.name").textContent).toBe("Warm Paper");
  });
});
