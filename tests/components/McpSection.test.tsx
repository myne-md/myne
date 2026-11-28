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
  acceptMcpReadRequest,
  dismissMcpWriteRequest,
} = vi.hoisted(() => ({
  readMcpExternalAccess: vi.fn(),
  readMcpGrantPreview: vi.fn(),
  revokeMcpConnection: vi.fn((_name: string) => Promise.resolve(true)),
  setMcpConnectionGrant: vi.fn(
    (
      _name: string,
      _excludedFolders: string[],
      _writeFolders: string[],
      _disabledVerbs: string[],
    ) => Promise.resolve(true),
  ),
  acceptMcpReadRequest: vi.fn((_connection: string, _folder: string) =>
    Promise.resolve(true),
  ),
  acceptMcpWriteRequest: vi.fn((_connection: string, _folder: string) =>
    Promise.resolve(true),
  ),
  dismissMcpWriteRequest: vi.fn(
    (_connection: string, _folder: string, _kind: "write" | "read") =>
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
  acceptMcpReadRequest,
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
    tools: [
      { verb: "note_search", enabled: true, availableInBuild: true, isWrite: false },
      { verb: "note_read", enabled: true, availableInBuild: true, isWrite: false },
      { verb: "vault_list", enabled: true, availableInBuild: true, isWrite: false },
      { verb: "vault_state", enabled: true, availableInBuild: true, isWrite: false },
      { verb: "note_create", enabled: true, availableInBuild: true, isWrite: true },
      { verb: "note_append", enabled: true, availableInBuild: true, isWrite: true },
      { verb: "note_set_field", enabled: true, availableInBuild: true, isWrite: true },
      { verb: "note_move", enabled: true, availableInBuild: true, isWrite: true },
      { verb: "note_edit", enabled: true, availableInBuild: true, isWrite: true },
      // The four reads that joined in myne-md/myne#1077, in the host catalog's own
      // order, so the switch bank's fixture tracks what the door actually offers.
      { verb: "attachment_list", enabled: true, availableInBuild: true, isWrite: false },
      { verb: "attachment_read", enabled: true, availableInBuild: true, isWrite: false },
      { verb: "calendar_read", enabled: true, availableInBuild: true, isWrite: false },
      { verb: "view_list", enabled: true, availableInBuild: true, isWrite: false },
    ],
    ...overrides,
  };
}

function view(connections: unknown[], writeRequests: unknown[] = []) {
  return {
    connections,
    folders: ["", "Private/", "Projects/", "Projects/New/", "Work/"],
    noteCount: 40,
    writeRequests,
    readBudget: { notesPerWindow: 300, windowSeconds: 900 },
    toolCatalog: connection().tools,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    connection: "claude-desktop",
    folder: "inbox/",
    requestedAt: 1_761_000_900,
    summary: "Shopping list",
    verb: "note_create",
    kind: "write",
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
    // Names, not canonical paths (2026-11-27): the row reads "Writes in
    // Projects, Work." — the trailing-slash form is what the vault stores, not
    // what a person reads.
    expect(line).toContain("Projects");
    expect(line).toContain("Work");
    expect(line).not.toContain("Projects/");
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
    const card = await screen.findByTestId("settings.mcp-request");
    expect(card.textContent).toContain("claude-desktop");
    expect(card.textContent).toContain("inbox");
    expect(card.textContent).toContain("Shopping list");

    fireEvent.click(screen.getByTestId("settings.mcp-request-accept"));
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
    await screen.findByTestId("settings.mcp-request");
    fireEvent.click(screen.getByTestId("settings.mcp-request-dismiss"));
    await waitFor(() =>
      expect(dismissMcpWriteRequest).toHaveBeenCalledWith(
        "claude-desktop",
        "inbox/",
        "write",
      ),
    );
    expect(acceptMcpWriteRequest).not.toHaveBeenCalled();
  });

  it("says nothing about a queue when nothing is waiting", async () => {
    // The empty case is the ordinary one, and a card that said "0 writes waiting"
    // would be furniture a person learns to skip.
    renderSection();
    await screen.findByTestId("settings.mcp-connection");
    expect(screen.queryByTestId("settings.mcp-requests")).toBeNull();
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
    expect(screen.getByTestId("settings.mcp-edit")).toBeTruthy();
    expect(screen.queryByTestId("settings.mcp-excluded")).toBeNull();
  });

  it("states what the read scope actually covers, and names no exclusion list", async () => {
    // A stale exclusion takes nothing out, and the row no longer renders the list
    // it named: the count is the EFFECT, so there is no sentence left that could
    // claim a protection a renamed folder does not give.
    readMcpExternalAccess.mockResolvedValue(
      view([
        connection({
          excludedFolders: ["Private/", "Old/"],
          staleExcludedFolders: ["Old/"],
          noteCount: 12,
        }),
      ]),
    );
    renderSection();
    await screen.findByTestId("settings.mcp-connection");
    expect(screen.getByTestId("settings.mcp-read-scope").textContent).toContain("12");
    expect(screen.queryByTestId("settings.mcp-stale")).toBeNull();
    expect(screen.queryByTestId("settings.mcp-excluded")).toBeNull();
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
  it("walks the three steps and approves with the scope the person chose", async () => {
    readMcpGrantPreview.mockResolvedValue({
      noteCount: 412,
      folderCount: 38,
      excludedCount: 0,
      excludedFolders: [],
      folders: ["", "Projects/", "Work/"],
    });
    renderSection();
    await screen.findByTestId("settings.mcp-add");
    fireEvent.click(screen.getByTestId("settings.mcp-add"));

    // Step 1 is the client cards, and all six are offered at once: the grid is
    // three across and two down, so nothing hides behind a "show more".
    await screen.findByTestId("settings.mcp-step-clients");
    expect(screen.getAllByTestId("settings.mcp-client")).toHaveLength(6);

    fireEvent.click(screen.getAllByTestId("settings.mcp-client")[0]);
    // Step 2 carries that client's own shape and its config path.
    await screen.findByTestId("settings.mcp-step-config");
    expect(screen.getByTestId("settings.mcp-snippet").textContent).toContain("mcpServers");
    expect(screen.getByTestId("settings.mcp-config-path").textContent).toContain(
      "claude_desktop_config.json",
    );
    // The name is a label rather than a credential, and the step says so once.
    expect(screen.getByTestId("settings.mcp-name-claim").textContent).toContain(
      "not a password",
    );
    fireEvent.click(screen.getByTestId("settings.mcp-flow-next"));

    // Step 3 asks one question: the whole vault, or a list of folders. The default
    // is the whole vault, which is the answer that needs no folder knowledge, and
    // the list beside it then means the folders to LEAVE OUT rather than a set to
    // opt into one at a time.
    await screen.findByTestId("settings.mcp-step-scope");
    expect(screen.getByTestId("settings.mcp-whole-vault").getAttribute("data-whole-vault")).toBe(
      "true",
    );
    expect(screen.getByTestId("settings.mcp-scope-line").textContent).toContain("Every folder");
    expect(screen.getByTestId("settings.mcp-access-picker-toggle")).toBeTruthy();
    // The switches are the host's catalog, and every one of them is a verb this
    // build serves. The bank once carried a row that could be turned on and then
    // answered version skew, which `mcp/src/surface_test.rs` now makes impossible.
    const toolRows = screen.getAllByTestId("settings.mcp-tool");
    expect(toolRows).toHaveLength(13);
    // Not one row is disabled, because not one row is a verb this build cannot
    // serve: `mcp/src/surface_test.rs` makes the advertised-and-unserved state
    // unreachable.
    for (const row of toolRows) {
      const verb = row.getAttribute("data-verb") as string;
      expect(
        (screen.getByTestId(`settings.mcp-tool-${verb}`) as HTMLInputElement).disabled,
      ).toBe(false);
    }

    // Leave one folder out, which under this reading is the exclusion list.
    fireEvent.click(screen.getByTestId("settings.mcp-access-picker-toggle"));
    const leaveOut = screen
      .getAllByTestId("settings.mcp-access-picker-option")
      .find((node) => node.getAttribute("data-value") === "Private/");
    fireEvent.click(leaveOut!);
    fireEvent.click(screen.getByTestId("settings.mcp-tool-note_edit"));
    fireEvent.click(screen.getByTestId("settings.mcp-approve"));
    await waitFor(() => expect(setMcpConnectionGrant).toHaveBeenCalledTimes(1));
    // One list, derived into the two fields the grant carries: the exclusion set is
    // what was ticked, and the write scope is every folder it does not name.
    expect(setMcpConnectionGrant).toHaveBeenCalledWith(
      "claude-desktop",
      ["Private/"],
      ["Projects/", "Projects/New/", "Work/"],
      ["note_edit"],
    );
  });

  it("marks the steps already behind the person as done", async () => {
    // The strip has to answer "where am I" without reading three titles: a step
    // that is finished carries a check and `data-done`, the current one carries
    // `aria-current`, and the ones ahead carry neither.
    readMcpExternalAccess.mockResolvedValue(view([]));
    renderSection();
    await screen.findByTestId("settings.mcp-add");
    fireEvent.click(screen.getByTestId("settings.mcp-add"));

    await screen.findByTestId("settings.mcp-step-clients");
    expect(screen.getByTestId("settings.mcp-step-1").getAttribute("aria-current")).toBe("step");
    expect(screen.getByTestId("settings.mcp-step-1").hasAttribute("data-done")).toBe(false);

    fireEvent.click(screen.getAllByTestId("settings.mcp-client")[0]);
    await screen.findByTestId("settings.mcp-step-config");

    expect(screen.getByTestId("settings.mcp-step-1").getAttribute("data-done")).toBe("true");
    expect(screen.getByTestId("settings.mcp-step-2").getAttribute("aria-current")).toBe("step");
    expect(screen.getByTestId("settings.mcp-step-3").hasAttribute("data-done")).toBe(false);
  });

  it("goes back to a step already walked, and never forward past one", async () => {
    readMcpExternalAccess.mockResolvedValue(view([]));
    renderSection();
    await screen.findByTestId("settings.mcp-add");
    fireEvent.click(screen.getByTestId("settings.mcp-add"));
    await screen.findByTestId("settings.mcp-step-clients");

    // On step 1 nothing is behind you, so no step in the strip is a way forward.
    expect((screen.getByTestId("settings.mcp-step-3") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getAllByTestId("settings.mcp-client")[0]);
    await screen.findByTestId("settings.mcp-step-config");

    // Step 1 is walkable now, and step 3 still is not: it decides what the grant
    // covers, so it cannot be reached before step 2 has been answered.
    expect((screen.getByTestId("settings.mcp-step-2") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("settings.mcp-step-1"));
    await screen.findByTestId("settings.mcp-step-clients");
  });

  it("picks folders in place, as chips over a scrolling list", async () => {
    readMcpExternalAccess.mockResolvedValue(view([]));
    renderSection();
    await screen.findByTestId("settings.mcp-add");
    fireEvent.click(screen.getByTestId("settings.mcp-add"));
    await screen.findByTestId("settings.mcp-step-clients");
    fireEvent.click(screen.getAllByTestId("settings.mcp-client")[0]);
    await screen.findByTestId("settings.mcp-step-config");
    fireEvent.click(screen.getByTestId("settings.mcp-flow-next"));
    await screen.findByTestId("settings.mcp-step-scope");

    // One access list, folded: the rectangle states its count and opens in place.
    expect(screen.queryByTestId("settings.mcp-access-picker")).toBeNull();
    fireEvent.click(screen.getByTestId("settings.mcp-access-picker-toggle"));
    const box = await screen.findByTestId("settings.mcp-access-picker");

    const option = screen
      .getAllByTestId("settings.mcp-access-picker-option")
      .find((node) => node.getAttribute("data-value") === "Private/");
    expect(option).toBeTruthy();
    fireEvent.click(option!);

    // Choosing one turns it into a chip inside the same rectangle, and the options
    // stay there rather than a panel closing over the form.
    expect(box.getAttribute("data-testid")).toBe("settings.mcp-access-picker");
    expect(screen.getByTestId("settings.mcp-access-picker-chip").textContent).toContain(
      "Private",
    );
  });

  it("keeps the longer account behind the row's question mark", async () => {
    // The surface's copy says five things; the rest of what a person needs to
    // know sits one click away on the row's own disclosure, not on a second
    // hand-rolled panel.
    renderSection();
    const trigger = await screen.findByTestId("settings.mcp-enable-explain");
    // Collapsed it is in the document and named by the row, so assistive tech
    // reads it without a click; `data-open` is what "opened" means.
    expect(
      screen.getByTestId("settings.mcp-enable-explanation").getAttribute("data-open"),
    ).toBeNull();
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(
        screen.getByTestId("settings.mcp-enable-explanation").getAttribute("data-open"),
      ).toBe("true"),
    );
  });

  it("reaches Approve even when the host cannot answer with a count", async () => {
    // The defect this rework fixes: the previous screen disabled its accept while
    // the count was missing and left it disabled for good after a failed read, so
    // the person read "choose folders before I will let you approve" from a
    // screen that never said so. The host resolves the exclusion set at the
    // write, so a missing count costs the number and nothing else.
    readMcpGrantPreview.mockRejectedValue(new Error("host is busy"));
    renderSection();
    await screen.findByTestId("settings.mcp-add");
    fireEvent.click(screen.getByTestId("settings.mcp-add"));
    fireEvent.click((await screen.findAllByTestId("settings.mcp-client"))[0]);
    fireEvent.click(await screen.findByTestId("settings.mcp-flow-next"));

    const scope = await screen.findByTestId("settings.mcp-scope-line");
    await waitFor(() => expect(scope.textContent).toContain("create later"));
    expect(
      (screen.getByTestId("settings.mcp-approve") as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByTestId("settings.mcp-approve"));
    await waitFor(() => expect(setMcpConnectionGrant).toHaveBeenCalledTimes(1));
  });

  it("grants the whole vault by default, with an empty exclusion set", async () => {
    // The consent screen asks one question, and its default answer is the vault:
    // requiring the person to tick forty folders before the tool works teaches
    // them to click through the one screen that matters. The exclusion list beside
    // it is empty until they use it, and the grant says so rather than naming
    // every folder (myne-md/myne#1077, task 19).
    readMcpExternalAccess.mockResolvedValue(view([]));
    renderSection();
    await screen.findByTestId("settings.mcp-add");
    fireEvent.click(screen.getByTestId("settings.mcp-add"));
    fireEvent.click((await screen.findAllByTestId("settings.mcp-client"))[0]);
    fireEvent.click(await screen.findByTestId("settings.mcp-flow-next"));
    await screen.findByTestId("settings.mcp-step-scope");

    fireEvent.click(screen.getByTestId("settings.mcp-approve"));
    await waitFor(() => expect(setMcpConnectionGrant).toHaveBeenCalledTimes(1));
    const [name, excluded, write] = setMcpConnectionGrant.mock.calls[0];
    expect(name).toBe("claude-desktop");
    expect(excluded).toEqual([]);
    // Every folder the vault has, and the root sentinel is not a folder.
    expect(write).toEqual(["Private/", "Projects/", "Projects/New/", "Work/"]);
  });

  it("shows the switch bank on a vault that has never approved a connection", async () => {
    // First run: no stored row to read a catalog from, and an empty switch bank
    // here would be a blank decision on the one screen a new user sees.
    readMcpExternalAccess.mockResolvedValue(view([]));
    renderSection();
    await screen.findByTestId("settings.mcp-add");
    fireEvent.click(screen.getByTestId("settings.mcp-add"));
    fireEvent.click((await screen.findAllByTestId("settings.mcp-client"))[0]);
    fireEvent.click(await screen.findByTestId("settings.mcp-flow-next"));
    await screen.findByTestId("settings.mcp-step-scope");
    expect(screen.getAllByTestId("settings.mcp-tool")).toHaveLength(13);
  });

  it("offers the raw command behind the other-clients disclosure", async () => {
    renderSection();
    await screen.findByTestId("settings.mcp-add");
    fireEvent.click(screen.getByTestId("settings.mcp-add"));
    await screen.findByTestId("settings.mcp-step-clients");
    expect(screen.queryByTestId("settings.mcp-generic-command")).toBeNull();
    fireEvent.click(screen.getByTestId("settings.mcp-other-clients-toggle"));
    expect(screen.getByTestId("settings.mcp-generic-command").textContent).toContain(
      "MYNE_MCP_CONNECTION=myne",
    );
  });

  it("renders a read request with its own sentence and accepts it as a read", async () => {
    // The two kinds move the grant in opposite directions, so the card has to say
    // which one it is and the accept has to call the matching command.
    readMcpExternalAccess.mockResolvedValue(
      view([connection()], [request({ kind: "read", verb: "note_search", folder: "Private/" })]),
    );
    renderSection();
    await screen.findByTestId("settings.mcp-request");
    expect(screen.getByTestId("settings.mcp-request").getAttribute("data-kind")).toBe("read");
    fireEvent.click(screen.getByTestId("settings.mcp-request-accept"));
    await waitFor(() =>
      expect(acceptMcpReadRequest).toHaveBeenCalledWith("claude-desktop", "Private/"),
    );
    expect(acceptMcpWriteRequest).not.toHaveBeenCalled();
  });
  it("starts a re-approval from what the grant may already read, not from its write side", async () => {
    // The one access list is the READABLE set. Seeding it from `write_folders` was the
    // regression this test now pins the other way: every grant the previous dialog
    // approved writes nowhere, so one click on Edit then Approve narrowed a
    // whole-vault connection to the vault root, and every later call answered
    // out-of-scope. This fixture may read everything except Private/, so the step
    // opens holding exactly that, and approving it again changes nothing.
    renderSection();
    await screen.findByTestId("settings.mcp-connection");
    fireEvent.click(screen.getByTestId("settings.mcp-edit"));
    await screen.findByTestId("settings.mcp-step-scope");
    await waitFor(() => expect(readMcpGrantPreview).toHaveBeenCalledWith(["Private/"]));

    fireEvent.click(screen.getByTestId("settings.mcp-approve"));
    await waitFor(() => expect(setMcpConnectionGrant).toHaveBeenCalledTimes(1));
    // The verb this build cannot dispatch is NOT written into the grant: it was never
    // the person's choice, and persisting it would silently switch the verb off for
    // every build that implements it later.
    expect(setMcpConnectionGrant).toHaveBeenCalledWith(
      "claude-desktop",
      ["Private/"],
      ["Projects/", "Projects/New/", "Work/"],
      ["note_create", "note_append", "note_set_field", "note_move", "note_edit"],
    );
  });

  it("keeps a legacy grant read-only through a re-approval", async () => {
    // The host serves a legacy grant as "writes nowhere". The one access list cannot
    // say that by itself, so every write verb starts switched off and the person has
    // to switch one on for the re-approval to grant the write half.
    readMcpExternalAccess.mockResolvedValue(
      view([
        connection({
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
    fireEvent.click(screen.getByTestId("settings.mcp-edit"));
    fireEvent.click(await screen.findByTestId("settings.mcp-approve"));
    await waitFor(() => expect(setMcpConnectionGrant).toHaveBeenCalledTimes(1));
    expect(setMcpConnectionGrant).toHaveBeenCalledWith(
      "claude-desktop",
      ["Private/", "Projects/New/", "Work/"],
      ["Projects/"],
      ["note_create", "note_append", "note_set_field", "note_move", "note_edit"],
    );
  });

  it("opens a legacy grant's scope from the stored allow list, not from nothing", async () => {
    // A legacy grant stored the folders it COULD read, and this build stores the
    // folders it may NOT. Seeding the step empty would read as "leave nothing
    // out", which is a one-click approval of the whole vault; the honest
    // translation is every folder minus what it could read.
    readMcpExternalAccess.mockResolvedValue(
      view([
        connection({
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
    fireEvent.click(screen.getByTestId("settings.mcp-edit"));
    await screen.findByTestId("settings.mcp-step-scope");
    // The one list opens holding exactly what that grant could read, with the rest
    // of the vault excluded from reads by derivation.
    fireEvent.click(screen.getByTestId("settings.mcp-access-picker-toggle"));
    const options = screen.getAllByTestId("settings.mcp-access-picker-option");
    const selected = options
      .filter((node) => node.getAttribute("data-selected") === "true")
      .map((node) => node.getAttribute("data-value"));
    expect(selected).toEqual(["Projects/"]);
  });
});
