// @vitest-environment jsdom
//
// `<ViewsManager>` component tests (view-manifests task 7).
//
// The states the surface owes are the ones a reader meets while a decision is
// still open: an empty list (first run, no seeded example), an approved view
// that opens, and a PENDING view that is visible, refuses to open, and can be
// approved in one action. The refusal is asserted on the control rather than on
// a tooltip: a disabled open with the reason on the row is the whole shape.
//
// `deleteSavedView` is asserted by its effect on the call, because the approval
// prune happens in the same host write (`delete_saved_view` prunes
// `view_approvals`; `core/src/plugins/notes/commands.rs` covers that half), so a
// UI that called something else would silently leave a stale decision behind.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleteSavedView = vi.hoisted(() => vi.fn());
const approveView = vi.hoisted(() => vi.fn());
const openView = vi.hoisted(() => vi.fn());

const prefs: {
  saved_views: unknown[];
  view_order: string[];
  view_approvals: Record<string, number>;
} = { saved_views: [], view_order: [], view_approvals: {} };

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, vars?: Record<string, unknown>) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`) }),
}));

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs, approveView }),
}));

vi.mock("../../src/notes/workspaceContext", () => ({
  useWorkspaceOptional: () => ({ openView }),
}));

vi.mock("../../src/lib/prefs", () => ({
  deleteSavedView: (...a: unknown[]) => deleteSavedView(...a),
}));

import { ViewsManager } from "../../src/components/ViewsManager";

function view(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "v1",
    name: "Reading list",
    view_type: "table",
    filters: { kind: "all" },
    ...over,
  };
}

beforeEach(() => {
  prefs.saved_views = [];
  prefs.view_order = [];
  prefs.view_approvals = {};
  deleteSavedView.mockReset().mockResolvedValue(undefined);
  approveView.mockReset().mockResolvedValue(undefined);
  openView.mockReset();
});

afterEach(cleanup);

describe("ViewsManager", () => {
  it("shows a first-run empty state rather than a seeded example", () => {
    render(<ViewsManager open onClose={() => {}} />);

    expect(screen.getByTestId("views-manager.empty")).toBeTruthy();
    expect(screen.queryByTestId("views-manager.list")).toBeNull();
  });

  it("lists views in view_order, not storage order", () => {
    prefs.saved_views = [view({ id: "a", name: "Alpha" }), view({ id: "b", name: "Beta" })];
    prefs.view_order = ["b", "a"];
    render(<ViewsManager open onClose={() => {}} />);

    const rows = screen.getAllByTestId("views-manager.row");
    expect(rows.map((row) => row.getAttribute("data-view-id"))).toEqual(["b", "a"]);
  });

  it("opens an approved view and closes the manager", () => {
    const onClose = vi.fn();
    prefs.saved_views = [view({ id: "a", version: 1 })];
    prefs.view_order = ["a"];
    prefs.view_approvals = { a: 1 };
    render(<ViewsManager open onClose={onClose} />);

    const open = screen.getByTestId("views-manager.row-open") as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    fireEvent.click(open);

    expect(openView).toHaveBeenCalledWith("a");
    expect(onClose).toHaveBeenCalled();
  });

  it("lists a pending view, refuses to open it, and approves it in one action", () => {
    prefs.saved_views = [view({ id: "a", version: 4 })];
    prefs.view_order = ["a"];
    prefs.view_approvals = { a: 2 };
    render(<ViewsManager open onClose={() => {}} />);

    // Visible, with the reason on the row.
    const row = screen.getByTestId("views-manager.row");
    expect(row.getAttribute("data-approved")).toBe("false");
    expect(screen.getByTestId("views-manager.row-state").textContent).toBe(
      "notes.views.manager.pendingState",
    );

    // Refused: a click on the disabled open control reaches no workspace call.
    const open = screen.getByTestId("views-manager.row-open") as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    fireEvent.click(open);
    expect(openView).not.toHaveBeenCalled();

    // One action approves the version the reader was shown.
    fireEvent.click(screen.getByTestId("views-manager.row-approve"));
    expect(approveView).toHaveBeenCalledWith("a", 4);
  });

  it("deletes through the host write that also prunes the approval", () => {
    prefs.saved_views = [view({ id: "a", version: 1 })];
    prefs.view_order = ["a"];
    prefs.view_approvals = { a: 1 };
    render(<ViewsManager open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("views-manager.row-delete"));
    expect(deleteSavedView).toHaveBeenCalledWith("a");
  });
});
