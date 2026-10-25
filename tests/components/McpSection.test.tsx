// @vitest-environment jsdom
//
// The external-access section and its approval dialog
// (external-mcp-connection, myne-md/myne#923).
//
// What is worth asserting is not that the section renders. It is the three
// properties the surface exists for, each of which is silent when wrong:
//
//   1. The counts on the approval screen are the HOST's, and the folder set the
//      approval writes is the set the host counted. A dialog that re-derived the
//      set from its own copy of the exclusion rule would describe one grant and
//      store another.
//   2. The delta row appears only when there IS a delta, and its one action adds
//      exactly the reported folders without dropping what the connection already
//      held.
//   3. Revoking one connection leaves the others alone.
//
// The two statements that make the screen honest rather than decorative (the set
// is frozen; what the tool does with what it reads is outside Myne) are asserted
// as present, because a consent screen that omits one is the failure the PRD
// spends a paragraph on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  readMcpExternalAccess,
  readMcpGrantPreview,
  revokeMcpConnection,
  setMcpConnectionGrant,
} = vi.hoisted(() => ({
  readMcpExternalAccess: vi.fn(),
  readMcpGrantPreview: vi.fn(),
  revokeMcpConnection: vi.fn((_name: string) => Promise.resolve(true)),
  setMcpConnectionGrant: vi.fn((_name: string, _folders: string[]) =>
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
}));

import { McpSection } from "../../src/components/settings/McpSection";

function connection(overrides: Record<string, unknown> = {}) {
  return {
    name: "claude-desktop",
    readFolders: ["Projects/"],
    missingFolders: [],
    writeFolders: [],
    approvedAt: 1_761_000_000,
    lastUsedAt: 1_761_000_600,
    noteCount: 12,
    deltaFolders: [],
    ...overrides,
  };
}

function view(connections: unknown[]) {
  return {
    connections,
    folders: ["", "Projects/", "Projects/New/", "Work/"],
    noteCount: 40,
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
    excludedCount: 0,
    folders: ["", "Projects/", "Projects/New/", "Work/"],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the external-access section", () => {
  it("reports what a connection may read, what it may write, and when it ran", async () => {
    renderSection();
    await screen.findByTestId("settings.mcp-connection");
    expect(screen.getByTestId("settings.mcp-read-scope").textContent).toContain(
      "12",
    );
    expect(screen.getByTestId("settings.mcp-write-scope").textContent).toContain(
      "nothing",
    );
    expect(screen.getByTestId("settings.mcp-when").textContent).toContain(
      "Last used",
    );
  });

  it("shows the delta row only for the connection that has one", async () => {
    readMcpExternalAccess.mockResolvedValue(
      view([
        connection({ name: "claude-desktop", deltaFolders: ["Projects/New/"] }),
        connection({ name: "lm-studio", readFolders: ["Work/"] }),
      ]),
    );
    renderSection();
    await screen.findAllByTestId("settings.mcp-connection");
    const deltas = screen.getAllByTestId("settings.mcp-delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].getAttribute("data-delta-count")).toBe("1");
  });

  it("adds exactly the reported folders, and keeps what the grant already held", async () => {
    readMcpExternalAccess.mockResolvedValue(
      view([
        connection({
          readFolders: ["Projects/"],
          missingFolders: ["Old/"],
          deltaFolders: ["Projects/New/", "Work/"],
        }),
      ]),
    );
    renderSection();
    const add = await screen.findByTestId("settings.mcp-delta-add");
    fireEvent.click(add);
    await waitFor(() => expect(setMcpConnectionGrant).toHaveBeenCalledTimes(1));
    expect(setMcpConnectionGrant).toHaveBeenCalledWith("claude-desktop", [
      "Projects/",
      "Old/",
      "Projects/New/",
      "Work/",
    ]);
  });

  it("revokes one connection and leaves the other listed", async () => {
    readMcpExternalAccess
      .mockResolvedValueOnce(
        view([
          connection({ name: "claude-desktop" }),
          connection({ name: "lm-studio", readFolders: ["Work/"] }),
        ]),
      )
      // What the host answers after the revoke: one grant left.
      .mockResolvedValue(
        view([connection({ name: "lm-studio", readFolders: ["Work/"] })]),
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
      // Deliberately NOT the dialog's own folder list: the assertion below is
      // that the set written comes from here rather than from `folders`.
      folders: ["Projects/", "Work/"],
    });
    const approved: Array<[string, string[]]> = [];
    render(
      <McpSection enabled onSetEnabled={() => {}} onShowToast={() => {}} />,
    );
    await screen.findByTestId("settings.mcp-add");
    fireEvent.click(screen.getByTestId("settings.mcp-add"));

    const counts = await screen.findByTestId("settings.mcp-grant-counts");
    expect(counts.getAttribute("data-note-count")).toBe("412");
    expect(counts.getAttribute("data-folder-count")).toBe("38");
    expect(counts.getAttribute("data-excluded-count")).toBe("2");
    expect(screen.getByTestId("settings.mcp-grant-frozen").textContent).toContain(
      "frozen",
    );
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

    setMcpConnectionGrant.mockImplementation((name, folders) => {
      approved.push([name, folders]);
      return Promise.resolve(true);
    });
    fireEvent.click(screen.getByTestId("settings.mcp-grant-approve"));
    await waitFor(() => expect(approved).toHaveLength(1));
    expect(approved[0]).toEqual(["claude-desktop", ["Projects/", "Work/"]]);
  });
});
