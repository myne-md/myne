// @vitest-environment jsdom
//
// The reviewed vault seed's UI contract (myne-md/myne#915).
//
// Four claims, each of which is a rule the feature rests on:
//
//   1. A local provider needs no consent; a remote one cannot continue until the
//      box is ticked. The host re-checks the flag, but the screen must not offer
//      a path that looks allowed and is refused.
//   2. The payload behind the toggle is the real string the host will send, not
//      a summary.
//   3. Apply sends the checked entries and reports what landed; a refusal names
//      the candidate and keeps the rest.
//   4. The card appears only when AI is on, memory is empty, the vault has the
//      floor of notes, and this device has not dismissed it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ensureUsableStorage } from "../lib/_storage";

const {
  mockStatus,
  mockPayload,
  mockGenerate,
  mockCancel,
  mockApply,
  mockMemoryList,
  mockAiEnabled,
  mockOnboardingSeen,
} = vi.hoisted(() => ({
  mockStatus: vi.fn(),
  mockPayload: vi.fn(),
  mockGenerate: vi.fn(),
  mockCancel: vi.fn(() => Promise.resolve()),
  mockApply: vi.fn(),
  mockMemoryList: vi.fn(),
  mockAiEnabled: { value: true },
  mockOnboardingSeen: vi.fn(() => true),
}));

vi.mock("../../src/lib/seed-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/seed-memory")>();
  return {
    ...actual,
    seedMemoryStatus: mockStatus,
    seedMemoryPayload: mockPayload,
    seedMemoryGenerate: mockGenerate,
    seedMemoryCancel: mockCancel,
    memorySeedApply: mockApply,
  };
});

vi.mock("../../src/lib/memory", () => ({
  memoryList: mockMemoryList,
  memoryRead: vi.fn(() => Promise.resolve("")),
  memoryDelete: vi.fn(() => Promise.resolve()),
  memoryWrite: vi.fn(() => Promise.resolve("id")),
  personalityRead: vi.fn(() => Promise.resolve([])),
  personalityWrite: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { ai_enabled: mockAiEnabled.value } }),
}));

vi.mock("../../src/lib/aiOnboardingSeen", () => ({
  readAiOnboardingSeen: mockOnboardingSeen,
}));

import {
  SeedMemoryWizard,
} from "../../src/components/settings/SeedMemoryWizard";
import { SeedMemoryCard } from "../../src/notes/components/SeedMemoryCard";

const LOCAL_STATUS = {
  notes: 24,
  folders: 4,
  tags: 7,
  seedEntries: 0,
  seededAt: null,
  provider: "in-process",
  remote: false,
};

const PAYLOAD = {
  notes: 24,
  folders: 4,
  tags: 7,
  excludedNotes: 2,
  titlesOmitted: 0,
  chars: 412,
  payload: "VAULT OUTLINE\nLive notes: 24",
};

const CANDIDATES = [
  { text: "Projects: Myne." },
  { text: "Prefers short answers." },
  { text: "Folders follow areas." },
];

function mockHappyPath() {
  mockStatus.mockResolvedValue(LOCAL_STATUS);
  mockPayload.mockResolvedValue(PAYLOAD);
  mockGenerate.mockResolvedValue({
    candidates: CANDIDATES,
    notesRead: 0,
    foldersRead: [],
  });
  mockApply.mockResolvedValue({ ids: ["a", "b", "c"], replaced: 0, liveCount: 3 });
}

beforeEach(() => {
  mockHappyPath();
  mockMemoryList.mockResolvedValue({ rows: [], cap: 100 });
  mockAiEnabled.value = true;
  mockOnboardingSeen.mockReturnValue(true);
  ensureUsableStorage();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SeedMemoryWizard", () => {
  it("shows the real payload and does not ask a local provider for consent", async () => {
    render(<SeedMemoryWizard open onClose={() => {}} />);
    expect(await screen.findByTestId("settings.memory.seed.provider")).toBeTruthy();
    expect(screen.queryByTestId("settings.memory.seed.consent")).toBeNull();
    fireEvent.click(screen.getByTestId("settings.memory.seed.toggle-payload"));
    expect(screen.getByTestId("settings.memory.seed.payload").textContent).toBe(
      PAYLOAD.payload,
    );
    expect(screen.getByTestId("settings.memory.seed.excluded").textContent).toContain("2");
  });

  it("gates a remote run on the consent box", async () => {
    mockStatus.mockResolvedValue({ ...LOCAL_STATUS, provider: "openrouter", remote: true });
    render(<SeedMemoryWizard open onClose={() => {}} />);
    const consent = await screen.findByTestId("settings.memory.seed.consent");
    const cont = screen.getByTestId("settings.memory.seed.continue");
    expect((cont as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(consent);
    await waitFor(() =>
      expect((screen.getByTestId("settings.memory.seed.continue") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("applies the checked entries and reports the count", async () => {
    const onApplied = vi.fn();
    render(<SeedMemoryWizard open onClose={() => {}} onApplied={onApplied} />);
    fireEvent.click(await screen.findByTestId("settings.memory.seed.continue"));
    expect(await screen.findByTestId("settings.memory.seed.candidate-list")).toBeTruthy();
    expect(screen.getAllByTestId("settings.memory.seed.candidate")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("settings.memory.seed.apply"));
    expect(await screen.findByTestId("settings.memory.seed.done")).toBeTruthy();
    expect(mockApply).toHaveBeenCalledWith(
      ["Projects: Myne.", "Prefers short answers.", "Folders follow areas."],
      false,
    );
    // The enclosing Memory panel re-reads its roster from this callback; the
    // E2E rebuild scenario is what caught its absence.
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("marks the refused candidate and keeps the rest selectable", async () => {
    mockApply.mockRejectedValue({
      kind: "SeedCandidateRefused",
      detail: { index: 1, reason: "scanRejected" },
    });
    render(<SeedMemoryWizard open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("settings.memory.seed.continue"));
    await screen.findByTestId("settings.memory.seed.candidate-list");
    fireEvent.click(screen.getByTestId("settings.memory.seed.apply"));
    expect(await screen.findByTestId("settings.memory.seed.candidate-refusal-1")).toBeTruthy();
    expect(screen.getByTestId("settings.memory.seed.candidate-select-0")).toBeTruthy();
  });
});

describe("SeedMemoryCard", () => {
  it("offers the seed in the healthy zero state", async () => {
    mockStatus.mockResolvedValue({ ...LOCAL_STATUS, notes: 12, folders: 3 });
    render(<SeedMemoryCard />);
    expect(await screen.findByTestId("ai.seed-card")).toBeTruthy();
  });

  it("is absent when memory already has a row", async () => {
    mockStatus.mockResolvedValue({ ...LOCAL_STATUS, notes: 12, folders: 3 });
    mockMemoryList.mockResolvedValue({
      rows: [{ id: "x", created_at: 1, updated_at: 1, version: 1, quarantined: false }],
      cap: 100,
    });
    render(<SeedMemoryCard />);
    await waitFor(() => expect(screen.queryByTestId("ai.seed-card")).toBeNull());
  });

  it("is absent in a vault below the floor", async () => {
    mockStatus.mockResolvedValue({ ...LOCAL_STATUS, notes: 3, folders: 1 });
    render(<SeedMemoryCard />);
    await waitFor(() => expect(screen.queryByTestId("ai.seed-card")).toBeNull());
  });

  it("dismisses permanently on this device", async () => {
    mockStatus.mockResolvedValue({ ...LOCAL_STATUS, notes: 12, folders: 3 });
    render(<SeedMemoryCard />);
    fireEvent.click(await screen.findByTestId("ai.seed-card-dismiss"));
    expect(localStorage.getItem("myne.seedMemorySeen")).toBe("1");
    await waitFor(() => expect(screen.queryByTestId("ai.seed-card")).toBeNull());
  });

  it("is absent while AI is off", async () => {
    mockAiEnabled.value = false;
    render(<SeedMemoryCard />);
    await waitFor(() => expect(screen.queryByTestId("ai.seed-card")).toBeNull());
  });
});
