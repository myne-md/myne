// @vitest-environment jsdom
//
// The photo-to-note draft sheet's state machine (myne-md/myne#926 task 3).
//
// What is under test is the WIRING and the four states the backend can answer
// with, not the pixels: which read the sheet makes, what it does with each
// answer, and what it sends when the user commits. `useTranslation` echoes its
// keys here, so the copy assertions compare against the repo's own key names and
// the closing case proves each of those keys exists in the English catalog
// (`locales/en/common.json`) rather than in the stub. Without that case an
// echoed key renders nothing and every copy assertion in this file is vacuous,
// which is the shape `mobile/AGENTS.md` records from the identity flow.
//
// The case that keeps the rest honest is "an edit typed during the read
// survives": the sheet is usable BEFORE the text lands (OCR takes seconds), so
// the seed must not overwrite the one thing the surface exists to collect.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@myne/locales-en";

const readExtracted = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-i18next")>();
  return {
    ...real,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock("../src/lib/attachments", () => ({
  attachmentReadExtractedText: readExtracted,
}));
vi.mock("../src/lib/attachmentRef", () => ({
  attachmentSrc: (id: string) => `attachment://localhost/${id}`,
}));

import { PhotoNoteSheet } from "../src/app/flows/PhotoNoteSheet";

const ID = "b".repeat(64);

function renderSheet(overrides: Partial<Parameters<typeof PhotoNoteSheet>[0]> = {}) {
  const props = {
    attachmentId: ID as string | null,
    filename: "IMG_0042.jpg",
    previewUrl: null as string | null,
    ocrEnabled: true,
    onCommit: vi.fn(async () => {}),
    onCancel: vi.fn(),
    onOpenOcrSetting: vi.fn(),
    ...overrides,
  };
  const utils = render(<PhotoNoteSheet {...props} />);
  return { ...utils, props };
}

afterEach(() => {
  cleanup();
  readExtracted.mockReset();
});

describe("PhotoNoteSheet", () => {
  it("shows the photograph and a reading state before the text lands", () => {
    readExtracted.mockReturnValue(new Promise(() => {}));
    renderSheet();

    expect(screen.getByTestId("photo-note.preview")).toBeTruthy();
    expect(screen.getByTestId("photo-note.reading")).toBeTruthy();
    // The primary commit waits for the read; the explicit image-only path does
    // not, so a slow read never traps the user in the sheet.
    expect(screen.getByTestId<HTMLButtonElement>("photo-note.commit").disabled).toBe(true);
    expect(screen.getByTestId("photo-note.image-only")).toBeTruthy();
    expect(readExtracted).toHaveBeenCalledWith(ID);
  });

  it("seeds the field with the cached text when the read resolves", async () => {
    readExtracted.mockResolvedValue({
      kind: "text",
      entry: { text: "Toplantı notları\nyarın 14:00", source_format: "image", truncated: false },
    });
    renderSheet();

    await waitFor(() =>
      expect(screen.getByTestId<HTMLTextAreaElement>("photo-note.text").value).toBe(
        "Toplantı notları\nyarın 14:00",
      ),
    );
    expect(screen.getByTestId("photo-note.honesty")).toBeTruthy();
  });

  it("does not overwrite an edit typed while the read was in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    readExtracted.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderSheet();

    fireEvent.change(screen.getByTestId("photo-note.text"), {
      target: { value: "kendi yazdığım satır" },
    });
    resolve({
      kind: "text",
      entry: { text: "makinenin okuduğu metin", source_format: "image", truncated: false },
    });

    // Wait for the READ TO HAVE LANDED (the phase), not merely for the value to
    // be right: polling the value passes on the first tick, before the read's
    // own state update flushes, so it would go green with the guard removed.
    await waitFor(() =>
      expect(screen.getByTestId("photo-note.sheet").getAttribute("data-phase")).toBe("ready"),
    );
    expect(screen.getByTestId<HTMLTextAreaElement>("photo-note.text").value).toBe(
      "kendi yazdığım satır",
    );
  });

  it("offers the image alone when the page has no text", async () => {
    readExtracted.mockResolvedValue({ kind: "none" });
    const { props } = renderSheet();

    await waitFor(() => expect(screen.getByTestId("photo-note.empty")).toBeTruthy());
    fireEvent.click(screen.getByTestId("photo-note.commit"));
    await waitFor(() => expect(props.onCommit).toHaveBeenCalledWith("", "note"));
  });

  it("distinguishes a failed read from an empty page", async () => {
    readExtracted.mockResolvedValue({ kind: "failed" });
    renderSheet();

    await waitFor(() => expect(screen.getByTestId("photo-note.failed")).toBeTruthy());
    expect(screen.queryByTestId("photo-note.empty")).toBeNull();
  });

  it("explains the device-local OCR switch instead of showing an empty page", async () => {
    const { props } = renderSheet({ ocrEnabled: false });

    expect(screen.getByTestId("photo-note.ocr-off")).toBeTruthy();
    // Off means the import wrote no cache entry, so probing would be a read that
    // cannot succeed and could only report "no text" about a page nobody read.
    expect(readExtracted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("photo-note.open-ocr-setting"));
    expect(props.onOpenOcrSetting).toHaveBeenCalled();
  });

  it("stops at a locked vault rather than blaming the page", async () => {
    readExtracted.mockResolvedValue({ kind: "locked" });
    const { props } = renderSheet();

    await waitFor(() => expect(screen.getByTestId("photo-note.locked")).toBeTruthy());
    // No commit is offered: the write would be refused anyway, and a completed
    // sheet over a locked vault reads as a saved note.
    expect(screen.queryByTestId("photo-note.commit")).toBeNull();
    fireEvent.click(screen.getByTestId("photo-note.cancel"));
    expect(props.onCancel).toHaveBeenCalled();
  });

  it("sends the edited text to the chosen destination", async () => {
    readExtracted.mockResolvedValue({
      kind: "text",
      entry: { text: "orijinal", source_format: "image", truncated: false },
    });
    const { props } = renderSheet();

    await waitFor(() => expect(screen.getByTestId("photo-note.text")).toBeTruthy());
    fireEvent.change(screen.getByTestId("photo-note.text"), { target: { value: "düzeltilmiş" } });
    // The destination is a radiogroup with an accessible name, not two divs:
    // the choice is load-bearing (a board joins the open note, a page of paper
    // becomes its own), so it has to be reachable and announced.
    expect(screen.getByRole("radiogroup", { name: "photoNote.destinationLabel" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("photo-note.destination-1"));
    fireEvent.click(screen.getByTestId("photo-note.commit"));

    await waitFor(() =>
      expect(props.onCommit).toHaveBeenCalledWith("düzeltilmiş", "new"),
    );
  });

  it("the image-only escape hatch keeps what the user typed", async () => {
    // It exists so a slow read cannot trap the user, and it sends the FIELD: a
    // correction typed while waiting lives only in this component, so sending ""
    // would lose the user's own words with nothing to recover them from.
    readExtracted.mockReturnValue(new Promise(() => {}));
    const { props } = renderSheet();

    fireEvent.change(screen.getByTestId("photo-note.text"), { target: { value: "elle yazdım" } });
    fireEvent.click(screen.getByTestId("photo-note.image-only"));

    await waitFor(() => expect(props.onCommit).toHaveBeenCalledWith("elle yazdım", "note"));
  });

  it("cancels after the read landed, writing nothing", async () => {
    // The other cancel case runs with the read still in flight. This one is the
    // harder promise: the text IS on screen and the sheet still owes the vault
    // nothing when the user backs out.
    readExtracted.mockResolvedValue({
      kind: "text",
      entry: { text: "bir şeyler", source_format: "image", truncated: false },
    });
    const { props } = renderSheet();

    await waitFor(() =>
      expect(screen.getByTestId("photo-note.sheet").getAttribute("data-phase")).toBe("ready"),
    );
    fireEvent.click(screen.getByTestId("photo-note.cancel"));

    expect(props.onCancel).toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("cancels without committing", () => {
    readExtracted.mockReturnValue(new Promise(() => {}));
    const { props } = renderSheet();

    fireEvent.click(screen.getByTestId("photo-note.cancel"));
    expect(props.onCancel).toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("shows the photograph while the import is still running", () => {
    // The long part of the flow is the import (it runs OCR), so the sheet opens
    // on the picked FILE, before the vault has an id for it. The preview is the
    // whole reason: without it the user watches a dimmed toolbar button.
    readExtracted.mockReturnValue(new Promise(() => {}));
    renderSheet({ attachmentId: null, previewUrl: "blob:local/1234" });

    expect(screen.getByTestId("photo-note.sheet").getAttribute("data-phase")).toBe("importing");
    expect(screen.getByTestId("photo-note.importing")).toBeTruthy();
    const preview = screen.getByTestId<HTMLImageElement>("photo-note.preview");
    expect(preview.src).toContain("blob:local/1234");
    // Nothing to read yet, and nothing to commit yet.
    expect(readExtracted).not.toHaveBeenCalled();
    expect(screen.queryByTestId("photo-note.commit")).toBeNull();
    expect(screen.getByTestId("photo-note.cancel")).toBeTruthy();
  });

  it("moves from importing to reading when the id arrives", async () => {
    readExtracted.mockReturnValue(new Promise(() => {}));
    const { rerender, props } = renderSheet({ attachmentId: null, previewUrl: "blob:local/1" });

    rerender(<PhotoNoteSheet {...props} attachmentId={ID} previewUrl={null} />);

    await waitFor(() =>
      expect(screen.getByTestId("photo-note.sheet").getAttribute("data-phase")).toBe("reading"),
    );
    expect(readExtracted).toHaveBeenCalledWith(ID);
  });

  it("keeps the field after a failed read, because the commit still sends it", async () => {
    readExtracted.mockResolvedValue({ kind: "failed" });
    renderSheet();

    await waitFor(() =>
      expect(screen.getByTestId("photo-note.sheet").getAttribute("data-phase")).toBe("failed"),
    );
    // Hiding the field while `commit(text)` still carries its value would write
    // bytes the surface was not showing.
    expect(screen.getByTestId("photo-note.text")).toBeTruthy();
  });

  it("offers a reading that arrived after the user started typing", async () => {
    let resolve: (v: unknown) => void = () => {};
    readExtracted.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderSheet();

    fireEvent.change(screen.getByTestId("photo-note.text"), { target: { value: "benim satırım" } });
    resolve({
      kind: "text",
      entry: { text: "makinenin okuduğu metin", source_format: "image", truncated: false },
    });

    await waitFor(() => expect(screen.getByTestId("photo-note.add-reading")).toBeTruthy());
    // Neither forced in nor dropped: the typed text stands until the user says
    // yes, and the reading is one tap away.
    expect(screen.getByTestId<HTMLTextAreaElement>("photo-note.text").value).toBe("benim satırım");

    fireEvent.click(screen.getByTestId("photo-note.add-reading"));
    expect(screen.getByTestId<HTMLTextAreaElement>("photo-note.text").value).toBe(
      "benim satırım\n\nmakinenin okuduğu metin",
    );
  });

  it("says so when the reading was truncated", async () => {
    readExtracted.mockResolvedValue({
      kind: "text",
      entry: { text: "uzun", source_format: "image", truncated: true },
    });
    renderSheet();
    await waitFor(() => expect(screen.getByTestId("photo-note.truncated")).toBeTruthy());
  });

  it("does not re-probe when the OCR preference flips after the import", async () => {
    // The cache entry was written or skipped at import. A switch flipped in
    // Settings afterwards cannot change what this photo has, so a re-probe could
    // only report "no text" about a page nothing read.
    const { rerender, props } = renderSheet({ ocrEnabled: false });
    expect(screen.getByTestId("photo-note.ocr-off")).toBeTruthy();

    rerender(<PhotoNoteSheet {...props} ocrEnabled />);

    expect(readExtracted).not.toHaveBeenCalled();
    expect(screen.getByTestId("photo-note.ocr-off")).toBeTruthy();
  });

  it("renders keys that the English catalog actually carries", () => {
    // Reaches past the echo stub to the catalog, so a renamed or deleted key
    // fails here instead of shipping. Both surfaces: the sheet's own keys and the
    // format-bar entry the flow adds.
    const used = [
      "cancel",
      "commitNew",
      "commitNote",
      "defaultTitle",
      "destinationLabel",
      "imageOnly",
      "importing",
      "addReading",
      "readingArrived",
      "truncated",
      "discardFailed",
      "locked",
      "machineText",
      "newNote",
      "noText",
      "ocrOff",
      "ocrOffAction",
      "readFailed",
      "reading",
      "textLabel",
      "textPlaceholder",
      "thisNote",
    ];
    for (const key of used) {
      expect(
        (en as { photoNote: Record<string, string> }).photoNote[key],
        `photoNote.${key} is missing from locales/en/common.json`,
      ).toBeTruthy();
    }
    expect((en as never as { editor: { formatBar: Record<string, string> } }).editor.formatBar.photoToNote)
      .toBeTruthy();
  });
});
