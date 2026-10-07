// @vitest-environment jsdom
//
// Meeting AI task 4 + 6: the dialog. Properties the UI owns: nothing runs until
// the user asks, approval is what writes the note (dismissing writes nothing),
// a missing generation model routes to Settings instead of failing, and the
// custom prompt reaches the reduce call. The batch runner, the note writer, the
// model probe and the prefs read are mocked so this asserts the flow.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  runInferBatch: vi.fn(),
  writeMeetingSectionsToNote: vi.fn(
    async (_noteId: string, _sections: unknown, _notice: string) => {},
  ),
  loadModelPath: vi.fn(
    async (_role: string): Promise<string | null> => "/models/generation.gguf",
  ),
  prefsRead: vi.fn(async () => ({
    meeting_ai_prompt: null as string | null,
    ai_enabled: true,
    ai_excluded_folders: [] as string[],
  })),
}));

vi.mock("../../src/lib/meeting-ai", () => ({
  runInferBatch: mocks.runInferBatch,
}));
vi.mock("../../src/notes/ai/meetingWriteToNote", () => ({
  writeMeetingSectionsToNote: mocks.writeMeetingSectionsToNote,
}));
vi.mock("../../src/lib/ai-model-store", () => ({
  loadModelPath: mocks.loadModelPath,
}));
vi.mock("../../src/lib/prefs", () => ({
  prefsRead: mocks.prefsRead,
}));

import { MeetingAiDialog } from "../../src/components/meeting/MeetingAiDialog";
import {
  clearMeetingAiOffer,
  offerMeetingAi,
} from "../../src/components/meeting/meetingAiStore";

afterEach(() => {
  cleanup();
  clearMeetingAiOffer();
  vi.clearAllMocks();
  mocks.loadModelPath.mockResolvedValue("/models/generation.gguf");
  mocks.prefsRead.mockResolvedValue({
    meeting_ai_prompt: null,
    ai_enabled: true,
    ai_excluded_folders: [],
  });
});

function stubBatch(): void {
  mocks.runInferBatch.mockImplementation((prompts: string[]) => {
    const outputs =
      prompts.length > 1
        ? prompts.map(() => "summary")
        : ["## Summary\nAll good."];
    return { done: Promise.resolve(outputs), stop: () => {} };
  });
}

describe("MeetingAiDialog", () => {
  it("runs nothing until asked, then writes only on approval", async () => {
    stubBatch();
    offerMeetingAi("note1", "word ".repeat(2000));
    render(<MeetingAiDialog />);

    expect(mocks.runInferBatch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("meeting.ai.generate"));
    await waitFor(() => screen.getByTestId("meeting.ai.insert"));
    expect(mocks.runInferBatch).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("meeting.ai.insert"));
    await waitFor(() =>
      expect(mocks.writeMeetingSectionsToNote).toHaveBeenCalled(),
    );
    const call = mocks.writeMeetingSectionsToNote.mock.calls[0]!;
    expect(call[0]).toBe("note1");
    expect(call[1]).toMatchObject({
      summary: expect.stringContaining("All good"),
    });
  });

  it("writes nothing when the offer is dismissed", () => {
    offerMeetingAi("note1", "transcript");
    const { container } = render(<MeetingAiDialog />);
    expect(
      container.querySelector('[data-testid="meeting.ai-dialog"]'),
    ).not.toBeNull();

    fireEvent.click(screen.getByTestId("meeting.ai-dialog-close"));
    expect(mocks.writeMeetingSectionsToNote).not.toHaveBeenCalled();
  });

  it("routes to Settings when no generation model is installed", async () => {
    mocks.loadModelPath.mockResolvedValue(null);
    const onOpenAiSettings = vi.fn();
    offerMeetingAi("note1", "transcript");
    render(<MeetingAiDialog onOpenAiSettings={onOpenAiSettings} />);

    await waitFor(() => screen.getByTestId("meeting.ai.no-model"));
    expect(screen.queryByTestId("meeting.ai.generate")).toBeNull();
    fireEvent.click(screen.getByTestId("meeting.ai.open-settings"));
    expect(onOpenAiSettings).toHaveBeenCalledOnce();
  });

  it("passes the custom prompt through to the reduce call", async () => {
    stubBatch();
    mocks.prefsRead.mockResolvedValue({
      meeting_ai_prompt: "CUSTOM MARKER XYZ",
      ai_enabled: true,
      ai_excluded_folders: [],
    });
    offerMeetingAi("note1", "word ".repeat(2000));
    render(<MeetingAiDialog />);

    fireEvent.click(screen.getByTestId("meeting.ai.generate"));
    await waitFor(() => screen.getByTestId("meeting.ai.insert"));

    const reducePrompts = mocks.runInferBatch.mock.calls[1]![0] as string[];
    expect(reducePrompts[0]).toContain("CUSTOM MARKER XYZ");
  });
});
