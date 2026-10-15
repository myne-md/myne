// @vitest-environment jsdom
//
// `AiModelCatalogue` on its own (myne-md/myne#867): the download store is the
// one thing `AiPanel.test.tsx` cannot drive, because it mounts the real store
// and the real host call. Here the store is a controllable map, which is what
// makes the progress, cancel and failure arms assertable at all.
//
// The claim under test is that those three arms render INSIDE the catalogue and
// survive the catalogue closing: the store is module-scope, so a download the
// user started and shut the modal on keeps running, and reopening shows it
// where it was (myne-md/myne#814 is the same property one surface out).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { cancelModelDownloadFor, startModelDownload, removeModel } = vi.hoisted(() => ({
  cancelModelDownloadFor: vi.fn(),
  startModelDownload: vi.fn(() => Promise.resolve()),
  removeModel: vi.fn(() => Promise.resolve()),
}));

/** Mutable per-artefact state, so a test can put a row into any of the store's
 *  arms without racing a real transfer. */
const downloadStates = new Map<string, { status: string; downloaded: number; total: number; cause?: string }>();

vi.mock("../../src/lib/ai-download-store", () => ({
  useModelDownload: (artifact: string) => downloadStates.get(artifact) ?? { status: "idle", downloaded: 0, total: 0 },
  startModelDownload,
  cancelModelDownloadFor,
}));

vi.mock("../../src/lib/ai-model-download", () => ({
  removeModel,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { path?: string; name?: string; percent?: number }) =>
      opts?.percent !== undefined
        ? `${key}:${opts.percent}`
        : opts?.path !== undefined
          ? `${key}:${opts.path}`
          : opts?.name !== undefined
            ? `${key}:${opts.name}`
            : key,
  }),
}));

import { AiModelCatalogue } from "../../src/components/settings/AiModelCatalogue";

const PATHS = { generation: null, embedding: null, transcription: null, tag: null };

function mount(overrides: Partial<Parameters<typeof AiModelCatalogue>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    modelPaths: PATHS,
    aiEnabled: true,
    onChanged: vi.fn(),
    onShowToast: vi.fn(),
    ...overrides,
  };
  const view = render(<AiModelCatalogue {...props} />);
  return { ...view, props };
}

beforeEach(() => {
  downloadStates.clear();
  cancelModelDownloadFor.mockClear();
  startModelDownload.mockClear();
  removeModel.mockClear();
});
afterEach(() => cleanup());

describe("AiModelCatalogue: the download states", () => {
  it("renders an in-flight download as progress, percent and a cancel that cancels", () => {
    downloadStates.set("embedding-e5-small", {
      status: "downloading",
      downloaded: 250,
      total: 500,
    });
    mount();
    const bar = screen.getByTestId("ai.download-progress-embedding-e5-small");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByTestId("ai.download-percent-embedding-e5-small").textContent).toBe(
      "settings.ai.downloadingPercent:50",
    );
    fireEvent.click(screen.getByTestId("ai.download-cancel-embedding-e5-small"));
    expect(cancelModelDownloadFor).toHaveBeenCalledWith("embedding-e5-small");
  });

  it("names a failed transfer, and a checksum refusal names itself", () => {
    downloadStates.set("tag", { status: "failed", downloaded: 0, total: 0, cause: "checksum" });
    const { props } = mount();
    // The row's own message, not only the toast: the modal is where the user was
    // looking when it failed.
    expect(screen.getByTestId("ai.download-row-tag")).toBeTruthy();
    expect(props.onShowToast).toHaveBeenCalledWith("settings.ai.downloadFailedChecksum");

    cleanup();
    downloadStates.set("tag", { status: "failed", downloaded: 0, total: 0, cause: "transport" });
    const second = mount();
    expect(second.props.onShowToast).toHaveBeenCalledWith("settings.ai.downloadFailed");
  });

  it("shows an in-flight download again after the catalogue is closed and reopened", () => {
    downloadStates.set("tag", { status: "downloading", downloaded: 100, total: 400 });
    const { rerender, props } = mount();
    expect(screen.getByTestId("ai.download-percent-tag").textContent).toBe(
      "settings.ai.downloadingPercent:25",
    );
    // Closed: the modal is gone, the DOWNLOAD is not.
    rerender(<AiModelCatalogue {...props} open={false} />);
    expect(screen.queryByTestId("ai.download-percent-tag")).toBeNull();
    rerender(<AiModelCatalogue {...props} open />);
    expect(screen.getByTestId("ai.download-percent-tag").textContent).toBe(
      "settings.ai.downloadingPercent:25",
    );
  });

  it("offers Start on a row with no file and Remove on a row with one", () => {
    const { rerender, props } = mount();
    fireEvent.click(screen.getByTestId("ai.download-button-tag"));
    expect(startModelDownload).toHaveBeenCalledWith("tag");
    expect(screen.queryByTestId("ai.remove-button-tag")).toBeNull();

    rerender(
      <AiModelCatalogue {...props} modelPaths={{ ...PATHS, tag: "/models/qwen-tag.gguf" }} />,
    );
    fireEvent.click(screen.getByTestId("ai.remove-button-tag"));
    expect(removeModel).toHaveBeenCalledWith("tag");
    expect(screen.queryByTestId("ai.download-button-tag")).toBeNull();
  });
});
