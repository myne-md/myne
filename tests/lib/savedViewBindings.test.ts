// Binding tests for the saved-view CRUD functions in `src/lib/prefs.ts`
// (MYND-273, view-model-and-storage #3 task 5). Mocks the Tauri `invoke` shim
// and asserts each binding calls the exact `plugin:prefs|…` command name with
// the exact arg keys the Rust commands expect.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  deleteSavedView,
  setViewOrder,
  upsertSavedView,
  type SavedView,
} from "../../src/lib/prefs";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  invokeMock.mockReset();
});

const view: SavedView = {
  id: "v1",
  name: "Books",
  view_type: "cards",
  filters: {
    kind: "and",
    children: [
      { kind: "inFolder", path: "Books/" },
      { kind: "property", key: "rating", op: ">", value: "4" },
    ],
  },
  sort: { key: "finished", direction: "desc" },
  group_by: "status",
  columns: ["author", "rating"],
  card_size: 300,
  image: "image",
  image_aspect_ratio: "1.65",
};

describe("saved-view bindings — command names + arg keys", () => {
  it("upsertSavedView calls plugin:prefs|upsert_saved_view with { view }", async () => {
    await upsertSavedView(view);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|upsert_saved_view", {
      view,
    });
  });

  it("deleteSavedView calls plugin:prefs|delete_saved_view with { id }", async () => {
    await deleteSavedView("v1");
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|delete_saved_view", {
      id: "v1",
    });
  });

  it("setViewOrder calls plugin:prefs|set_view_order with { order }", async () => {
    await setViewOrder(["v2", "v1"]);
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_view_order", {
      order: ["v2", "v1"],
    });
  });

  it("a rejected invoke rejects the binding (optimistic UI revert contract)", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "PrefsEncodeFailed" });
    await expect(upsertSavedView(view)).rejects.toEqual({
      kind: "PrefsEncodeFailed",
    });
  });
});
