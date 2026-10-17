// The on-demand AI model download store (myne-md/myne#814).
//
// The point of the store is that the fetch outlives the component that started
// it, and that the host's progress event drives the state. These cases pin the
// state machine and the event wiring without a DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listen = vi.hoisted(() => vi.fn());
const downloadModel = vi.hoisted(() => vi.fn());
const cancelModelDownload = vi.hoisted(() => vi.fn());
const newDownloadId = vi.hoisted(() => vi.fn());
const isChecksumMismatch = vi.hoisted(() => vi.fn());

vi.mock("../../src/platform/event", () => ({ listen }));
vi.mock("../../src/lib/ai-model-download", () => ({
  downloadModel,
  cancelModelDownload,
  newDownloadId,
  isChecksumMismatch,
}));

type ProgressHandler = (event: {
  payload: { downloadId: string; artifact: string; downloaded: number; total: number };
}) => void;

async function freshStore() {
  vi.resetModules();
  return await import("../../src/lib/ai-download-store");
}

beforeEach(() => {
  listen.mockReset().mockResolvedValue(() => {});
  downloadModel.mockReset();
  cancelModelDownload.mockReset().mockResolvedValue(true);
  newDownloadId.mockReset().mockReturnValue("dl-1");
  isChecksumMismatch.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.resetModules();
});

describe("ai-download-store", () => {
  it("drives state to complete on a resolved invoke", async () => {
    downloadModel.mockResolvedValue("/models/tag/model.gguf");
    const store = await freshStore();
    expect(store.getModelDownloadState("tag").status).toBe("idle");
    await store.startModelDownload("tag");
    expect(downloadModel).toHaveBeenCalledWith("tag", "dl-1");
    expect(store.getModelDownloadState("tag").status).toBe("complete");
  });

  it("applies progress events to the running artefact", async () => {
    let handler: ProgressHandler | null = null;
    listen.mockImplementation((_event: string, h: ProgressHandler) => {
      handler = h;
      return Promise.resolve(() => {});
    });
    let resolveDownload!: (v: string) => void;
    downloadModel.mockReturnValue(new Promise<string>((r) => (resolveDownload = r)));
    const store = await freshStore();
    void store.startModelDownload("tag");
    // Let the fire-and-forget subscription settle.
    await Promise.resolve();
    handler!({
      payload: { downloadId: "dl-1", artifact: "tag", downloaded: 42, total: 100 },
    });
    const state = store.getModelDownloadState("tag");
    expect(state.status).toBe("downloading");
    expect(state.downloaded).toBe(42);
    expect(state.total).toBe(100);
    resolveDownload("/models/tag/model.gguf");
  });

  it("keeps the cancelled state when the backend then rejects the cancelled fetch", async () => {
    // The fixture MUST let the invoke reject AFTER the cancel, or the catch in
    // startModelDownload never runs and the test passes with the relabel bug
    // fully present (myne-md/myne#826). A never-settling promise was exactly
    // that vacuous fixture.
    let rejectDownload!: (e: unknown) => void;
    downloadModel.mockReturnValue(
      new Promise<string>((_res, rej) => {
        rejectDownload = rej;
      }),
    );
    const store = await freshStore();
    const started = store.startModelDownload("tag");
    // Let startModelDownload reach the `await downloadModel(...)`.
    await Promise.resolve();
    store.cancelModelDownloadFor("tag");
    expect(store.getModelDownloadState("tag").status).toBe("cancelled");
    // The host cancels by rejecting the invoke, as ModelDownloadError::Cancelled.
    rejectDownload({ kind: "download", detail: "Cancelled" });
    await started;
    // The id-guarded catch must NOT relabel a deliberate cancel as failed.
    expect(store.getModelDownloadState("tag").status).toBe("cancelled");
    expect(cancelModelDownload).toHaveBeenCalledWith("dl-1");
  });

  it("records the checksum cause when the refusal is a digest mismatch", async () => {
    isChecksumMismatch.mockReturnValue(true);
    downloadModel.mockRejectedValue({ kind: "store", detail: "DigestMismatch" });
    const store = await freshStore();
    await store.startModelDownload("tag");
    const state = store.getModelDownloadState("tag");
    expect(state.status).toBe("failed");
    expect(state.cause).toBe("checksum");
  });

  it("does not start a second fetch while one is in flight", async () => {
    downloadModel.mockReturnValue(new Promise(() => {}));
    const store = await freshStore();
    void store.startModelDownload("tag");
    void store.startModelDownload("tag");
    expect(downloadModel).toHaveBeenCalledOnce();
  });
});
