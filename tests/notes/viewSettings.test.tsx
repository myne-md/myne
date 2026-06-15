// @vitest-environment jsdom
//
// Unit tests for the cards-view display settings modal (Saved Views follow-on).
// Pure presentational component — no IPC. Covers seed/render, the omit-when-empty
// save patch, the suggestion chips, the card-size clamp bounds, and Cancel.

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
  it("seeds the controls from the initial values", () => {
    render(
      <ViewSettings
        title="Books"
        initial={{ image: "cover", image_aspect_ratio: "1", card_size: 300 }}
        propertySuggestions={[]}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(
      (screen.getByTestId("view-settings.image-input") as HTMLInputElement)
        .value,
    ).toBe("cover");
    expect(screen.getByTestId("view-settings.card-size-value").textContent).toBe(
      "300 px",
    );
    // The aspect trigger summarises the selected preset's label.
    expect(screen.getByTestId("view-settings.aspect-select").textContent).toContain(
      "1:1",
    );
  });

  it("composes a full patch when every field is set", () => {
    const onSave = vi.fn();
    render(
      <ViewSettings
        title="Books"
        initial={{}}
        propertySuggestions={[]}
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
      image: "photo", // trimmed
      image_aspect_ratio: "1.78",
      card_size: 320,
    });
  });

  it("omits fields left at their default (empty image / default aspect / default size)", () => {
    const onSave = vi.fn();
    render(
      <ViewSettings
        title="Books"
        initial={{ image: "cover", image_aspect_ratio: "1.78", card_size: 300 }}
        propertySuggestions={[]}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    // Clear the image, reset aspect to Default, reset card size to the default.
    fireEvent.change(screen.getByTestId("view-settings.image-input"), {
      target: { value: "" },
    });
    pickAspect(""); // "Default (16:9)"
    fireEvent.click(screen.getByTestId("view-settings.card-size-reset"));
    fireEvent.click(screen.getByTestId("view-settings.save"));
    expect(onSave).toHaveBeenCalledWith({
      image: undefined,
      image_aspect_ratio: undefined,
      card_size: undefined,
    });
  });

  it("a suggestion chip fills the image input", () => {
    render(
      <ViewSettings
        title="Books"
        initial={{}}
        propertySuggestions={["cover", "banner"]}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    const chips = screen.getAllByTestId("view-settings.image-suggestion");
    const cover = chips.find((c) => c.getAttribute("data-value") === "cover")!;
    fireEvent.click(cover);
    expect(
      (screen.getByTestId("view-settings.image-input") as HTMLInputElement)
        .value,
    ).toBe("cover");
  });

  it("the card-size slider is clamped to 120–600", () => {
    render(
      <ViewSettings
        title="Books"
        initial={{}}
        propertySuggestions={[]}
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
        propertySuggestions={[]}
        onCancel={onCancel}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByTestId("view-settings.cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
