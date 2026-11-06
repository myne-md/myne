// The sidebar's BACKGROUND context menu (right-click under the tree) is glyphed
// like the rest of the tree's menus (myne-md/myne#1020).
//
// The defect: three label-only rows ("New folder", "New note", "New drawing")
// while the SAME three actions, reached by right-clicking a folder row, each
// carried a glyph. Two menus for one vocabulary, drawn as if they belonged to two
// different products.
//
// Why this asserts over the source rather than over a render: the items are built
// inside `NoteList`, whose mount needs the whole sidebar's stores, IPC seams and
// drag context. Mounting that to look at three glyphs would be a fixture larger
// than the thing under test, and the same trade is already made one directory
// over (`tests/primitives/EmptyState.test.tsx` reads `NoteList.tsx` to hold the
// sidebar's first-run state to its shape). The registry half is covered by
// `tests/lib/icons.test.ts`; what this file holds is that a glyph is ASKED for,
// and that it is the same one the folder menu asks for.
//
// Verified by injection, twice: deleting one `icon:` line fails naming that item,
// and swapping `file-plus` for another registered name fails naming the
// disagreement with the folder menu.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(
  resolve(process.cwd(), "src/notes/components/NoteList.tsx"),
  "utf8",
);

/** The source of one `const <name>: ContextMenuItem[] = useMemo(` array literal,
 *  sliced at the `[` that opens it and the `]` that closes the array. */
function menuBlock(name: string): string {
  const at = SOURCE.indexOf(`const ${name}: ContextMenuItem[]`);
  expect(at, `no ${name} array in NoteList.tsx`).toBeGreaterThan(-1);
  // The array opens at the end of a line (`() => [` or `return [`). The guard
  // clause above it ends in `return [];`, whose brackets sit mid-line, and taking
  // the first bracket after the arrow read THAT one: an empty two-character block
  // that made every lookup below answer `undefined`.
  let open = -1;
  for (let at2 = SOURCE.indexOf("=>", at); at2 >= 0 && at2 < SOURCE.length; at2 += 1) {
    if (SOURCE[at2] !== "[") continue;
    if (SOURCE[at2 + 1] !== "\n") continue;
    open = at2;
    break;
  }
  expect(open, `${name} has no array literal`).toBeGreaterThan(-1);
  // Walk to the matching bracket rather than looking for a formatted close: the
  // two arrays in this file are indented differently (one is a `return`, one is a
  // bare literal), and a newline-sensitive marker silently picked the wrong one.
  let depth = 0;
  let close = -1;
  for (let i = open; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  expect(close, `${name} has no array close`).toBeGreaterThan(open);
  return SOURCE.slice(open, close);
}

/** The `icon:` value declared for one item id, or `undefined` when the item
 *  carries none. The window stops at the next `id:` so a missing glyph cannot read
 *  its neighbour's. */
function iconOf(block: string, id: string): string | undefined {
  const at = block.indexOf(`id: "${id}"`);
  if (at < 0) return undefined;
  const next = block.indexOf('id: "', at + 1);
  const window = block.slice(at, next < 0 ? undefined : next);
  return /icon: "([a-z0-9-]+)"/.exec(window)?.[1];
}

describe("the sidebar's background menu is glyphed", () => {
  it("gives each of its three rows a glyph", () => {
    const block = menuBlock("bgMenuItems");
    for (const [id, glyph] of [
      ["new-folder", "folder-plus"],
      ["new-note", "file-plus"],
      ["new-drawing", "image-plus"],
    ] as const) {
      expect(iconOf(block, id), `${id} renders a label with no glyph`).toBe(glyph);
    }
  });

  it("uses the folder menu's own glyph for the same action", () => {
    // The reason the missing glyphs were a defect rather than a taste call: the
    // same action has ONE picture in this tree, and these three actions are
    // already drawn by the folder menu. A different name here would mean the eye
    // has to learn the same verb twice.
    const folder = menuBlock("folderMenuItems");
    expect(iconOf(folder, "new-note"), "the folder menu renamed its own glyph").toBe(
      "file-plus",
    );
    expect(iconOf(folder, "new-drawing"), "the folder menu renamed its own glyph").toBe(
      "image-plus",
    );
    expect(iconOf(folder, "new-subfolder"), "the folder menu renamed its own glyph").toBe(
      "folder-plus",
    );
  });

  it("groups them, so the menu's dividers have something to key off", () => {
    // `ContextMenu` draws a divider between adjacent items whose `group` differs.
    // With no group at all the three rows are one undivided run, which is what
    // made them read as a paragraph of verbs.
    const block = menuBlock("bgMenuItems");
    expect(block.match(/group: "create"/g) ?? []).toHaveLength(3);
  });
});
