// @vitest-environment jsdom
//
// The agent tab is given the vault's folders (myne-md/myne#771).
//
// `PaneView` mounted `<AgentPane>` without `folders`. The prop is optional, so
// nothing complained — and in the agent tab there usually IS no open note,
// because the tab is the focused pane. So the composer's scope picker held
// exactly one entry, "This note", which resolved to `null`; the host refuses a
// run with no scope; Send sat disabled; and the alternative the picker exists
// to offer was not in the list. A dead end reachable by opening the tab and
// typing, invisible to every gate: the pane renders, the picker renders, the
// button renders.
//
// A source assertion rather than a render one, and deliberately: mounting
// `PaneView` means mounting the pane tree, the editor and their IPC. What is
// being checked is one wiring — that the prop is passed at all — and the
// failure was its absence, which is exactly what a source check can see.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC: string = readFileSync(
  resolve(process.cwd(), "src/notes/components/PaneView.tsx"),
  "utf8",
);

describe("PaneView tells the sidebar an apply wrote something", () => {
  // **The handler whose absence was a user report** (myne-md/myne#894: "I
  // approved the move and the sidebar did not follow it"). It arrived as two
  // props at a call site, which is the shape nothing asserts: the pane rendered
  // correctly without them, the apply wrote through the backend, and a moved
  // note sat under its OLD folder. Round 1 of the review found the fix pinned by
  // nothing (emptying its body left every suite green), so the two props and the
  // two calls they carry are asserted here, in the same source-check style as the
  // `folders` case above and for the same reason.

  it("passes onNotesWritten and onRunUndone to AgentPane", () => {
    const at = SRC.indexOf("<AgentPane");
    expect(at, "the agent pane is not mounted here any more").toBeGreaterThan(-1);
    const el = SRC.slice(at, at + 1500);
    expect(el, "AgentPane is mounted without onNotesWritten").toContain(
      "onNotesWritten=",
    );
    expect(el, "AgentPane is mounted without onRunUndone").toContain(
      "onRunUndone=",
    );
  });

  it("reloads the open pane and re-reads every note the apply changed", () => {
    const at = SRC.indexOf("const agentNotesWritten = useCallback(");
    expect(at, "the handler is gone").toBeGreaterThan(-1);
    const body = SRC.slice(at, at + 400);
    expect(body, "the open pane is never reloaded").toContain(
      "ctx.reloadOpenNote()",
    );
    expect(body, "no note's sidebar slice is re-read").toContain("ctx.refreshOne(");
  });
});

describe("PaneView hands the agent pane a scope to offer", () => {
  it("passes folders to AgentPane", () => {
    const at = SRC.indexOf("<AgentPane");
    expect(at, "the agent pane is not mounted here any more").toBeGreaterThan(-1);
    const el = SRC.slice(at, SRC.indexOf("/>", at));
    expect(el, "AgentPane is mounted without folders").toContain("folders=");
  });

  it("derives them from the shared folder derivation, not notes alone", () => {
    // **The notes-only derivation was the defect** (myne-md/myne#913, review
    // round five): it offered no deliberately created empty folder, no parent
    // that holds no note directly, and a folder that survives only on an archived
    // note, while the right panel offered all three from `listFolderPaths`. The
    // same control then answered differently in the two mounts.
    const at = SRC.indexOf("const [agentFolders, setAgentFolders]");
    expect(at, "the scope folders are gone").toBeGreaterThan(-1);
    const body = SRC.slice(at, at + 1600);
    expect(body, "the shared derivation is not used").toContain("listFolderPaths()");
    // Keyed on the folder SET rather than on `notes` (which changes identity on
    // every save) and on the prefs that change with no note write at all.
    expect(body).toContain("folderSignature");
    expect(body).toContain("deliberateKey");
    expect(body).toContain("archivedKey");
  });
});
