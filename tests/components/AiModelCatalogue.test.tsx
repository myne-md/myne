// @vitest-environment jsdom
//
// `AiModelCatalogue` on its own (myne-md/myne#867; inline since myne-md/myne#885):
// the download store is the one thing `AiPanel.test.tsx` cannot drive, because it
// mounts the real store and the real host call. Here the store is a controllable
// map, which is what makes the progress, cancel and failure arms assertable at
// all.
//
// The claim under test is that those three arms render INSIDE the catalogue and
// survive it unmounting: the store is module-scope, so a download the user
// started keeps running when the panel unmounts the table, and remounting shows
// it where it was (myne-md/myne#814 is the same property one surface out; the
// topic change that unmounts this table is the surface it has here, because
// `SettingsTopicPanel` mounts only the active topic's body).

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

const PATHS = { generation: null, transcription: null, tag: null };

function mount(overrides: Partial<Parameters<typeof AiModelCatalogue>[0]> = {}) {
  const props = {
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
    downloadStates.set("tag", {
      status: "downloading",
      downloaded: 250,
      total: 500,
    });
    mount();
    const bar = screen.getByTestId("ai.download-progress-tag");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByTestId("ai.download-percent-tag").textContent).toBe(
      "settings.ai.downloadingPercent:50",
    );
    fireEvent.click(screen.getByTestId("ai.download-cancel-tag"));
    expect(cancelModelDownloadFor).toHaveBeenCalledWith("tag");
  });

  it("names a failed transfer, and a checksum refusal names itself", () => {
    downloadStates.set("tag", { status: "failed", downloaded: 0, total: 0, cause: "checksum" });
    const { props } = mount();
    // The row's own message, not only the toast: the table is where the user was
    // looking when it failed, and the message stays INSIDE the row so the row's
    // own text carries it.
    const row = screen.getByTestId("ai.download-row-tag");
    expect(row.textContent).toContain("settings.ai.downloadFailedChecksum");
    expect(props.onShowToast).toHaveBeenCalledWith("settings.ai.downloadFailedChecksum");

    cleanup();
    downloadStates.set("tag", { status: "failed", downloaded: 0, total: 0, cause: "transport" });
    const second = mount();
    expect(second.props.onShowToast).toHaveBeenCalledWith("settings.ai.downloadFailed");
  });

  it("shows an in-flight download again after the table unmounts and remounts", () => {
    // The topic change is what unmounts this table: `SettingsTopicPanel` mounts
    // only the active topic's body, so switching away from Models and back
    // remounts it. The transfer is not destroyed by that, which is the property
    // `ai-download-store.ts` is module-scope for.
    downloadStates.set("tag", { status: "downloading", downloaded: 100, total: 400 });
    const { unmount } = mount();
    expect(screen.getByTestId("ai.download-percent-tag").textContent).toBe(
      "settings.ai.downloadingPercent:25",
    );
    unmount();
    expect(screen.queryByTestId("ai.download-percent-tag")).toBeNull();
    mount();
    expect(screen.getByTestId("ai.download-percent-tag").textContent).toBe(
      "settings.ai.downloadingPercent:25",
    );
  });

  it("offers Download on a row with no file and Remove on a row with one", () => {
    const { rerender, props } = mount();
    fireEvent.click(screen.getByTestId("ai.download-button-tag"));
    expect(startModelDownload).toHaveBeenCalledWith("tag");
    expect(screen.queryByTestId("ai.remove-button-tag")).toBeNull();

    rerender(<AiModelCatalogue {...props} modelPaths={{ ...PATHS, tag: "/models/qwen-tag.gguf" }} />);
    fireEvent.click(screen.getByTestId("ai.remove-button-tag"));
    expect(removeModel).toHaveBeenCalledWith("tag");
    expect(screen.queryByTestId("ai.download-button-tag")).toBeNull();
  });

  it("renders the artefact as a row of the shared columns, with a header naming them", () => {
    // The presentation half of myne-md/myne#885: the same four columns on every
    // row, and a header row naming three of them. Asserted as the row's own
    // children rather than by reading a style, so a row that lost a cell fails.
    //
    // **The list below is NOT the coverage guarantee, and it is worth saying so
    // because this test used to read as one** (myne-md/myne#867 review): a
    // hardcoded list cannot notice an artefact the roster forgot. The guarantee
    // is the `Record<DownloadArtifactId, ModelArtifact>` in the component, which
    // fails to build the day the union grows; what this loop asserts is that the
    // rows the roster produces RENDER.
    mount();
    for (const artifact of ["tag"]) {
      const row = screen.getByTestId(`ai.download-row-${artifact}`);
      expect(row.children.length).toBeGreaterThanOrEqual(3);
      // The anchor the settings search scrolls to travels with the row.
      expect(row.getAttribute("data-setting-anchor")).toBe(`ai.download.${artifact}`);
    }
    // The state is a column VALUE, not a sentence inside the action cell: it
    // sits beside the row's own label, ahead of the control.
    expect(screen.getByTestId("ai.download-name-tag").textContent).toBe(
      "settings.ai.downloadTagLabel",
    );
    // The size is the name's detail now, not a column (myne-md/myne#885 visual
    // pass): it reaches assistive technology as the state's description, and
    // the name carries the dotted underline that says a tooltip holds it.
    const state = screen.getByTestId("ai.download-state-tag");
    const describedBy = state.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe(
      "settings.ai.downloadTagSize",
    );
    expect(screen.getByTestId("ai.download-name-tag").style.textDecorationStyle).toBe("dotted");
    expect(screen.getByTestId("ai.download-state-tag").textContent).toBe(
      "settings.ai.downloadNotInstalled",
    );
  });
});

// Each row used to be its own grid, so the `auto` action track was sized by that
// row alone and the STATE heading sat at a different x than the states under it
// (myne-md/myne#867, on the user's read: "this table is crooked"). The tracks
// now live on ONE parent and every row, the header included, is a subgrid.
describe("AiModelCatalogue: one set of columns for the whole table", () => {
  it("puts the tracks on the table and makes every row a subgrid of it", () => {
    // One row installed (Remove + folder) and one not (Download): the two
    // action cells differ in width, which is the case that skewed the columns.
    mount({ modelPaths: { ...PATHS, tag: "/models/qwen-tag.gguf" } });
    const row = screen.getByTestId("ai.download-row-tag");
    const table = row.parentElement as HTMLElement;
    expect(table.style.gridTemplateColumns).toBe("minmax(0, 2fr) minmax(0, 1fr) minmax(max-content, 1fr)");
    for (const child of Array.from(table.children) as HTMLElement[]) {
      expect(child.style.gridTemplateColumns).toBe("subgrid");
      expect(child.style.gridColumn).toBe("1 / -1");
    }
  });
});
