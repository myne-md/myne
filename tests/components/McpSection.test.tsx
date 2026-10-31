// @vitest-environment jsdom
//
// The external-access section and its approval dialog
// (external-mcp-connection, myne-md/myne#923).
//
// The grant is a list of folders to LEAVE OUT, so what is worth asserting is
// where that model can go wrong quietly:
//
//   1. The counts on the approval screen are the HOST's, and the set the approval
//      writes is the set the host resolved. A dialog that re-derived the
//      exclusions from the picker would describe one grant and store another.
//   2. An empty exclusion set is the WHOLE VAULT, and the screen says so in
//      words. A blank picker that read as "share nothing" is the one misreading
//      this model introduces.
//   3. A connection approved under the retired allow-list model claims no reach
//      and offers the re-approval, because this build serves it nothing.
//   4. A folder created after approval is covered, so there is no "add what you
//      made since" row: its absence is the feature.
//   5. Revoking one connection leaves the others alone.
//
// The two statements that make the screen honest rather than decorative (a folder
// created later is shared; what the tool does with what it reads is outside Myne)
// are asserted as present, because a consent screen that omits one is the failure
// the PRD spends a paragraph on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  readMcpExternalAccess,
  readMcpGrantPreview,
  revokeMcpConnection,
  setMcpConnectionGrant,
  acceptMcpWriteRequest,
  dismissMcpWriteRequest,
} = vi.hoisted(() => ({
  readMcpExternalAccess: vi.fn(),
  readMcpGrantPreview: vi.fn(),
  revokeMcpConnection: vi.fn((_name: string) => Promise.resolve(true)),
  setMcpConnectionGrant: vi.fn(
    (_name: string, _excludedFolders: string[], _writeFolders: string[]) =>
      Promise.resolve(true),
  ),
  acceptMcpWriteRequest: vi.fn((_connection: string, _folder: string) =>
    Promise.resolve(true),
  ),
  dismissMcpWriteRequest: vi.fn((_connection: string, _folder: string) =>
    Promise.resolve(true),
  ),
}));

vi.mock("../../src/lib/mcp-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/mcp-access")>()),
  readMcpExternalAccess,
  readMcpGrantPreview,
}));

vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/prefs")>()),
  revokeMcpConnection,
  setMcpConnectionGrant,
  acceptMcpWriteRequest,
  dismissMcpWriteRequest,
}));

import { McpSection } from "../../src/components/settings/McpSection";

function connection(overrides: Record<string, unknown> = {}) {
  return {
    name: "claude-desktop",
    legacy: false,
    legacyFolders: [],
    excludedFolders: ["Private/"],
    staleExcludedFolders: [],
    writeFolders: [],
    approvedAt: 1_761_000_000,
    lastUsedAt: 1_761_000_600,
    noteCount: 12,
    folderCount: 4,
    ...overrides,
  };
}

function view(connections: unknown[], writeRequests: unknown[] = []) {
  return {
    connections,
    folders: ["", "Private/", "Projects/", "Projects/New/", "Work/"],
    noteCount: 40,
    writeRequests,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    connection: "claude-desktop",
    folder: "inbox/",
    requestedAt: 1_761_000_900,
    summary: "Shopping list",
    verb: "note_create",
    ...overrides,
  };
}

function renderSection() {
  return render(
    <McpSection enabled onSetEnabled={() => {}} onShowToast={() => {}} />,
  );
}

beforeEach(() => {
  readMcpExternalAccess.mockResolvedValue(view([connection()]));
  readMcpGrantPreview.mockResolvedValue({
    noteCount: 40,
    folderCount: 4,
    excludedCount: 1,
    excludedFolders: ["Private/"],
    folders: ["", "Projects/", "Projects/New/", "Work/"],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the external-access section", () => {
  it("reports what a connection may read, what it leaves out, and when it ran", async () => {
    renderSection();
    await screen.findByTestId("settings.mcp-connection");
    expect(screen.getByTestId("settings.mcp-read-scope").textContent).toContain(
      "12",
    );
    expect(screen.getByTestId("settings.mcp-excluded").textContent).toContain(
      "Private/",
    );
    expect(screen.getByTestId("settings.mcp-write-scope").textContent).toContain(
      "nowhere",
    );
    expect(screen.getByTestId("settings.mcp-when").textContent).toContain(
      "Last used",
    );
  });

  it("names the folders a connection may write in, and never implies the rest", async () => {
    // The write grant is an ALLOW list, so the row has to name it. "May write in
    // projects/" and a bare "may write" are different promises: the second reads
    // as the whole vault to anyone who has just read the read-scope line.
    readMcpExternalAccess.mockResolvedValue(
      view([connection({ writeFolders: ["Projects/", "Work/"] })]),
    );
    renderSection();
    await screen.findByTestId("settings.mcp-connection");
    const line = screen.getByTestId("settings.mcp-write-scope").textContent ?? "";
    expect(line).toContain("Projects/");
    expect(line).toContain("Work/");
    expect(line).not.toContain("nowhere");
  });

  it("offers a queued out-of-scope write with what it wanted, and accepts it", async () => {
    // Task 13's surface: a write the host refused is not lost, it is a decision.
    // The row has to name the CONNECTION and the FOLDER, because accepting widens
    // exactly that one grant by exactly that one folder.
    readMcpExternalAccess.mockResolvedValue(
      view([connection()], [request()]),
    );
    renderSection();
    const card = await screen.findByTestId("settings.mcp-write-request");
    expect(card.textContent).toContain("claude-desktop");
    expect(card.textContent).toContain("inbox/");
    expect(card.textContent).toContain("Shopping list");

    fireEvent.click(screen.getByTestId("settings.mcp-write-request-accept"));
    await waitFor(() =>
      expect(acceptMcpWriteRequest).toHaveBeenCalledWith(
        "claude-desktop",
        "inbox/",
      ),
    );
    // The decision is a prefs write, so the section re-reads rather than assuming
    // the row is gone.
    await waitFor(() => expect(readMcpExternalAccess).toHaveBeenCalledTimes(2));
  });

  it("dismisses a queued write without touching any grant", async () => {
    readMcpExternalAccess.mockResolvedValue(
      view([connection()], [request()]),
    );
    renderSection();
    await screen.findByTestId("settings.mcp-write-request");
    fireEvent.click(screen.getByTestId("settings.mcp-write-request-dismiss"));
    await waitFor(() =>
      expect(dismissMcpWriteRequest).toHaveBeenCalledWith(
        "claude-desktop",
        "inbox/",
      ),
    );
    expect(acceptMcpWriteRequest).not.toHaveBeenCalled();
  });

  it("says nothing about a queue when nothing is waiting", async () => {
    // The empty case is the ordinary one, and a card that said "0 writes waiting"
    // would be furniture a person learns to skip.
    renderSection();
    await screen.findByTestId("settings.mcp-connection");
    expect(screen.queryByTestId("settings.mcp-write-requests")).toBeNull();
  });

  it("says the whole vault when nothing is left out, rather than nothing", async () => {
    // The inversion this model can produce: an empty set is permission over
    // everything, and a row that rendered an empty list would read as the
    // opposite.
    readMcpExternalAccess.mockResolvedValue(
      view([connection({ excludedFolders: [], noteCount: 40 })]),
    );
    renderSection();
    await screen.findByTestId("settings.mcp-connection");
    expect(screen.getByTestId("settings.mcp-read-scope").textContent).toContain(
      "whole vault",
    );
    expect(screen.queryByTestId("settings.mcp-excluded")).toBeNull();
  });

  it("reports a connection approved under the old model as needing re-approval", async () => {
    readMcpExternalAccess.mockResolvedValue(
      view([
        connection({
          name: "editor-plugin",
          legacy: true,
          legacyFolders: ["Projects/"],
          excludedFolders: [],
          noteCount: 0,
          folderCount: 0,
        }),
      ]),
    );
    renderSection();
    await screen.findByTestId("settings.mcp-connection");
    expect(screen.getByTestId("settings.mcp-read-scope").textContent).toContain(
      "older version",
    );
    expect(screen.getByTestId("settings.mcp-reapprove")).toBeTruthy();
    expect(screen.queryByTestId("settings.mcp-excluded")).toBeNull();
  });

  it("reports exclusions that name nothing without counting them as removed", async () => {
    readMcpExternalAccess.mockResolvedValue(
      view([
        connection({
          excludedFolders: ["Private/", "Old/"],
          staleExcludedFolders: ["Old/"],
        }),
      ]),
    );
    renderSection();
    await screen.findByTestId("settings.mcp-connection");
    expect(screen.getByTestId("settings.mcp-stale").textContent).toContain("1");
  });

  it("has no row offering to add the folders created since approval", async () => {
    // There is nothing to add: the grant is a deny list, so a folder created
    // after approval is already covered. The absence is the feature, and this
    // assertion is what stops the row coming back as a "tidy-up".
    renderSection();
    await screen.findByTestId("settings.mcp-connection");
    expect(screen.queryByTestId("settings.mcp-delta")).toBeNull();
    expect(screen.queryByTestId("settings.mcp-delta-add")).toBeNull();
  });

  it("revokes one connection and leaves the other listed", async () => {
    readMcpExternalAccess
      .mockResolvedValueOnce(
        view([
          connection({ name: "claude-desktop" }),
          connection({ name: "lm-studio", excludedFolders: ["Work/"] }),
        ]),
      )
      // What the host answers after the revoke: one grant left.
      .mockResolvedValue(
        view([connection({ name: "lm-studio", excludedFolders: ["Work/"] })]),
      );
    renderSection();
    await screen.findAllByTestId("settings.mcp-connection");
    fireEvent.click(screen.getAllByTestId("settings.mcp-revoke")[0]);
    await waitFor(() =>
      expect(revokeMcpConnection).toHaveBeenCalledWith("claude-desktop"),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("settings.mcp-connection")).toHaveLength(1),
    );
    expect(screen.getByTestId("settings.mcp-read-scope")).toBeTruthy();
  });
});

describe("the approval dialog", () => {
  it("shows the host's counts and both bounds, and approves the host's set", async () => {
    readMcpGrantPreview.mockResolvedValue({
      noteCount: 412,
      folderCount: 38,
      excludedCount: 2,
      // Deliberately NOT the dialog's own picker state: the assertion below is
      // that the set written comes from here, because the host owns the rule (a
      // folder takes its subtree with it, an entry naming nothing is dropped).
      excludedFolders: ["Private/", "Archive/"],
    });
    const approved: Array<[string, string[]]> = [];
    renderSection();
    await screen.findByTestId("settings.mcp-add");
    fireEvent.click(screen.getByTestId("settings.mcp-add"));

    const counts = await screen.findByTestId("settings.mcp-grant-counts");
    expect(counts.getAttribute("data-note-count")).toBe("412");
    expect(counts.getAttribute("data-folder-count")).toBe("38");
    expect(counts.getAttribute("data-excluded-count")).toBe("2");
    // The rule, stated plainly: what the user creates later is shared.
    expect(
      screen.getByTestId("settings.mcp-grant-later-folders").textContent,
    ).toContain("create later");
    expect(
      screen.getByTestId("settings.mcp-grant-outside-myne").textContent,
    ).toContain("outside Myne");

    // A name is required: the reserved fallback must not be approvable.
    fireEvent.change(screen.getByTestId("settings.mcp-grant-name"), {
      target: { value: "unnamed-client" },
    });
    expect(
      (screen.getByTestId("settings.mcp-grant-approve") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByTestId("settings.mcp-grant-name"), {
      target: { value: "claude-desktop" },
    });

    setMcpConnectionGrant.mockImplementation((name, excludedFolders) => {
      approved.push([name, excludedFolders]);
      return Promise.resolve(true);
    });
    fireEvent.click(screen.getByTestId("settings.mcp-grant-approve"));
    await waitFor(() => expect(approved).toHaveLength(1));
    expect(approved[0]).toEqual(["claude-desktop", ["Private/", "Archive/"]]);
  });

  it("starts a re-approval from the exclusions already stored", async () => {
    // One click on Approve must not silently widen a grant to the whole vault, so
    // the dialog seeds itself from the stored set rather than from an empty
    // picker. Asserted on the preview call, which is what the picker state drives.
    renderSection();
    await screen.findByTestId("settings.mcp-connection");
    fireEvent.click(screen.getByTestId("settings.mcp-edit"));
    await waitFor(() =>
      expect(readMcpGrantPreview).toHaveBeenCalledWith(["Private/"]),
    );
  });

  it("opens a legacy grant's approval from the stored allow list, not from nothing", async () => {
    readMcpExternalAccess.mockResolvedValue(
      view([
        connection({
          name: "editor-plugin",
          legacy: true,
          legacyFolders: ["Projects/"],
          excludedFolders: [],
          noteCount: 0,
          folderCount: 0,
        }),
      ]),
    );
    renderSection();
    fireEvent.click(await screen.findByTestId("settings.mcp-reapprove"));
    // A legacy grant has no exclusion list to seed, and inventing one from the
    // allow list would invert the meaning. It starts empty: the user chooses what
    // to leave out under the new rule.
    await waitFor(() => expect(readMcpGrantPreview).toHaveBeenCalledWith([]));
  });
});
