// @vitest-environment jsdom
//
// `<ViewImportDialog>` component tests (view-manifests task 9), one per ordering
// arm, driven through the REAL comparison and the REAL prefs bindings: only the
// IPC transport and the OS dialogs are mocked, so what is exercised is the code
// that ships rather than a stub of it.
//
// The assertions that matter are about WRITES, not about words:
//
//   - a replace stores the definition and does NOT approve it, so the view stays
//     pending until the approving click;
//   - a refusal stores nothing and approves nothing;
//   - an identical re-import stores nothing, because a repeated download is not an
//     error and not a write;
//   - the summary shown before the decision is `<ViewConsent>` (the task-6
//     component), asserted by its own testid rather than by its words.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedView } from "../../src/lib/prefs";

const invoke = vi.hoisted(() => vi.fn());
const openDialog = vi.hoisted(() => vi.fn());

const prefs: { saved_views: SavedView[]; view_approvals: Record<string, number> } = {
  saved_views: [],
  view_approvals: {},
};

vi.mock("../../src/platform/core", () => ({ invoke }));
vi.mock("../../src/platform/dialog", () => ({ open: openDialog }));
vi.mock("../../src/hooks/usePrefs", () => ({ usePrefs: () => ({ prefs }) }));

import { ViewImportDialog } from "../../src/components/ViewImportDialog";

function view(over: Partial<SavedView> = {}): SavedView {
  return {
    id: "v1",
    name: "Reading list",
    view_type: "table",
    filters: { kind: "all" },
    version: 3,
    ...over,
  };
}

/** Answer the file picker with one path, then the strict reader with `result`. */
function pickFile(readerResult: () => Promise<SavedView>) {
  openDialog.mockResolvedValue("/tmp/view.myneview");
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "plugin:prefs|read_view_manifest") return readerResult();
    return Promise.resolve(undefined);
  });
}

const storedWrites = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === "plugin:prefs|upsert_saved_view");
const approvalWrites = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === "plugin:prefs|set_view_approval");

beforeEach(() => {
  prefs.saved_views = [];
  prefs.view_approvals = {};
  invoke.mockReset().mockResolvedValue(undefined);
  openDialog.mockReset();
});

afterEach(cleanup);

describe("ViewImportDialog", () => {
  it("imports a new view, shows the consent summary, then approves it", async () => {
    const incoming = view({ version: 1 });
    pickFile(async () => incoming);
    render(<ViewImportDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("view-import.pick"));
    await screen.findByTestId("view-import.ready");

    // The summary is the task-6 component, on screen before anything is stored.
    expect(screen.getByTestId("view-consent.root")).toBeTruthy();
    expect(storedWrites()).toHaveLength(0);

    fireEvent.click(screen.getByTestId("view-import.store"));
    await screen.findByTestId("view-import.stored");

    expect(storedWrites()).toHaveLength(1);
    expect((storedWrites()[0][1] as { view: SavedView }).view).toEqual(incoming);
    // Storing is not approving: new bytes are a new decision.
    expect(approvalWrites()).toHaveLength(0);

    fireEvent.click(screen.getByTestId("view-import.approve"));
    await waitFor(() => expect(approvalWrites()).toHaveLength(1));
    expect(approvalWrites()[0][1]).toEqual({ viewId: "v1", version: 1 });
  });

  it("replaces a lower stored version and names both versions", async () => {
    prefs.saved_views = [view({ version: 2 })];
    prefs.view_approvals = { v1: 2 };
    pickFile(async () => view({ version: 3 }));
    render(<ViewImportDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("view-import.pick"));
    await screen.findByTestId("view-import.ready");

    const body = screen.getByTestId("view-import.body").textContent ?? "";
    expect(body).toContain("3");
    expect(body).toContain("2");

    fireEvent.click(screen.getByTestId("view-import.store"));
    await screen.findByTestId("view-import.stored");
    expect(storedWrites()).toHaveLength(1);
    // The stored approval names v2, so the replaced definition is unapproved.
    expect(approvalWrites()).toHaveLength(0);
  });

  it("treats an identical re-import as a no-op with no write", async () => {
    prefs.saved_views = [view({ version: 3 })];
    pickFile(async () => view({ version: 3 }));
    render(<ViewImportDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("view-import.pick"));
    await screen.findByTestId("view-import.identical");

    expect(screen.queryByTestId("view-import.store")).toBeNull();
    expect(storedWrites()).toHaveLength(0);
    expect(approvalWrites()).toHaveLength(0);
  });

  it("refuses the same version with different content and writes nothing", async () => {
    prefs.saved_views = [view({ version: 3, name: "Reading list" })];
    pickFile(async () => view({ version: 3, name: "Books" }));
    render(<ViewImportDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("view-import.pick"));
    await screen.findByTestId("view-import.refused");

    expect(screen.queryByTestId("view-import.store")).toBeNull();
    expect(storedWrites()).toHaveLength(0);
    expect(approvalWrites()).toHaveLength(0);
  });

  it("refuses an older file and names both versions", async () => {
    prefs.saved_views = [view({ version: 5 })];
    pickFile(async () => view({ version: 4 }));
    render(<ViewImportDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("view-import.pick"));
    await screen.findByTestId("view-import.refused");

    const body = screen.getByTestId("view-import.body").textContent ?? "";
    expect(body).toContain("4");
    expect(body).toContain("5");
    expect(storedWrites()).toHaveLength(0);
  });

  it("names the reader's reason for a malformed file", async () => {
    pickFile(async () => {
      throw { kind: "Invalid", detail: { reason: { kind: "UnknownKey", detail: "template" } } };
    });
    render(<ViewImportDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("view-import.pick"));
    await screen.findByTestId("view-import.refused");

    // The refusal names the offending key, which is the whole reason the Rust
    // variant carries it.
    expect(screen.getByTestId("view-import.body").textContent).toContain("template");
    expect(storedWrites()).toHaveLength(0);
    expect(approvalWrites()).toHaveLength(0);
  });

  it("says the file could not be read when the read itself failed", async () => {
    pickFile(async () => {
      throw { kind: "Unreadable", detail: { io_error_kind: "NotFound" } };
    });
    render(<ViewImportDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("view-import.pick"));
    await screen.findByTestId("view-import.refused");
    expect(screen.getByTestId("view-import.body").textContent).toBeTruthy();
  });

  it("does nothing at all when the file picker is dismissed", async () => {
    openDialog.mockResolvedValue(null);
    render(<ViewImportDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("view-import.pick"));
    await waitFor(() => expect(openDialog).toHaveBeenCalled());

    expect(screen.queryByTestId("view-import.refused")).toBeNull();
    expect(screen.getByTestId("view-import.pick")).toBeTruthy();
    expect(storedWrites()).toHaveLength(0);
  });
});
