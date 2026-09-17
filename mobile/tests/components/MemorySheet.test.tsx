// @vitest-environment jsdom
//
// The phone's agent-memory sheet (myne-md/myne#697, task 9).
//
// What is under test is the sheet's modal contract, not its look: the sheet
// claims `aria-modal="true"`, so Tab must cycle inside it rather than leave
// it, and Escape still closes. The bindings are mocked at the module; the
// flow-logic tier drives the same surface against mock IPC.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { MemorySheet } from "../../src/app/flows/MemorySheet";
import type { MemoryListRow } from "../../src/lib/memory";

const { mockMemoryList, mockMemoryRead, mockMemoryDelete } = vi.hoisted(() => ({
  mockMemoryList: vi.fn(),
  mockMemoryRead: vi.fn(),
  mockMemoryDelete: vi.fn(),
}));

vi.mock("../../src/lib/memory", () => ({
  memoryList: mockMemoryList,
  memoryRead: mockMemoryRead,
  memoryDelete: mockMemoryDelete,
}));

function row(over: Partial<MemoryListRow>): MemoryListRow {
  return {
    id: "a",
    created_at: 100,
    updated_at: 100,
    version: 1,
    ...over,
  };
}

const ROWS = [row({ id: "a", updated_at: 100 }), row({ id: "b", updated_at: 300 })];

function sheet(props: Partial<Parameters<typeof MemorySheet>[0]> = {}) {
  const onDeleted = vi.fn();
  const onClose = vi.fn();
  render(<MemorySheet onDeleted={onDeleted} onClose={onClose} {...props} />);
  return { onDeleted, onClose };
}

beforeEach(() => {
  mockMemoryList.mockReset().mockResolvedValue(ROWS);
  mockMemoryRead.mockReset().mockResolvedValue("entry text");
  mockMemoryDelete.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("MemorySheet", () => {
  it("renders the dialog as modal", async () => {
    sheet();
    const dialog = await screen.findByTestId("ai.memory-sheet");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("traps Tab on the last control back to the first", async () => {
    sheet();
    await screen.findAllByTestId("ai.memory-row");
    // Two rows plus the close button: last in Tab order is the close button.
    const close = screen.getByTestId("ai.memory-close");
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(screen.getByTestId("ai.memory-sheet"), {
      key: "Tab",
      shiftKey: false,
    });
    const firstDelete = screen.getAllByTestId("ai.memory-delete")[0]!;
    expect(document.activeElement).toBe(firstDelete);
  });

  it("traps Shift+Tab on the first control back to the last", async () => {
    sheet();
    await screen.findAllByTestId("ai.memory-row");
    const firstDelete = screen.getAllByTestId("ai.memory-delete")[0]!;
    firstDelete.focus();
    expect(document.activeElement).toBe(firstDelete);
    fireEvent.keyDown(screen.getByTestId("ai.memory-sheet"), {
      key: "Tab",
      shiftKey: true,
    });
    expect(document.activeElement).toBe(screen.getByTestId("ai.memory-close"));
  });

  it("lets Tab move between controls inside the sheet", async () => {
    sheet();
    await screen.findAllByTestId("ai.memory-row");
    const firstDelete = screen.getAllByTestId("ai.memory-delete")[0]!;
    // Focus is mid-sheet (not on an edge): no wrapping, no prevention, so
    // the browser's default Tab order applies and focus stays inside.
    const secondDelete = screen.getAllByTestId("ai.memory-delete")[1]!;
    secondDelete.focus();
    fireEvent.keyDown(screen.getByTestId("ai.memory-sheet"), {
      key: "Tab",
      shiftKey: false,
    });
    expect(document.activeElement).toBe(secondDelete);
    expect(firstDelete).not.toBe(document.activeElement);
  });

  it("closes on Escape", async () => {
    const { onClose } = sheet();
    await screen.findAllByTestId("ai.memory-row");
    fireEvent.keyDown(screen.getByTestId("ai.memory-sheet"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
