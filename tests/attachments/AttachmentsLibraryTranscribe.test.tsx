// @vitest-environment jsdom
//
// Attachments Library Transcribe entry (voice-to-text MYND-552 task 5, SYNC-V9).
// Pins the library carve-out: the per-item ⋮ menu shows a Transcribe item for
// AUDIO attachments only, gated on `ai_enabled` ALONE (disabled-not-hidden when
// off — NO folder-exclusion gate), and selecting it (AI on) routes through the
// SAME shared `startTranscription` helper the in-note widget uses. `usePrefs`,
// the catalog IPC, and the transcribe helper are mocked.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { AttachmentsLibrary } from "../../src/components/attachments/AttachmentsLibrary";
import { SidebarStateProvider } from "../../src/notes/sidebarState";
import { catalogList, type CatalogEntry } from "../../src/lib/attachments";
import { startTranscription } from "../../src/lib/transcribe";

vi.mock("../../src/lib/attachments", () => ({
  catalogList: vi.fn(),
  attachmentImport: vi.fn(),
  attachmentDelete: vi.fn(),
  attachmentRename: vi.fn(),
}));
vi.mock("../../src/notes/attachmentRefs", () => ({
  referencingNotes: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../src/editor/attachments/pdf-render", () => ({
  renderPdfFirstPage: vi.fn().mockReturnValue(new Promise(() => {})),
}));
vi.mock("../../src/editor/attachments/lightbox", () => ({ showAttachmentLightbox: vi.fn() }));
vi.mock("../../src/editor/attachments/toast", () => ({ showAttachmentToast: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("../../src/lib/transcribe", () => ({
  startTranscription: vi.fn(() => ({ done: Promise.resolve("stub"), stop: vi.fn() })),
}));

// usePrefs is mocked per-test to flip `ai_enabled`.
let aiEnabled = false;
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { ai_enabled: aiEnabled } }),
}));

const mockedCatalog = vi.mocked(catalogList);
const mockedTranscribe = vi.mocked(startTranscription);

const AUDIO: CatalogEntry = {
  id: "a".repeat(64),
  content_type: "audio/wav",
  created_at: 1_700_000_000,
  filename: "voice.wav",
  size: 2048,
};
const IMAGE: CatalogEntry = {
  id: "b".repeat(64),
  content_type: "image/png",
  created_at: 1_700_000_500,
  filename: "pic.png",
  size: 4096,
};

function renderLibrary() {
  return render(
    <SidebarStateProvider>
      <AttachmentsLibrary onClose={() => {}} />
    </SidebarStateProvider>,
  );
}

/** Open the ⋮ menu for the tile whose filename is `name`. */
async function openMenuFor(name: string) {
  await waitFor(() => expect(screen.getByText(name)).toBeTruthy());
  const tile = screen.getByText(name).closest('[data-testid="attachments.tile"]') as HTMLElement;
  fireEvent.click(within(tile).getByLabelText("Attachment actions"));
  return screen.getByRole("menu");
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  aiEnabled = false;
});

describe("Attachments Library Transcribe entry (SYNC-V9)", () => {
  it("shows Transcribe for an audio item when AI is on (enabled)", async () => {
    aiEnabled = true;
    mockedCatalog.mockResolvedValue([AUDIO]);
    renderLibrary();
    const menu = await openMenuFor("voice.wav");
    const item = within(menu).getByTestId("attachments.action-transcribe");
    expect(item).toBeTruthy();
    expect((item as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows Transcribe DISABLED (not omitted) for an audio item when AI is off", async () => {
    aiEnabled = false;
    mockedCatalog.mockResolvedValue([AUDIO]);
    renderLibrary();
    const menu = await openMenuFor("voice.wav");
    const item = within(menu).getByTestId("attachments.action-transcribe") as HTMLButtonElement;
    expect(item).toBeTruthy();
    expect(item.disabled).toBe(true);
  });

  it("does NOT show Transcribe for a non-audio item", async () => {
    aiEnabled = true;
    mockedCatalog.mockResolvedValue([IMAGE]);
    renderLibrary();
    const menu = await openMenuFor("pic.png");
    expect(within(menu).queryByTestId("attachments.action-transcribe")).toBeNull();
  });

  it("selecting Transcribe (AI on) routes through the shared helper with the attachment id", async () => {
    aiEnabled = true;
    mockedCatalog.mockResolvedValue([AUDIO]);
    renderLibrary();
    const menu = await openMenuFor("voice.wav");
    fireEvent.click(within(menu).getByTestId("attachments.action-transcribe"));
    expect(mockedTranscribe).toHaveBeenCalledTimes(1);
    expect(mockedTranscribe).toHaveBeenCalledWith(AUDIO.id);
  });
});
