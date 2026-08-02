// @vitest-environment jsdom
//
// Attachments Library Transcribe entry (voice-to-text MYND-552 task 5, SYNC-V9).
// Pins the library carve-out: the per-item ⋮ menu shows a Transcribe item for
// AUDIO attachments only, gated on `transcription_enabled` (HIDDEN when off —
// NO folder-exclusion gate), and selecting it routes through the SAME shared
// `startTranscription` helper the in-note widget uses. `usePrefs`, the catalog
// IPC, and the transcribe helper are mocked.
//
// MYND-592: the gate used to be `ai_enabled`, the AI beta opt-in. Speech-to-text
// has its own switch now — turning the AI beta off no longer removes this row.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { AttachmentsLibrary } from "../../src/components/attachments/AttachmentsLibrary";
import { SidebarStateProvider } from "../../src/notes/sidebarState";
import { catalogList, type CatalogEntry } from "../../src/lib/attachments";
import { startTranscription } from "../../src/lib/transcribe";
import { showAttachmentToast } from "../../src/editor/attachments/toast";
import i18n from "../../src/i18n";

vi.mock("../../src/lib/attachments", () => ({
  catalogList: vi.fn(),
  attachmentImport: vi.fn(),
  attachmentDelete: vi.fn(),
  attachmentRename: vi.fn(),
  // Lazy transcript probe on ⋮-menu open (View transcription). Default: no
  // transcript, so the menu shows only "Transcribe" as these tests expect.
  attachmentReadExtractedText: vi.fn().mockResolvedValue(null),
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

// usePrefs is mocked per-test to flip `transcription_enabled`.
let transcriptionEnabled = false;
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { transcription_enabled: transcriptionEnabled } }),
}));

const mockedCatalog = vi.mocked(catalogList);
const mockedTranscribe = vi.mocked(startTranscription);
const mockedToast = vi.mocked(showAttachmentToast);

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
  transcriptionEnabled = false;
});

describe("Attachments Library Transcribe entry (SYNC-V9)", () => {
  it("shows Transcribe for an audio item when transcription is on", async () => {
    transcriptionEnabled = true;
    mockedCatalog.mockResolvedValue([AUDIO]);
    renderLibrary();
    const menu = await openMenuFor("voice.wav");
    const item = within(menu).getByTestId("attachments.action-transcribe");
    expect(item).toBeTruthy();
    expect((item as HTMLButtonElement).disabled).toBe(false);
  });

  it("HIDES Transcribe for an audio item when transcription is off", async () => {
    transcriptionEnabled = false;
    mockedCatalog.mockResolvedValue([AUDIO]);
    renderLibrary();
    const menu = await openMenuFor("voice.wav");
    // Transcription off → the entry is omitted entirely (MYND-270:
    // hidden, not disabled).
    expect(within(menu).queryByTestId("attachments.action-transcribe")).toBeNull();
  });

  it("does NOT show Transcribe for a non-audio item", async () => {
    transcriptionEnabled = true;
    mockedCatalog.mockResolvedValue([IMAGE]);
    renderLibrary();
    const menu = await openMenuFor("pic.png");
    expect(within(menu).queryByTestId("attachments.action-transcribe")).toBeNull();
  });

  it("selecting Transcribe routes through the shared helper with the attachment id", async () => {
    transcriptionEnabled = true;
    mockedCatalog.mockResolvedValue([AUDIO]);
    renderLibrary();
    const menu = await openMenuFor("voice.wav");
    fireEvent.click(within(menu).getByTestId("attachments.action-transcribe"));
    expect(mockedTranscribe).toHaveBeenCalledTimes(1);
    expect(mockedTranscribe).toHaveBeenCalledWith(AUDIO.id);
  });

  // MYND-591: each normalized failure cause surfaces its own truthful toast;
  // anything unrecognized falls back to the generic failure copy.
  it.each([
    ["feature_off", "attachments.library.transcribeFeatureOff"],
    ["vault_locked", "attachments.library.transcribeVaultLocked"],
    ["no_model", "attachments.library.transcribeNoModelHint"],
    ["model_load_failed", "attachments.library.transcribeModelLoadFailed"],
    ["failed", "attachments.library.transcribeFailed"],
  ] as const)("shows the per-cause toast when the run rejects %s", async (kind, key) => {
    transcriptionEnabled = true;
    mockedCatalog.mockResolvedValue([AUDIO]);
    // The mocked helper stands in for the normalized rejection the real
    // `startTranscription` produces (a `{ kind }`-tagged TranscribeError).
    mockedTranscribe.mockImplementation(() => ({
      done: Promise.reject({ kind }),
      stop: vi.fn(),
    }));
    renderLibrary();
    const menu = await openMenuFor("voice.wav");
    fireEvent.click(within(menu).getByTestId("attachments.action-transcribe"));

    await waitFor(() => expect(mockedToast).toHaveBeenCalledWith(i18n.t(key)));
  });
});
