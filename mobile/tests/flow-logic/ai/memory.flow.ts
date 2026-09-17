// Flow-logic: the phone's agent-memory surfaces (myne-md/myne#697, task 9).
//
// Headless Chromium + mock IPC. NOT end-to-end: the agent never runs here, so
// what this file drives is the management surfaces against a stateful memory
// mock: the settings section (list, edit, delete-with-confirm, clear-all
// with confirm, personality save) and the AI-flow sheet (open, list, delete).
// The turn-end marker is covered end to end (`e2e/memory.e2e.ts` mem1
// asserts the marker text after a stub run that wrote one entry) and by the
// `AiChatFlow.test.tsx` render assertion (a seeded turn with memoryUpdated>0
// renders `ai.memory-updated`); the write path itself is Rust-covered in
// `myne-core`.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const ROWS = [
  { id: "m1", created_at: 100, updated_at: 100, version: 1 },
  { id: "m2", created_at: 200, updated_at: 300, version: 2 },
];

const TEXTS: Record<string, string> = {
  m1: "Prefers tea over coffee.",
  m2: "Works in Berlin, UTC+1.",
};

async function openMemorySection(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByTestId("settings.category-ai").click();
  await expect(page.getByTestId("settings.memory-section")).toBeVisible();
}

test.describe("phone memory settings", () => {
  test("lists the roster newest-first with entry text", async ({ page }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      memory: { rows: ROWS, texts: TEXTS, directives: ["Keep answers short."] },
    });
    await openMemorySection(page);

    const rows = page.getByTestId("settings.memory.row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Works in Berlin");
    await expect(rows.nth(1)).toContainText("Prefers tea");
    await expect(page.getByTestId("settings.memory.personality-input")).toHaveValue(
      "Keep answers short.",
    );
  });

  test("edits through the binding and refreshes the row", async ({ page }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      memory: { rows: ROWS, texts: TEXTS, directives: [] },
    });
    await openMemorySection(page);

    await page.getByTestId("settings.memory.row").nth(1).getByTestId("settings.memory.edit").click();
    await page.getByTestId("settings.memory.edit-input").fill("Prefers espresso.");
    await page.getByTestId("settings.memory.save").click();

    // The save bumps updated_at, so the edited row sorts newest-first: it is
    // now row zero, and the refresh (not the stale position) is the claim.
    await expect(
      page.getByTestId("settings.memory.row").nth(0),
    ).toContainText("Prefers espresso.");
    const writes = await page.evaluate(
      () => (window as unknown as { __memoryCalls?: Array<{ cmd: string }> }).__memoryCalls ?? [],
    );
    expect(writes.map((w) => w.cmd)).toContain("memory_write");
  });

  test("deletes with a two-tap confirm and drops the row", async ({ page }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      memory: { rows: ROWS, texts: TEXTS, directives: [] },
    });
    await openMemorySection(page);

    await page.getByTestId("settings.memory.row").nth(0).getByTestId("settings.memory.delete").click();
    // First tap arms, it does not delete: the row is still there.
    await expect(page.getByTestId("settings.memory.row")).toHaveCount(2);
    await page.getByTestId("settings.memory.delete-confirm").click();
    await expect(page.getByTestId("settings.memory.row")).toHaveCount(1);
    await expect(page.getByTestId("settings.memory.row").nth(0)).toContainText("Prefers tea");
  });

  test("clear-all confirms stacked with the safe answer last, then empties", async ({
    page,
  }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      memory: { rows: ROWS, texts: TEXTS, directives: [] },
    });
    await openMemorySection(page);

    await page.getByTestId("settings.memory.clear-all").click();
    await expect(page.getByTestId("settings.memory.row")).toHaveCount(2);
    await page.getByTestId("settings.memory.clear-confirm").click();
    await expect(page.getByTestId("settings.memory.empty")).toBeVisible();
  });

  test("saves the personality block through the binding", async ({ page }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      memory: { rows: [], texts: {}, directives: [] },
    });
    await openMemorySection(page);

    await page.getByTestId("settings.memory.personality-input").fill("Answer in haiku.");
    await page.getByTestId("settings.memory.personality-save").click();

    const writes = await page.evaluate(
      () =>
        (window as unknown as { __memoryCalls?: Array<{ cmd: string; args: unknown }> })
          .__memoryCalls ?? [],
    );
    const save = writes.find((w) => w.cmd === "personality_write");
    expect(save).toBeDefined();
    expect(save?.args).toMatchObject({
      directives: [{ text: "Answer in haiku." }],
    });
  });
});

test.describe("phone memory sheet", () => {
  test("opens from the AI flow and deletes a row", async ({ page }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      memory: { rows: ROWS, texts: TEXTS, directives: [] },
    });
    await page.goto("/");
    await page.getByTestId("workspace.tab-chat").click();
    await page.getByTestId("ai.memory-button").click();

    await expect(page.getByTestId("ai.memory-sheet")).toBeVisible();
    const rows = page.getByTestId("ai.memory-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Works in Berlin");

    await rows.nth(0).getByTestId("ai.memory-delete").click();
    await page.getByTestId("ai.memory-delete-confirm").click();
    await expect(page.getByTestId("ai.memory-row")).toHaveCount(1);
  });
});
