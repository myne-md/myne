// Drag-drop import suite (MYND-629).
//
// Pins the two drop surfaces added by the feature through the production
// bundle: markdown dropped on a sidebar folder row becomes notes FILED IN THAT
// FOLDER, and files dropped on the attachments pane land in the catalog.
//
// **Why the drop is synthesized in-page.** WebDriver cannot originate an OS
// drag: there is no actor for "the file manager", and the Actions API only
// moves the pointer, it cannot attach a `DataTransfer` payload. Native OS
// drag-drop is also deliberately OFF (`dragDropEnabled: false` in
// `tauri.conf.json`) precisely so the WebView receives an ordinary HTML5
// `DataTransfer` — which means the thing under test IS the DOM event, and
// constructing it in the page exercises the real handler on the real element
// with real `File` objects. What is NOT covered is the OS→WebView handoff
// itself, which no driver can reach; that stays manual-verify.
//
// The oracle is disk, not DOM: `note_list` + `note_read` for the folder case
// and `catalog_list` for the attachment case, read back through page-seat IPC.
// A toast proves a message rendered; only the vault proves an import happened.
//
// KDF: weak generator fixture (SYNC-9 — unlock reads params from vault.meta).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  pageSeatInvoke,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

/** W3C key codepoint (Enter). Written as an escape, never as the literal
 *  character — it is invisible in an editor and gets lost when a line is
 *  copied between files. */
const ENTER = "\uE007";

/**
 * Create a folder through the sidebar "New folder" CTA and its inline input —
 * the same flow `folder-notes.e2e.ts` uses.
 *
 * **Why not seed a `folder:` note over IPC.** A folder is derived from notes'
 * frontmatter, so seeding one that way looks like it should work — but a
 * page-seat `note_create` writes past the UI, and nothing re-derives the tree
 * afterwards, so `notes.folder-row` never materializes and the scenario times
 * out waiting for a row that only a reload would produce.
 *
 * Lowercase-only name: WebKitWebDriver's Send Keys drops the shift modifier, so
 * an uppercase char would arrive lowercased (a driver limitation, not a product
 * one) and the `data-folder-path` assertion would miss.
 */
async function createFolder(s: Session, name: string): Promise<void> {
  await (await s.byTestId("notes.new-folder")).click();
  await (await s.byTestId("notes.new-folder-input")).sendKeys(`${name}${ENTER}`);
  await s.byTestId("notes.folder-row");
}

/**
 * Dispatch a real `drop` (preceded by `dragover`, which the handlers gate on)
 * carrying `files` at the element matching `selector`.
 *
 * `DataTransfer` is constructed in-page: `DataTransferItemList.add` is the only
 * way to attach a `File` to a synthetic event, and the resulting object is
 * indistinguishable to the handler from one the OS produced.
 */
async function dropFiles(
  s: Session,
  selector: string,
  files: Array<{ name: string; text: string; type: string }>,
): Promise<void> {
  await s.execute(
    `
    const [selector, files] = arguments;
    const el = document.querySelector(selector);
    if (el === null) throw new Error("drop target not found: " + selector);
    const dt = new DataTransfer();
    for (const f of files) {
      dt.items.add(new File([f.text], f.name, { type: f.type }));
    }
    // The handlers only claim a drop whose dragover already advertised Files;
    // firing both mirrors the browser's own sequence.
    el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    `,
    [selector, files],
  );
}

/** Note bodies on disk, read back through page-seat IPC. */
async function noteBodies(s: Session): Promise<string[]> {
  const list = await pageSeatInvoke(s, "plugin:notes|note_list", {}, IPC_TIMEOUT);
  expect(list.err, "note_list should succeed").toBeUndefined();
  const ids = list.ok as string[];
  const out: string[] = [];
  for (const id of ids) {
    const r = await pageSeatInvoke(s, "plugin:notes|note_read", { id }, IPC_TIMEOUT);
    expect(r.err, "note_read should succeed").toBeUndefined();
    out.push(r.ok as string);
  }
  return out;
}

describeE2E("drag-drop import (MYND-629)", () => {
  it("di1 — markdown dropped on a folder row is filed in that folder", async () => {
    let seeded: SeededVault;
    await scenario(
      "di1-drop-markdown-on-folder",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // The drop target has to exist as a real row, so build it the way a user
        // does. Seeding a `folder:` note over IPC does NOT work — see
        // `createFolder`'s doc for why.
        const FOLDER = "research";
        await createFolder(s, FOLDER);

        const row = testIdSelector("notes.folder-row");

        await dropFiles(s, `${row}[data-folder-path="${FOLDER}/"]`, [
          { name: "dropped-one.md", text: "# One\n\nbody one\n", type: "text/markdown" },
          { name: "dropped-two.md", text: "# Two\n\nbody two\n", type: "text/markdown" },
          // A non-markdown sibling must be skipped, not imported as a note.
          { name: "photo.png", text: "not markdown", type: "image/png" },
        ]);

        // Disk oracle: exactly the two dropped notes, both carrying the
        // destination folder and their filename as the title, and nothing
        // created for the PNG. The vault started empty and the folder was made
        // through the sidebar, so no anchor note inflates the count.
        await s.waitUntil(async () => (await noteBodies(s)).length === 2, {
          timeoutMs: 15_000,
          label: "two dropped notes to land on disk",
        });
        const bodies = await noteBodies(s);
        const one = bodies.find((b) => b.includes("body one"));
        const two = bodies.find((b) => b.includes("body two"));
        expect(one, "dropped-one.md should have been imported").toBeDefined();
        expect(two, "dropped-two.md should have been imported").toBeDefined();
        expect(one).toContain(`folder: ${FOLDER}/`);
        expect(one).toContain("title: dropped-one");
        expect(two).toContain(`folder: ${FOLDER}/`);
        expect(bodies.some((b) => b.includes("photo")), "the PNG must not become a note").toBe(
          false,
        );
      },
    );
  });

  it("di2 — files dropped on the attachments pane enter the catalog", async () => {
    let seeded: SeededVault;
    await scenario(
      "di2-drop-file-on-attachments",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // The attachments library is a CENTER VIEW, not always-mounted chrome:
        // `Editor.tsx` renders it only while `centerView === "attachments"`, so
        // waiting for its testid straight after unlock waits for an element that
        // will never appear. The command palette is the entry path the other two
        // attachment suites use.
        await runPaletteAction(s, "attachments.open", "attach");

        const pane = testIdSelector("attachments.library");
        await s.waitForElement(pane);

        await dropFiles(s, pane, [
          { name: "notes.txt", text: "plain attachment bytes", type: "text/plain" },
        ]);

        await s.waitUntil(
          async () => {
            const r = await pageSeatInvoke(s, "plugin:attachments|catalog_list", {}, IPC_TIMEOUT);
            const rows = (r.ok ?? []) as Array<{ filename: string }>;
            return rows.some((x) => x.filename === "notes.txt");
          },
          { timeoutMs: 15_000, label: "dropped file to enter the catalog" },
        );
      },
    );
  });
});
