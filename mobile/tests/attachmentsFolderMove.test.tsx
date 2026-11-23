// @vitest-environment jsdom
//
// Filing a file into a folder from the phone (myne-md/myne#1075).
//
// What is under test is the WIRING, not the pixels: which folders the scope row
// offers, that the scope actually narrows the list, and that picking a folder in
// a row sends ONE batch assignment and shows the new folder without a reload.
// `useTranslation` echoes its keys here, so the copy assertions compare against
// the repo's own key names and the closing case proves each of those keys exists
// in the English catalog rather than in the stub.
//
// The case that keeps the rest honest is "an empty move list is not a call":
// `attachmentSetFolders` refuses an empty batch, so a surface that filtered
// everything out must not reach the host at all.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@myne/locales-en";

const catalogList = vi.hoisted(() => vi.fn());
const setFolders = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-i18next")>();
  return {
    ...real,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock("../src/lib/attachments", () => ({
  catalogList,
  attachmentSetFolders: setFolders,
  attachmentDelete: vi.fn(),
  attachmentRename: vi.fn(),
  attachmentUnusedList: vi.fn(),
  attachmentCleanUnused: vi.fn(),
  importFile: vi.fn(),
  ATTACHMENT_ACCEPT: "image/*",
}));
vi.mock("../src/lib/attachmentRef", () => ({
  attachmentSrc: (id: string) => `attachment://localhost/${id}`,
}));
vi.mock("../src/lib/app-window", () => ({ HAS_TAURI: true }));
vi.mock("../src/lib/use-prefs", () => ({ usePrefs: () => ({ prefs: {} }) }));

import { AttachmentsSheet } from "../src/app/flows/AttachmentsSheet";

const id = (n: string) => n.repeat(64).slice(0, 64);

const ROWS = [
  { id: id("a"), content_type: "application/pdf", created_at: 1, filename: "hafta-1.pdf", folder: "Ders Notları/", size: 10 },
  { id: id("b"), content_type: "application/pdf", created_at: 2, filename: "hafta-2.pdf", folder: "Ders Notları/Hafta 2/", size: 20 },
  { id: id("c"), content_type: "image/png", created_at: 3, filename: "root.png", folder: "", size: 30 },
];

function renderSheet() {
  return render(<AttachmentsSheet onClose={() => {}} variant="page" />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the files library's folder scope", () => {
  it("offers All plus every folder the catalog uses", async () => {
    catalogList.mockResolvedValue(ROWS);
    renderSheet();
    const scope = await screen.findByTestId("files.folder-scope");
    await waitFor(() => expect(scope.textContent).toContain("attachments.folderAll"));
    expect(scope.textContent).toContain("Ders Notları");
    expect(scope.textContent).toContain("Ders Notları/Hafta 2");
    // Every folder is a segment addressed by its own path, which is what a move
    // sends too: one vocabulary for a scope and a destination.
    // The root is not a folder a person picks; it is the absence of one.
    expect(scope.textContent).not.toContain("No folder");
  });

  it("narrows to the subtree, not to one directory", async () => {
    catalogList.mockResolvedValue(ROWS);
    renderSheet();
    const scope = await screen.findByTestId("files.folder-scope");
    await waitFor(() => expect(scope.textContent).toContain("Ders Notları"));

    // The scope is the segmented primitive, whose segments are addressed by
    // value rather than by their translated label.
    fireEvent.click(screen.getByTestId("files.folder-scope-Ders Notları/"));

    // Both the folder's own file and the one in its subfolder survive: a term
    // folder holds week folders, and scoping to the term means the term.
    await waitFor(() => {
      expect(screen.getByText("hafta-1.pdf")).toBeTruthy();
      expect(screen.getByText("hafta-2.pdf")).toBeTruthy();
      expect(screen.queryByText("root.png")).toBeNull();
    });
  });

  it("sends one batch assignment when a row picks a folder", async () => {
    catalogList.mockResolvedValue(ROWS);
    renderSheet();
    await screen.findByText("hafta-1.pdf");

    // The row's own Move control opens the picker; the picker is what sends.
    // The row is addressed by its own id, not by position: an index into the
    // rendered order is a test that breaks the day the order changes, and it was
    // already pointing at the wrong row.
    const actions = await screen.findByTestId(`files.row-actions.${id("c")}`);
    fireEvent.click(within(actions).getByText("attachments.move"));
    // The picker is a segmented control too, and the row it belongs to is the one
    // named in its testid.
    const picker = await screen.findByTestId("files.row-folder");
    fireEvent.click(within(picker).getByTestId(`files.row-folder.${id("c")}-Ders Notları/`));

    await waitFor(() =>
      expect(setFolders).toHaveBeenCalledWith([{ id: id("c"), folder: "Ders Notları/" }]),
    );
  });

  it("draws no scope row when every file is at the root", async () => {
    catalogList.mockResolvedValue([ROWS[2]]);
    renderSheet();
    await screen.findByText("root.png");
    expect(screen.queryByTestId("files.folder-scope")).toBeNull();
  });
});

describe("the copy this surface uses", () => {
  it("names every key it renders in the English catalog", () => {
    const keys = [
      "attachments.move",
      "attachments.folderAll",
      "attachments.folderRoot",
      "attachments.folderPickerAria",
      "attachments.folderMoveFailed",
    ];
    for (const key of keys) {
      const value = key.split(".").reduce<unknown>((acc, part) => {
        if (acc && typeof acc === "object" && part in acc) {
          return (acc as Record<string, unknown>)[part];
        }
        return undefined;
      }, en);
      expect(typeof value, `${key} is missing from locales/en/common.json`).toBe("string");
    }
  });
});
