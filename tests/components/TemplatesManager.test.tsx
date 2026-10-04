// @vitest-environment jsdom
//
// The template manager's create flow (myne-md/myne#820).
//
// Creating a template now asks for a name instead of minting "Untitled
// template", and the created template is handed to `onOpenNote` (which
// `Editor.tsx` refreshes into the cache before opening — the other half of the
// #820 fix, covered by the open-bridge code it calls).

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
});
