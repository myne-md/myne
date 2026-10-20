// @vitest-environment jsdom
//
// The editor top bar's presence chip (myne-md/myne#849 tasks 6 and 12). This is the
// mobile entry point to the presence roster, and the property under test is the one
// the design canon decides rather than a layout detail: an affordance a client cannot
// honour is OMITTED, never shown disabled (`decisions.md` 2026-07-26). Being alone is
// therefore the normal state and must cost no chrome, while a peer's arrival must put
// the chip on screen without any other change.
//
// Why a component test rather than a flow: the chip's inputs come from the shared
// awareness store through `EditorFlow`, and the flow-logic tier cannot deliver one
// frame to it. `mobile/tests/flow-logic/mock-ipc.ts` stubs
// `@tauri-apps/api/event`'s `listen` as a NO-OP, so no spec in that tier can emit
// `sync://awareness`; the store is driven directly here instead, and what no tier in
// this tree can reach is stated where it belongs (the `collab.presence` roster entry's
// device item).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-i18next")>();
  return {
    ...real,
    useTranslation: () => ({
      t: (key: string, vars?: Record<string, unknown>) =>
        vars !== undefined && typeof vars.count === "number" ? `${key}:${vars.count}` : key,
      i18n: { language: "en" },
    }),
  };
});

import { EditorTopBar } from "../../src/app/flows/editor/chrome/EditorTopBar";

const onPresence = vi.fn();

function renderBar(peers?: number) {
  return render(
    <EditorTopBar
      onContext={vi.fn()}
      folder={null}
      busy={false}
      peers={peers}
      onPresence={onPresence}
    />,
  );
}

afterEach(() => {
  cleanup();
  onPresence.mockClear();
});

describe("the presence chip", () => {
  it("is absent when you are alone, which is the normal state", () => {
    renderBar(0);
    expect(screen.queryByTestId("editor.presence-chip")).toBeNull();
  });

  it("is absent when the host does not drive presence at all", () => {
    // `undefined` rather than `0`: the editor top bar is rendered by size-class
    // branches, and a branch that forgets the prop must cost nothing rather than
    // render a chip reading "undefined".
    renderBar(undefined);
    expect(screen.queryByTestId("editor.presence-chip")).toBeNull();
  });

  it("appears with the count as soon as a peer is present", () => {
    renderBar(2);
    const chip = screen.getByTestId("editor.presence-chip");
    expect(chip.textContent).toContain("2");
    // A control, not text: it is reachable and announced.
    expect(chip.getAttribute("role")).toBe("button");
    expect(chip.getAttribute("tabindex")).toBe("0");
  });

  it("says what activating it does, with the count interpolated", () => {
    renderBar(2);
    expect(screen.getByTestId("editor.presence-chip").getAttribute("aria-label")).toBe(
      "editor.chrome.presence.showList:2",
    );
  });

  it("opens the roster on a click, and on Enter", () => {
    renderBar(1);
    const chip = screen.getByTestId("editor.presence-chip");
    fireEvent.click(chip);
    expect(onPresence).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(onPresence).toHaveBeenCalledTimes(2);
  });
});
