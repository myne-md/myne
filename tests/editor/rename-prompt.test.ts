// @vitest-environment jsdom
//
// In-WebView rename prompt modal (MYND-173) — the `window.prompt` replacement
// for the editor file-card Rename (Tauri no-ops `window.prompt`). jsdom DOM test.

import { afterEach, describe, expect, it } from "vitest";
import { promptForName } from "../../src/editor/attachments/renamePrompt";

afterEach(() => {
  document.body.innerHTML = "";
});

function input(): HTMLInputElement {
  return document.querySelector(
    '[data-testid="attachment-rename.input"]',
  ) as HTMLInputElement;
}

describe("promptForName", () => {
  it("seeds the input with the current value and focuses it", () => {
    void promptForName("old.docx");
    expect(input().value).toBe("old.docx");
  });

  it("resolves with the entered value on Enter", async () => {
    const p = promptForName("old.docx");
    input().value = "new.docx";
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await expect(p).resolves.toBe("new.docx");
  });

  it("resolves with the entered value via the Rename button", async () => {
    const p = promptForName("old.docx");
    input().value = "renamed.docx";
    (
      document.querySelector(
        '[data-testid="attachment-rename.confirm"]',
      ) as HTMLButtonElement
    ).click();
    await expect(p).resolves.toBe("renamed.docx");
  });

  it("resolves null on Cancel", async () => {
    const p = promptForName("old.docx");
    (
      document.querySelector(
        '[data-testid="attachment-rename.cancel"]',
      ) as HTMLButtonElement
    ).click();
    await expect(p).resolves.toBeNull();
  });

  it("resolves null on Escape", async () => {
    const p = promptForName("old.docx");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p).resolves.toBeNull();
  });

  it("removes the modal from the DOM after settling", async () => {
    const p = promptForName("old.docx");
    expect(input()).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await p;
    expect(input()).toBeNull();
  });
});
