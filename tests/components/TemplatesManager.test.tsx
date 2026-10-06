// @vitest-environment jsdom
//
// The template manager's create flow (myne-md/myne#820).
//
// Creating a template now asks for a name instead of minting "Untitled
// template", and the created template is handed to `onOpenNote` (which
// `Editor.tsx` refreshes into the cache before opening — the other half of the
// #820 fix, covered by the open-bridge code it calls).

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const listTemplates = vi.hoisted(() => vi.fn());
const createTemplate = vi.hoisted(() => vi.fn());
const convertTemplateToNote = vi.hoisted(() => vi.fn());
const deleteTemplate = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../src/notes", () => ({
  listTemplates,
  createTemplate,
  convertTemplateToNote,
  deleteTemplate,
}));

import { TemplatesManager } from "../../src/components/TemplatesManager";
import {
  WorkspaceProvider,
  useWorkspace,
  type WorkspaceApi,
} from "../../src/notes/workspaceContext";

/** Renders `ui` inside a real `WorkspaceProvider` and hands back a live handle
 *  to the workspace API so a test can open a note and read the tab strips. */
function renderWithWorkspace(ui: ReactNode): { current: WorkspaceApi | null } {
  const api: { current: WorkspaceApi | null } = { current: null };
  function Probe() {
    api.current = useWorkspace();
    return null;
  }
  render(
    <WorkspaceProvider>
      <Probe />
      {ui}
    </WorkspaceProvider>,
  );
  return api;
}

/** Every note id still present in any pane's tab strip. */
function openNoteIds(
  leaves: Array<{ tabs: Array<{ kind: string; id: string }> }>,
): string[] {
  return leaves
    .flatMap((l) => l.tabs)
    .filter((t) => t.kind === "note")
    .map((t) => t.id);
}

beforeEach(() => {
  listTemplates.mockReset().mockResolvedValue([]);
  createTemplate.mockReset().mockResolvedValue("note-1");
});
afterEach(cleanup);

describe("TemplatesManager create flow", () => {
  it("asks for a name and creates the template with it", async () => {
    const onOpenNote = vi.fn();
    const onClose = vi.fn();
    render(<TemplatesManager open onClose={onClose} onOpenNote={onOpenNote} />);

    fireEvent.click(await screen.findByTestId("templates.new"));
    const input = (await screen.findByTestId(
      "templates.new-name",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Meeting note" } });
    fireEvent.click(screen.getByTestId("templates.new-create"));

    await waitFor(() =>
      expect(createTemplate).toHaveBeenCalledWith("Meeting note", ""),
    );
    expect(onOpenNote).toHaveBeenCalledWith("note-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("falls back to the default name when the field is left empty", async () => {
    const onOpenNote = vi.fn();
    render(
      <TemplatesManager open onClose={() => {}} onOpenNote={onOpenNote} />,
    );
    fireEvent.click(await screen.findByTestId("templates.new"));
    fireEvent.click(await screen.findByTestId("templates.new-create"));
    await waitFor(() =>
      expect(createTemplate).toHaveBeenCalledWith(
        "templates.manager.newTemplateName",
        "",
      ),
    );
    expect(onOpenNote).toHaveBeenCalledWith("note-1");
  });

  it("does not create a second template while the first is in flight", async () => {
    let resolveCreate!: (id: string) => void;
    createTemplate.mockReturnValue(
      new Promise<string>((r) => {
        resolveCreate = r;
      }),
    );
    const onOpenNote = vi.fn();
    render(<TemplatesManager open onClose={() => {}} onOpenNote={onOpenNote} />);
    fireEvent.click(await screen.findByTestId("templates.new"));
    const create = screen.getByTestId("templates.new-create");
    // A double-click (or held Enter) inside one IPC round trip.
    fireEvent.click(create);
    fireEvent.click(create);
    expect(createTemplate).toHaveBeenCalledOnce();
    resolveCreate("note-1");
    await waitFor(() => expect(onOpenNote).toHaveBeenCalledWith("note-1"));
  });

  it("cancels the naming step on Escape without closing the modal", async () => {
    const onClose = vi.fn();
    render(<TemplatesManager open onClose={onClose} onOpenNote={() => {}} />);
    fireEvent.click(await screen.findByTestId("templates.new"));
    const input = await screen.findByTestId("templates.new-name");
    fireEvent.keyDown(input, { key: "Escape" });
    // Back on the list step, modal still open.
    expect(screen.queryByTestId("templates.new-name")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("surfaces a create failure inline instead of swallowing it", async () => {
    createTemplate.mockRejectedValue(new Error("boom"));
    const onClose = vi.fn();
    render(<TemplatesManager open onClose={onClose} onOpenNote={() => {}} />);
    fireEvent.click(await screen.findByTestId("templates.new"));
    fireEvent.click(await screen.findByTestId("templates.new-create"));
    expect(await screen.findByTestId("templates.error")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Deleting a template soft-trashes an ordinary note, and a template can be open
// in a pane (the row-open button). The delete must close that pane's tab, or the
// resident buffer's next autosave writes the pre-trash body back and returns the
// note from the trash (myne-md/myne#819). These drive the SURFACE, not
// `closeNoteEverywhere` directly, so removing the call reddens.
describe("TemplatesManager delete closes the note's pane tab", () => {
  it("closes the tab after a successful delete", async () => {
    listTemplates.mockResolvedValue([
      { noteUuid: "tpl-1", title: "Meeting", folder: null },
    ]);
    deleteTemplate.mockResolvedValue(undefined);
    const api = renderWithWorkspace(
      <TemplatesManager open onClose={() => {}} onOpenNote={() => {}} />,
    );
    act(() => api.current!.openInFocused("tpl-1"));
    expect(openNoteIds(api.current!.leaves)).toContain("tpl-1");

    fireEvent.click(await screen.findByTestId("templates.row-delete"));
    await waitFor(() => expect(deleteTemplate).toHaveBeenCalledWith("tpl-1"));
    await waitFor(() =>
      expect(openNoteIds(api.current!.leaves)).not.toContain("tpl-1"),
    );
  });

  it("keeps the tab when the delete fails (nothing was trashed)", async () => {
    listTemplates.mockResolvedValue([
      { noteUuid: "tpl-2", title: "Meeting", folder: null },
    ]);
    deleteTemplate.mockRejectedValue(new Error("boom"));
    const api = renderWithWorkspace(
      <TemplatesManager open onClose={() => {}} onOpenNote={() => {}} />,
    );
    act(() => api.current!.openInFocused("tpl-2"));

    fireEvent.click(await screen.findByTestId("templates.row-delete"));
    await waitFor(() => expect(deleteTemplate).toHaveBeenCalledWith("tpl-2"));
    // Give the rejected promise a beat to settle before asserting it stayed.
    await waitFor(() =>
      expect(openNoteIds(api.current!.leaves)).toContain("tpl-2"),
    );
  });
});
