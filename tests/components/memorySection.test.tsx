// @vitest-environment jsdom
//
// The memory roster's bound, its count and its cap message (myne-md/myne#867).
//
// Three claims, and the first is the one the change is about:
//
//   1. **The denominator comes from the HOST.** The list command answers
//      `{ rows, cap }`, so the surface prints the number the write path actually
//      enforces. A cap written into the client would print over a denominator
//      nothing keeps in step, and it would look exactly as authoritative.
//   2. **A full list says what to do about it**, at the cap and not only after a
//      refused write: the surface that shows the entries is the one a user can
//      act on.
//   3. **The roster is bounded and scrolls.** Up to 100 entries of up to 2000
//      characters each, in a panel that scrolls as a whole: unbounded, it buries
//      the clear-all control and the personality editor under itself, which are
//      the controls a full list makes you need.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { mockMemoryList, mockMemoryRead } = vi.hoisted(() => ({
  mockMemoryList: vi.fn(),
  mockMemoryRead: vi.fn(() => Promise.resolve("the user's name is Ömer")),
}));

vi.mock("../../src/lib/seed-memory", () => ({
  seedMemoryStatus: vi.fn(() =>
    Promise.resolve({
      notes: 24,
      folders: 4,
      tags: 7,
      seedEntries: 2,
      seededAt: 1_700_000_000_000,
      provider: "in-process",
      remote: false,
    }),
  ),
  seedMemoryPayload: vi.fn(),
  seedMemoryGenerate: vi.fn(),
  seedMemoryCancel: vi.fn(),
  memorySeedApply: vi.fn(),
  isSeedStale: () => false,
  SEED_STALE_COOLDOWN_DAYS: 14,
  SEED_STALE_RATIO: 0.25,
  SEED_SUGGEST_MIN_NOTES: 10,
}));

vi.mock("../../src/lib/memory", () => ({
  memoryList: mockMemoryList,
  memoryRead: mockMemoryRead,
  memoryDelete: vi.fn(() => Promise.resolve()),
  memoryWrite: vi.fn(() => Promise.resolve("id")),
  personalityRead: vi.fn(() => Promise.resolve([])),
  personalityWrite: vi.fn(() => Promise.resolve()),
}));

import { MemorySection } from "../../src/components/settings/MemorySection";
import * as memoryLib from "../../src/lib/memory";

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    created_at: 1,
    updated_at: 2,
    version: 1,
    quarantined: false,
  }));
}

function renderSection() {
  return render(<MemorySection aiEnabled onShowToast={() => {}} />);
}

beforeEach(() => {
  mockMemoryList.mockReset();
  mockMemoryRead.mockClear();
});
afterEach(cleanup);

describe("MemorySection: the roster is bounded, counted, and honest at the cap", () => {
  it("counts against the host's cap, not one of its own", async () => {
    // A cap of 7 rather than 100 on purpose: a constant in the client would
    // print `3 / 100` here and this is the assertion that catches it.
    mockMemoryList.mockResolvedValue({ rows: rows(3), cap: 7 });
    renderSection();
    const count = await screen.findByTestId("settings.memory.count");
    expect(count.textContent).toContain("3");
    expect(count.textContent).toContain("7");
    // Below the cap, nothing to do about it yet.
    expect(screen.queryByTestId("settings.memory.at-cap")).toBeNull();
  });

  it("says what to do when the list is full", async () => {
    mockMemoryList.mockResolvedValue({ rows: rows(7), cap: 7 });
    renderSection();
    expect(await screen.findByTestId("settings.memory.at-cap")).toBeTruthy();
    // And it names the ACTION, not only the limit: a limit without a next step
    // is the dead end this exists to remove. Asserted as the copy itself, since
    // this file does not mock i18n.
    const atCap = screen.getByTestId("settings.memory.at-cap").textContent ?? "";
    expect(atCap).toContain("nothing new can be remembered");
    expect(atCap).toContain("Delete an entry");
  });

  it("bounds the roster and lets it scroll", async () => {
    mockMemoryList.mockResolvedValue({ rows: rows(3), cap: 100 });
    renderSection();
    const list = await screen.findByTestId("settings.memory.list");
    // jsdom does not lay out, so the declaration is the contract: without these
    // two the list has no ceiling and the controls under it move off the panel.
    expect(list.style.overflowY).toBe("auto");
    expect(list.style.maxHeight).not.toBe("");
    expect(Number.parseInt(list.style.maxHeight, 10)).toBeGreaterThan(0);
  });
});

describe("MemorySection: the seed group is separate and removable", () => {
  // Issue #970, item 12. The row's meta line ended "· v1": `version` is the
  // causal counter conflict resolution compares, and a reader has no action it
  // implies. A number nobody can act on reads as an unexplained status.
  it("states when the entry changed and not its internal version", async () => {
    mockMemoryList.mockResolvedValue({
      rows: [
        {
          id: "user1",
          created_at: 1,
          updated_at: 2,
          version: 7,
          quarantined: false,
        },
      ],
      cap: 100,
    });
    render(<MemorySection aiEnabled onShowToast={() => {}} />);
    const row = await screen.findByTestId("settings.memory.row");
    const meta = row.querySelector("p:last-of-type");
    expect(meta?.textContent).not.toContain("v7");
    expect(meta?.textContent).not.toMatch(/\bv\d/);
    expect(meta?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("groups seed rows apart from everything else", async () => {
    const seed = (id: string) => ({
      id,
      created_at: 1_700_000_000_000,
      updated_at: 2,
      version: 1,
      quarantined: false,
      origin: "seed",
    });
    mockMemoryList.mockResolvedValue({
      rows: [
        seed("seed1"),
        { id: "user1", created_at: 1, updated_at: 2, version: 1, quarantined: false },
        seed("seed2"),
      ],
      cap: 100,
    });
    renderSection();
    const group = await screen.findByTestId("settings.memory.seed-group");
    expect(group.textContent).toContain("From your vault");
    expect(screen.getAllByTestId("settings.memory.seed-entry")).toHaveLength(2);
    // The ordinary list carries only the row that is not seed-marked.
    const main = screen.getByTestId("settings.memory.list");
    expect(main.querySelectorAll('[data-testid="settings.memory.row"]')).toHaveLength(1);
  });

  it("removes only the seed rows after a confirmation", async () => {
    const seed = (id: string) => ({
      id,
      created_at: 1_700_000_000_000,
      updated_at: 2,
      version: 1,
      quarantined: false,
      origin: "seed",
    });
    mockMemoryList.mockResolvedValue({
      rows: [
        seed("seed1"),
        { id: "user1", created_at: 1, updated_at: 2, version: 1, quarantined: false },
        seed("seed2"),
      ],
      cap: 100,
    });
    renderSection();
    fireEvent.click(await screen.findByTestId("settings.memory.seed.remove-all"));
    fireEvent.click(screen.getByTestId("settings.memory.seed.remove-confirm"));
    await waitFor(() => {
      expect(memoryLib.memoryDelete).toHaveBeenCalledTimes(2);
      expect(memoryLib.memoryDelete).toHaveBeenCalledWith("seed1");
      expect(memoryLib.memoryDelete).toHaveBeenCalledWith("seed2");
    });
  });
});
