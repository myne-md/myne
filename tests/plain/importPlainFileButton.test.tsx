// @vitest-environment jsdom
//
// The plain surface's Import-to-vault crossing (myne-md/myne#788, task 9): the
// one control that reaches the vault, and the `requestNoteOpen` handoff that
// makes the created note open once the Editor remounts. The store-level
// contract (flush ordering, close-after-create, no copy on failure) is covered
// by tests/plain/storeImport.test.ts; this pins the UI wiring and the two
// guidance sentences. Every vault module is mocked, so a regression that
// reordered create vs. request, or dropped the request entirely, fails here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const importToVaultMock = vi.fn();
const isVaultUnlockedMock = vi.fn();
const listVaultsMock = vi.fn();
const noteCreateMock = vi.fn();
const requestNoteOpenMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../src/plain/store", () => ({
  importToVault: (...args: unknown[]) => importToVaultMock(...args),
}));
vi.mock("../../src/lib/vault-unlock", () => ({
  isVaultUnlocked: (...args: unknown[]) => isVaultUnlockedMock(...args),
}));
vi.mock("../../src/lib/vault-list", () => ({
  listVaults: (...args: unknown[]) => listVaultsMock(...args),
}));
vi.mock("../../src/notes/createNote", () => ({
  noteCreate: (...args: unknown[]) => noteCreateMock(...args),
}));
vi.mock("../../src/notes/pendingNoteOpen", () => ({
  requestNoteOpen: (...args: unknown[]) => requestNoteOpenMock(...args),
}));
vi.mock("../../src/notes/import/mapping", () => ({
  mapImportedFile: () => ({ plaintext: "mapped" }),
}));

import { ImportPlainFileButton } from "../../src/components/plain/ImportPlainFileButton";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ImportPlainFileButton", () => {
  it("unlocked: creates the note then asks the editor to open it", async () => {
    isVaultUnlockedMock.mockResolvedValue(true);
    noteCreateMock.mockResolvedValue("note-1");
    // The real `importToVault` runs the create callback; the mock does too, so
    // the button's `requestNoteOpen` line is exercised on a live path.
    importToVaultMock.mockImplementation(
      async (_handle: number, create: (f: { name: string; content: string }) => Promise<string>) => {
        await create({ name: "a.md", content: "# a" });
        return "note-1";
      },
    );

    render(<ImportPlainFileButton handle={7} />);
    fireEvent.click(screen.getByTestId("plain-file.import"));

    await waitFor(() => expect(requestNoteOpenMock).toHaveBeenCalledWith("note-1"));
    expect(noteCreateMock).toHaveBeenCalledWith("mapped", null);
  });

  it("locked vault: guides the user and never imports", async () => {
    isVaultUnlockedMock.mockResolvedValue(false);
    listVaultsMock.mockResolvedValue({ ok: [{ id: "v1" }] });

    render(<ImportPlainFileButton handle={7} />);
    fireEvent.click(screen.getByTestId("plain-file.import"));

    const alert = await screen.findByTestId("plain-file.import-guidance");
    expect(alert.textContent).toBe("plainFile.importLocked");
    expect(importToVaultMock).not.toHaveBeenCalled();
  });

  it("no vault: says so rather than offering an unlock", async () => {
    isVaultUnlockedMock.mockResolvedValue(false);
    listVaultsMock.mockResolvedValue({ ok: [] });

    render(<ImportPlainFileButton handle={7} />);
    fireEvent.click(screen.getByTestId("plain-file.import"));

    const alert = await screen.findByTestId("plain-file.import-guidance");
    expect(alert.textContent).toBe("plainFile.importNeedsVault");
    expect(importToVaultMock).not.toHaveBeenCalled();
  });
});
