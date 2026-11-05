// @vitest-environment jsdom
//
// The phone's diagnostics block (myne-md/myne#1027). It exists because the block is the only
// surface a phone can hand a maintainer, and until this test nothing held it: emptying the
// component's body failed no suite anywhere.
//
// What is worth holding here is not the field names (`buildDiagnostics` owns those, and
// tests/lib/collectDiagnostics.test.ts holds the allowlist) but the three behaviours this file
// adds on top: it renders what the gather returned, Copy actually reaches the clipboard seam, and
// a failed read leaves the preview EMPTY rather than throwing into the sheet.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-i18next")>();
  return { ...real, useTranslation: () => ({ t: (key: string) => key }) };
});

const invokeMock = vi.fn();
vi.mock("../../src/platform/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/core")>();
  return { ...real, invoke: (...args: unknown[]) => invokeMock(...args) };
});

const writeTextMock = vi.fn(() => Promise.resolve());
vi.mock("../../src/lib/clipboardTransport", () => ({
  writeText: (...args: unknown[]) => writeTextMock(...args),
}));

import { DiagnosticsBlock } from "../../src/components/DiagnosticsBlock";

// `__APP_VERSION__` is a `define` in `mobile/vite.config.ts`, so it exists in a build and in the
// app but not under Vitest. Declaring it here rather than in the vitest config keeps the constant
// a BUILD input where it belongs; a suite that renders anything showing a version needs it.
beforeEach(() => {
  vi.stubGlobal("__APP_VERSION__", "0.14.0");
  vi.stubGlobal("__BUILD_COMMIT__", "unknown");
});

const doctor = {
  generation: "v0.2",
  authority: { state: "missing", cause: "key_missing_while_bound" },
  binding: "orphaned",
  key_at_rest: "absent",
  session: { identity_unlocked: false },
};

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  writeTextMock.mockClear();
});

describe("DiagnosticsBlock", () => {
  it("renders the block the shared gather built, with the vault verdict in it", async () => {
    invokeMock.mockResolvedValue(doctor);
    render(<DiagnosticsBlock />);

    const block = await screen.findByTestId("settings.diagnostics.block");
    await waitFor(() => expect(block.textContent ?? "").toContain("vaultAuthority"));
    // The one line that would have answered the incident: the authority token, which is what a
    // maintainer reads to tell "this device cannot sign" from "this device is offline".
    expect(block.textContent ?? "").toContain("key_missing_while_bound");
    expect(block.textContent ?? "").toContain("vaultBinding");
  });

  it("copies the block it is showing, and confirms on the control", async () => {
    invokeMock.mockResolvedValue(doctor);
    render(<DiagnosticsBlock />);
    const block = await screen.findByTestId("settings.diagnostics.block");
    const button = screen.getByTestId("settings.diagnostics.copy");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    button.click();
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledTimes(1));
    expect(writeTextMock.mock.calls[0][0]).toBe(block.textContent);
    // The label changes on the pressed control, which is the copy pattern every client uses; a
    // toast here would be the failure case, not the success one.
    await waitFor(() =>
      expect(screen.getByTestId("settings.diagnostics.copy").textContent).toBe(
        "settings.about.diagnosticCopied",
      ),
    );
  });

  it("leaves the preview empty when the vault read fails, rather than throwing into the sheet", async () => {
    invokeMock.mockRejectedValue(new Error("no vault"));
    render(<DiagnosticsBlock />);
    // The gather's own deadline turns a refusal into an absent reading, so the block still
    // renders: what must NOT happen is an unhandled rejection taking the settings sheet down.
    const block = await screen.findByTestId("settings.diagnostics.block");
    expect(block.textContent ?? "").not.toContain("vaultAuthority");
  });
});
