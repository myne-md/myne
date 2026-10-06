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

describe("PaneView hands the agent pane a scope to offer", () => {
  it("passes folders to AgentPane", () => {
    const at = SRC.indexOf("<AgentPane");
    expect(at, "the agent pane is not mounted here any more").toBeGreaterThan(-1);
    const el = SRC.slice(at, SRC.indexOf("/>", at));
    expect(el, "AgentPane is mounted without folders").toContain("folders=");
  });

  it("derives them from the notes the pane already has", () => {
    // Not a second IPC read: `useLiveResolverNotes` is already in this
    // component for wikilink resolution, and every folder that holds a note is
    // what the picker needs.
    expect(SRC).toContain("const agentFolders = useMemo(");
    const at = SRC.indexOf("const agentFolders = useMemo(");
    const body = SRC.slice(at, at + 400);
    expect(body).toContain("notes.map");
    // Memoized, because `notes` changes identity on every save and this sorts.
    expect(body).toContain("[notes]");
  });
});
