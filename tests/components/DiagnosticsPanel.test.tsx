// @vitest-environment jsdom
//
// The diagnostics surface, on its own (2026-10-25; it was the last section of
// `AboutPanel` until the owner asked for "the diagnostic part of About in a tab of
// its own").
//
// Everything these cases assert was already asserted against `AboutPanel`, which is
// exactly why they moved rather than being rewritten: the section's two fragile
// properties are the preview's wrapping (a 64-hex bundle hash has no break
// opportunity) and the two DIFFERENT refusal sentences (a failed flag READ must not
// render the "your change failed" sentence at a switch nobody touched). A move that
// silently dropped either would keep every other case green, so the assertions
// travel with the code.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));

vi.mock("../../src/platform/capabilities", () => ({
  has: () => true,
}));

// The hook, mocked so the panel's rendering can be driven directly. The two error
// arms are the point: a failed READ must not render the change sentence, and a
// refused crash-record read must not render as an absent row.
const { diagnostics } = vi.hoisted(() => {
  const state: {
    error: { source: "read" } | { source: "change"; error: unknown } | null;
    crash: { at_epoch_seconds: number } | null;
    crashReadFailed: boolean;
  } = { error: null, crash: null, crashReadFailed: false };
  return {
    diagnostics: {
      state,
      setEnabled: vi.fn(),
      clearCrash: vi.fn(),
      reveal: vi.fn(),
      saveReport: vi.fn(),
    },
  };
});
vi.mock("../../src/hooks/useDiagnostics", () => ({
  useDiagnostics: () => ({
    enabled: false,
    loading: false,
    error: diagnostics.state.error,
    crash: diagnostics.state.crash,
    crashReadFailed: diagnostics.state.crashReadFailed,
    manifest: null,
    setEnabled: diagnostics.setEnabled,
    clearCrash: diagnostics.clearCrash,
    reveal: diagnostics.reveal,
    saveReport: diagnostics.saveReport,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

// The desktop caveat is gated on the runtime, so the flag has to be drivable.
const { env } = vi.hoisted(() => ({ env: { tauri: false } }));
vi.mock("../../src/lib/app-window", () => ({
  get HAS_TAURI() {
    return env.tauri;
  },
}));

import { DiagnosticsPanel } from "../../src/components/settings/DiagnosticsPanel";

beforeEach(() => {
  diagnostics.state.error = null;
  diagnostics.state.crash = null;
  diagnostics.state.crashReadFailed = false;
});
afterEach(() => cleanup());

describe("DiagnosticsPanel — the report block", () => {
  it("wraps the read-only preview rather than reusing the multi-line field shape", () => {
    render(<DiagnosticsPanel />);
    const preview = screen.getByTestId("about.diagnostic-block-preview");
    // The longest line in the block is a 64-hex bundle hash, which has no break
    // opportunity. `white-space: pre-wrap` plus `overflow-wrap: anywhere` is what
    // folds it inside the narrow dialog the Settings shell supports. The multi-line
    // field shape's `resize` would be inert on a `<pre>`, so it is deliberately absent.
    expect(preview.style.whiteSpace).toBe("pre-wrap");
    expect(preview.style.overflowWrap).toBe("anywhere");
    expect(preview.style.resize).toBe("");
  });

  it("keeps the preview's settings-search anchor on the canon block root", () => {
    // The block moved from the local `Block` wrapper to `ControlBlock`, whose anchor
    // prop is `anchorId` rather than a raw `data-setting-anchor`. If that prop were
    // dropped the anchor would vanish and the scroll target would go with it, while
    // every other assertion here stayed green.
    render(<DiagnosticsPanel />);
    const preview = screen.getByTestId("about.diagnostic-block-preview");
    expect(preview.closest("[data-setting-anchor]")?.getAttribute("data-setting-anchor")).toBe(
      "about.diagnostic-report",
    );
  });
});

describe("DiagnosticsPanel — read failures", () => {
  it("renders the READ sentence, not the change sentence, for a failed flag read", () => {
    // The read runs on mount, so the switch is off and untouched. The change
    // sentence would tell the user their change failed when they made none.
    diagnostics.state.error = { source: "read" };
    render(<DiagnosticsPanel />);
    expect(screen.getByText("settings.about.diagnosticLogReadError")).toBeTruthy();
    expect(screen.queryByText("settings.about.diagnosticLogError")).toBeNull();
  });

  it("keeps the change sentence for a failed write", () => {
    diagnostics.state.error = {
      source: "change",
      error: { kind: "Io", detail: { io_error_kind: "Other" } },
    };
    render(<DiagnosticsPanel />);
    expect(screen.getByText("settings.about.diagnosticLogError")).toBeTruthy();
    expect(screen.queryByText("settings.about.diagnosticLogReadError")).toBeNull();
  });

  it("shows a line, not an absent row, when the crash record could not be read", () => {
    diagnostics.state.crashReadFailed = true;
    render(<DiagnosticsPanel />);
    expect(screen.getByTestId("about.crash-record-read-failed")).toBeTruthy();
    // And it is not the crash row: Delete would act on a record whose presence is
    // unknown.
    expect(screen.queryByTestId("about.crash-record-row")).toBeNull();
  });

  it("shows the crash row when a record was read", () => {
    diagnostics.state.crash = { at_epoch_seconds: 1_700_000_000 };
    render(<DiagnosticsPanel />);
    expect(screen.getByTestId("about.crash-record-row")).toBeTruthy();
    expect(screen.queryByTestId("about.crash-record-read-failed")).toBeNull();
  });
});
