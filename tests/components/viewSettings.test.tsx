// @vitest-environment jsdom
//
// `<ViewSettings>` gains its view-manifests half (task 8): a writable-field set,
// a read-only version, and export.
//
// The case worth a render rather than a unit test is the RESERVED MARKERS. The
// Rust import reader refuses a manifest that declares `archived`, `deleted` or
// `trashed`, and the form chooses which keys to offer. If it offered one, the
// user would compose a file that fails to import at the last step with a named
// error they cannot act on; the fix is that the key never appears in the picker,
// and only the picker's own DOM can prove that.
//
// The version is asserted as an absence as well as a presence: it renders as
// text, and there is no control that could edit it, because a version the user
// could set is a version the ordered import comparison cannot be trusted on.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewDisplayPatch } from "../../src/notes/components/ViewSettings";
import { ViewSettings } from "../../src/notes/components/ViewSettings";

afterEach(cleanup);

const PROPERTY_KEYS = ["status", "priority", "archived", "trashed", "deleted"];

function renderForm(over: {
  version?: number;
  onExport?: () => void;
  onSave?: (patch: ViewDisplayPatch) => void;
} = {}) {
  const onSave = over.onSave ?? vi.fn();
  render(
    <ViewSettings
      title="Reading list"
      initial={{}}
      version={over.version}
      onExport={over.onExport}
      propertyKeys={PROPERTY_KEYS}
      onCancel={() => {}}
      onSave={onSave}
    />,
  );
  return { onSave };
}

/** Open the writable-field picker and read every offered label. */
function offeredWriteFields(): string[] {
  fireEvent.click(screen.getByTestId("view-settings.write-fields"));
  const option = screen.queryAllByTestId("view-settings.write-fields-option");
  return option.map((el) => el.textContent ?? "");
}

describe("ViewSettings (view-manifests)", () => {
  it("never offers a host-owned marker as a writable field", () => {
    renderForm();

    const offered = offeredWriteFields();
    expect(offered).toContain("status");
    expect(offered).toContain("priority");
    // The three the import path refuses outright.
    expect(offered).not.toContain("archived");
    expect(offered).not.toContain("trashed");
    expect(offered).not.toContain("deleted");
  });

  it("shows the version as text with no control that could edit it", () => {
    renderForm({ version: 4 });

    const version = screen.getByTestId("view-settings.version");
    expect(version.textContent).toContain("4");
    expect(version.querySelector("input")).toBeNull();
    expect(within(version).queryByRole("textbox")).toBeNull();
    expect(version.getAttribute("contenteditable")).toBeNull();
  });

  it("says a pre-feature view is not versioned yet", () => {
    renderForm();
    // The real English catalogue is loaded (`tests/setup-i18n.ts`), so this is
    // the copy a reader meets rather than a key name.
    expect(screen.getByTestId("view-settings.version").textContent).toBe(
      "Not versioned yet",
    );
  });

  it("carries any edited writable fields into the save patch", () => {
    const { onSave } = renderForm();

    fireEvent.click(screen.getByTestId("view-settings.write-fields"));
    // By `data-value` rather than by text: the COLUMNS picker lists the same
    // property keys, so a text match finds both.
    for (const key of ["status", "priority"]) {
      const option = screen
        .getAllByTestId("view-settings.write-fields-option")
        .find((el) => el.getAttribute("data-value") === key);
      expect(option).toBeTruthy();
      fireEvent.click(option as HTMLElement);
    }
    fireEvent.click(screen.getByTestId("view-settings.save"));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ write_fields: ["status", "priority"] }),
    );
  });

  it("sends no write_fields key when the set is emptied", () => {
    const { onSave } = renderForm();
    fireEvent.click(screen.getByTestId("view-settings.save"));

    const patch = (onSave as unknown as { mock: { calls: ViewDisplayPatch[][] } })
      .mock.calls[0][0];
    expect("write_fields" in patch).toBe(true);
    expect(patch.write_fields).toBeUndefined();
  });

  it("offers export only when the caller can write a file", () => {
    renderForm();
    expect(screen.queryByTestId("view-settings.export")).toBeNull();

    cleanup();
    const onExport = vi.fn();
    renderForm({ onExport });
    fireEvent.click(screen.getByTestId("view-settings.export"));
    expect(onExport).toHaveBeenCalled();
  });
});
