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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ensureUsableStorage } from "../lib/_storage";

const {
  mockStatus,
  mockPayload,
  mockGenerate,
  mockCancel,
  mockApply,
  mockMemoryList,
  mockAiEnabled,
  mockAiProvider,
  mockOnboardingSeen,
} = vi.hoisted(() => ({
  mockStatus: vi.fn(),
  mockPayload: vi.fn(),
  mockGenerate: vi.fn(),
  mockCancel: vi.fn(() => Promise.resolve()),
  mockApply: vi.fn(),
  mockMemoryList: vi.fn(),
  mockAiEnabled: { value: true },
  mockAiProvider: { value: "openrouter" as string | null },
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
  usePrefs: () => ({
    prefs: { ai_enabled: mockAiEnabled.value, ai_provider: mockAiProvider.value },
  }),
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
  mockAiProvider.value = "openrouter";
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

  // Issue #970, item 8. The scope screen used to read "Provider: remote ·
  // remote": `status.provider` is the ENGINE's id (the remote arm's id is
  // literally "remote"), and the class was appended after it, so the same word
  // appeared twice and the provider the user configured never appeared at all.
  it("names the configured provider, not the engine's own id", async () => {
    mockStatus.mockResolvedValue({ ...LOCAL_STATUS, provider: "remote", remote: true });
    render(<SeedMemoryWizard open onClose={() => {}} />);
    const line = await screen.findByTestId("settings.memory.seed.provider");
    expect(line.textContent).toBe("Provider: OpenRouter");
    expect(line.textContent).not.toContain("remote");
    // The consent sentence states the same fact, so it names the same provider:
    // "Send this outline to remote" told the user nothing they could check.
    expect(screen.getByTestId("settings.memory.seed.consent-row").textContent).toContain(
      "OpenRouter",
    );
    expect(screen.getByTestId("settings.memory.seed.consent-row").textContent).not.toContain(
      "to remote",
    );
  });

  it("says the provider is this device when nothing leaves it", async () => {
    render(<SeedMemoryWizard open onClose={() => {}} />);
    const line = await screen.findByTestId("settings.memory.seed.provider");
    expect(line.textContent).toBe("Provider: on this device");
  });

  it("states the vault's shape as countable chips", async () => {
    render(<SeedMemoryWizard open onClose={() => {}} />);
    expect((await screen.findByTestId("settings.memory.seed.count-notes")).textContent).toBe(
      "24 notes",
    );
    expect(screen.getByTestId("settings.memory.seed.count-folders").textContent).toBe(
      "4 folders",
    );
    expect(screen.getByTestId("settings.memory.seed.count-tags").textContent).toBe("7 tags");
    expect(screen.getByTestId("settings.memory.seed.estimatedChars").textContent).toContain(
      "412",
    );
  });

  it("does not restate the payload truncation the payload itself shows", async () => {
    // The grey line said "38 titles omitted to fit the model's context". It was
    // removed rather than reworded: "Show exactly what will be sent" is the
    // authoritative answer to the same question, and a second sentence stating
    // a subset of it is what the pass is deleting everywhere else too.
    mockPayload.mockResolvedValue({ ...PAYLOAD, titlesOmitted: 38 });
    render(<SeedMemoryWizard open onClose={() => {}} />);
    await screen.findByTestId("settings.memory.seed.provider");
    expect(screen.queryByTestId("settings.memory.seed.omitted")).toBeNull();
    expect(screen.queryByText(/titles omitted/)).toBeNull();
  });

  // Issue #970, item 9. The run report used to be a bordered `--paper-2` card
  // inside the modal: a dialog drawn inside a dialog, which is what made three
  // lines of status read as a second thing that had appeared on top of the
  // wizard. It is the wizard's own state and lives in its own body now.
  it("reports a run in the wizard's body, not in a box of its own", async () => {
    let report: ((p: { phase: string; done: number; total: number }) => void) | undefined;
    mockGenerate.mockImplementation(
      (_jobId: string, _consent: boolean, onProgress?: typeof report) =>
        new Promise(() => {
          report = onProgress;
        }),
    );
    render(<SeedMemoryWizard open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("settings.memory.seed.continue"));
    const block = await screen.findByTestId("settings.memory.seed.progress");
    // No card chrome: the two properties the old `CARD` style added.
    expect(block.style.border).toBe("");
    expect(block.style.background).toBe("");
    // The cancel control hugs its own width instead of stretching into a field.
    const cancel = screen.getByTestId("settings.memory.seed.cancel-run");
    expect(cancel.parentElement?.style.display).toBe("flex");

    act(() => report?.({ phase: "reading", done: 2, total: 5 }));
    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
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
    const onClose = vi.fn();
    render(<SeedMemoryWizard open onClose={onClose} onApplied={onApplied} />);
    fireEvent.click(await screen.findByTestId("settings.memory.seed.continue"));
    expect(await screen.findByTestId("settings.memory.seed.candidate-list")).toBeTruthy();
    expect(screen.getAllByTestId("settings.memory.seed.candidate")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("settings.memory.seed.apply"));
    // Issue #970, item 11: there is no third step. The wizard closes itself and
    // the outcome arrives as a toast, because the Memory section behind it
    // already lists every entry the old "Saved" dialog described.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByTestId("settings.memory.seed.done")).toBeNull();
    expect(mockApply).toHaveBeenCalledWith(
      ["Projects: Myne.", "Prefers short answers.", "Folders follow areas."],
      false,
    );
    // The enclosing Memory panel re-reads its roster from this callback; the
    // E2E rebuild scenario is what caught its absence.
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  // Issue #970, item 10. The one decision this screen exists for was the
  // smallest thing on it: a 13px native checkbox tucked beside the character
  // count, above the text it decides about. And the text itself was clipped:
  // `rows={3}` cut the first entry off mid-sentence, so the screen asked for
  // approval of words it had hidden.
  it("sizes the selection control and the entry so both can be read", async () => {
    mockGenerate.mockResolvedValue({
      candidates: [
        { text: "Short entry." },
        { text: "Long entry. ".repeat(80).trim() },
      ],
      notesRead: 0,
      foldersRead: [],
    });
    render(<SeedMemoryWizard open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("settings.memory.seed.continue"));
    await screen.findByTestId("settings.memory.seed.candidate-list");

    const box = screen.getByTestId("settings.memory.seed.candidate-select-0");
    // The WCAG 2.2 pointer floor, from the token rather than a literal: this is
    // the control the whole step exists for.
    expect(box.style.width).toBe("var(--target-min)");
    expect(box.style.height).toBe("var(--target-min)");
    // Its whole header row is the label, so the words toggle it too.
    expect(box.closest("label")).not.toBeNull();

    const short = screen.getByTestId("settings.memory.seed.candidate-text-0");
    const long = screen.getByTestId("settings.memory.seed.candidate-text-1");
    expect(short.getAttribute("rows")).toBe("3");
    // Grows with the entry, and stops at the cap rather than pushing Save off
    // the modal.
    expect(Number(long.getAttribute("rows"))).toBe(8);
    expect(Number(long.getAttribute("rows"))).toBeGreaterThan(
      Number(short.getAttribute("rows")),
    );

    // Unchecking dims the entry instead of hiding it: the decision is reversible
    // until Save, so the text has to stay readable.
    fireEvent.click(box);
    expect(
      screen.getAllByTestId("settings.memory.seed.candidate")[0].getAttribute("data-selected"),
    ).toBe("false");
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
