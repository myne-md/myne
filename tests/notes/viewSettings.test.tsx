// @vitest-environment jsdom
//
// Unit tests for the saved-view settings modal (Saved Views authoring). Pure
// presentational component — no IPC. Covers seed/render, the omit-when-default
// save patch (now including view_type / group_by / sort / columns), the
// cards-only cover section, the suggestion chips, the card-size clamp, and Cancel.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ViewSettings } from "../../src/notes/components/ViewSettings";

afterEach(cleanup);

/** Pick an option from a SearchableSelect by its testId + value. */
function pickAspect(value: string) {
  fireEvent.click(screen.getByTestId("view-settings.aspect-select"));
  const option = screen
    .getAllByTestId("view-settings.aspect-select-option")
    .find((el) => el.getAttribute("data-value") === value);
  if (option === undefined) throw new Error(`no aspect option ${value}`);
  fireEvent.click(option);
}

describe("ViewSettings", () => {
  it("seeds the controls from the initial values (cards)", () => {
    render(
      <ViewSettings
        title="Books"
        initial={{ view_type: "cards", image: "cover", image_aspect_ratio: "1", card_size: 300 }}
        propertyKeys={[]}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(
      (screen.getByTestId("view-settings.image-input") as HTMLInputElement).value,
    ).toBe("cover");
    expect(screen.getByTestId("view-settings.card-size-value").textContent).toBe(
      "300 px",
    );
    expect(screen.getByTestId("view-settings.aspect-select").textContent).toContain(
      "1:1",
    );
    // view_type + group/sort/column pickers are always present.
    expect(screen.getByTestId("view-settings.view-type")).toBeTruthy();
    expect(screen.getByTestId("view-settings.group-by")).toBeTruthy();
    expect(screen.getByTestId("view-settings.columns")).toBeTruthy();
  });

  it("hides the cover section for a non-cards view", () => {
    render(
      <ViewSettings
        title="Tasks"
        initial={{ view_type: "table", columns: ["status"] }}
        propertyKeys={["status", "due"]}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    // Cover controls are cards-only.
    expect(screen.queryByTestId("view-settings.image-input")).toBeNull();
    expect(screen.queryByTestId("view-settings.card-size")).toBeNull();
    // Structural pickers remain, and the seeded column shows.
    expect(screen.getByTestId("view-settings.view-type")).toBeTruthy();
    expect(screen.getByTestId("view-settings.columns").textContent).toContain("status");
  });

  it("composes a full patch when every cards field is set", () => {
    const onSave = vi.fn();
    render(
      <ViewSettings
        title="Books"
        initial={{}}
        propertyKeys={[]}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByTestId("view-settings.image-input"), {
      target: { value: "  photo  " },
    });
    pickAspect("1.78");
    fireEvent.change(screen.getByTestId("view-settings.card-size"), {
      target: { value: "320" },
    });
    fireEvent.click(screen.getByTestId("view-settings.save"));
    expect(onSave).toHaveBeenCalledWith({
      view_type: "cards", // the default
      group_by: undefined,
      sort: undefined,
      columns: undefined,
      image: "photo", // trimmed
      image_aspect_ratio: "1.78",
      card_size: 320,
    });
  });

  it("carries seeded view_type / group_by / sort / columns through an unedited save", () => {
    const onSave = vi.fn();
    render(
      <ViewSettings
        title="Tasks"
        initial={{
          view_type: "table",
          group_by: "status",
          sort: { key: "due", direction: "desc" },
          columns: ["status", "due"],
        }}
        propertyKeys={["status", "due"]}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByTestId("view-settings.save"));
    expect(onSave).toHaveBeenCalledWith({
      view_type: "table",
      group_by: "status",
      sort: { key: "due", direction: "desc" },
      columns: ["status", "due"],
      image: undefined,
      image_aspect_ratio: undefined,
      card_size: undefined,
    });
  });

  it("omits cards fields left at their default", () => {
    const onSave = vi.fn();
    render(
      <ViewSettings
        title="Books"
        initial={{ view_type: "cards", image: "cover", image_aspect_ratio: "1.78", card_size: 300 }}
        propertyKeys={[]}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByTestId("view-settings.image-input"), {
      target: { value: "" },
    });
    pickAspect(""); // "Default (16:9)"
    fireEvent.click(screen.getByTestId("view-settings.card-size-reset"));
    fireEvent.click(screen.getByTestId("view-settings.save"));
    expect(onSave).toHaveBeenCalledWith({
      view_type: "cards",
      group_by: undefined,
      sort: undefined,
      columns: undefined,
      image: undefined,
      image_aspect_ratio: undefined,
      card_size: undefined,
    });
  });

  it("a suggestion chip fills the image input", () => {
    render(
      <ViewSettings
        title="Books"
        initial={{ view_type: "cards" }}
        propertyKeys={["cover", "banner"]}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    const chips = screen.getAllByTestId("view-settings.image-suggestion");
    const cover = chips.find((c) => c.getAttribute("data-value") === "cover")!;
    fireEvent.click(cover);
    expect(
      (screen.getByTestId("view-settings.image-input") as HTMLInputElement).value,
    ).toBe("cover");
  });

  it("the card-size slider is clamped to 120–600", () => {
    render(
      <ViewSettings
        title="Books"
        initial={{ view_type: "cards" }}
        propertyKeys={[]}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    const slider = screen.getByTestId("view-settings.card-size") as HTMLInputElement;
    expect(slider.min).toBe("120");
    expect(slider.max).toBe("600");
  });

  it("Cancel dismisses without saving", () => {
    const onCancel = vi.fn();
    const onSave = vi.fn();
    render(
      <ViewSettings
        title="Books"
        initial={{}}
        propertyKeys={[]}
        onCancel={onCancel}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByTestId("view-settings.cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
