// @vitest-environment jsdom
//
// The external-access approval screen's WRITE half (external-mcp-connection,
// myne-md/myne#923 task 13).
//
// The write grant is an allow list whose empty value means "write nowhere", which
// is the opposite sense to the exclusion list beside it on the same screen. Four
// ways that goes quietly wrong, and each is asserted here:
//
//   1. A folder left out of the READ scope being offered for writing. The writer
//      refuses that with no way to say which entry was the problem, so the screen
//      must not be able to propose it: the candidates are the host's readable set.
//   2. A re-approval starting from an empty write picker, which silently revokes
//      every write the connection had. The stored list is the starting point.
//   3. An excluded folder surviving in the selection after the user excludes it
//      later in the same screen, which would send a non-subset.
//   4. Anything on this screen expressing "write everywhere". There is no such
//      sentence and no such picker state, and the empty case states what it means.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { readMcpGrantPreview } = vi.hoisted(() => ({
  readMcpGrantPreview: vi.fn(),
}));

vi.mock("../../src/lib/mcp-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/mcp-access")>()),
  readMcpGrantPreview,
}));

import { McpGrantDialog } from "../../src/components/settings/McpGrantDialog";

const FOLDERS = ["", "Archive/", "Private/", "Projects/", "Work/"];

/** The host's answer for one exclusion set: readable folders are what is left. */
function previewFor(excluded: string[]) {
  const readable = FOLDERS.filter(
    (folder) => folder !== "" && !excluded.some((ex) => folder.startsWith(ex)),
  );
  return {
    noteCount: 12,
    folderCount: readable.length,
    excludedCount: excluded.length,
    excludedFolders: excluded,
    folders: ["", ...readable],
  };
}

beforeEach(() => {
  readMcpGrantPreview.mockImplementation((excluded: string[]) =>
    Promise.resolve(previewFor([...excluded])),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(
  connection: { name: string; excludedFolders: string[]; writeFolders: string[] } | null,
  onApprove = vi.fn(async () => true),
) {
  render(
    <McpGrantDialog
      open
      connection={connection}
      folders={FOLDERS}
      onApprove={onApprove}
      onClose={() => {}}
    />,
  );
  return onApprove;
}

describe("the approval screen's write scope", () => {
  it("offers only folders the connection may also read", async () => {
    renderDialog({
      name: "claude-desktop",
      excludedFolders: ["Archive/"],
      writeFolders: [],
    });
    // The preview resolves, so the write picker's candidates are the host's
    // readable set rather than the vault's whole folder list.
    await waitFor(() => {
      expect(readMcpGrantPreview).toHaveBeenCalled();
    });
    const picker = await screen.findByTestId("settings.mcp-grant-write");
    fireEvent.click(picker);
    // `Archive/` is left out of the read scope, so it is not a candidate. In the
    // open list it appears only under the EXCLUDE picker, never here.
    const options = screen
      .getAllByRole("option")
      .map((node) => node.textContent ?? "");
    expect(options.some((label) => label.includes("Archive/"))).toBe(false);
    expect(options.some((label) => label.includes("Projects/"))).toBe(true);
  });

  it("starts a re-approval from the stored write list rather than from empty", async () => {
    const onApprove = renderDialog({
      name: "claude-desktop",
      excludedFolders: [],
      writeFolders: ["Projects/"],
    });
    // Approve without touching either picker: the stored write grant must survive,
    // because an empty picker here would mean "revoke every write" rather than
    // "leave it as it was".
    const approve = await screen.findByTestId("settings.mcp-grant-approve");
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(approve);
    await waitFor(() => expect(onApprove).toHaveBeenCalled());
    const [, excludedFolders, writeFolders] = onApprove.mock.calls[0] as unknown as [
      string,
      string[],
      string[],
    ];
    expect(excludedFolders).toEqual([]);
    expect(writeFolders).toEqual(["Projects/"]);
  });

  it("sends an empty write list for a connection approved with no write scope", async () => {
    const onApprove = renderDialog({
      name: "claude-desktop",
      excludedFolders: [],
      writeFolders: [],
    });
    const approve = await screen.findByTestId("settings.mcp-grant-approve");
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(approve);
    await waitFor(() => expect(onApprove).toHaveBeenCalled());
    const [, , writeFolders] = onApprove.mock.calls[0] as unknown as [
      string,
      string[],
      string[],
    ];
    expect(writeFolders).toEqual([]);
  });

  it("drops a write selection the user then excludes from reading", async () => {
    // Excluding a folder takes its subtree out of the read scope, so a write grant
    // on it can no longer be honoured. The screen must not send it: the writer
    // refuses a non-subset, and the refusal cannot name the entry that caused it,
    // so the user would read an unexplained failed approval.
    const onApprove = renderDialog({
      name: "claude-desktop",
      excludedFolders: [],
      writeFolders: ["Projects/"],
    });
    const excludePicker = await screen.findByTestId("settings.mcp-grant-exclude");
    fireEvent.click(excludePicker);
    const projectOptions = (await screen.findAllByRole("option")).filter(
      (node) => (node.textContent ?? "").includes("Projects/"),
    );
    fireEvent.click(projectOptions[0]);
    const approve = await screen.findByTestId("settings.mcp-grant-approve");
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(approve);
    await waitFor(() => expect(onApprove).toHaveBeenCalled());
    const [, excludedFolders, writeFolders] = onApprove.mock.calls[0] as unknown as [
      string,
      string[],
      string[],
    ];
    expect(excludedFolders).toContain("Projects/");
    expect(writeFolders).toEqual([]);
  });

  it("states that an empty write list means reading without changing anything", async () => {
    renderDialog({
      name: "claude-desktop",
      excludedFolders: [],
      writeFolders: [],
    });
    const helper = await screen.findByTestId("settings.mcp-grant-write-helper");
    expect(helper.textContent ?? "").toMatch(/read but not change/i);
    // The one sentence this screen must never say: writing is an allow list, so
    // there is no state in which the connection may write anywhere it can read.
    expect(document.body.textContent ?? "").not.toMatch(/write (in )?the whole vault/i);
  });
});
