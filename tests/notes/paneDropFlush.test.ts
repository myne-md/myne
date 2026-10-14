// collab-editor-bridge task 7, the live-channel drop must eagerly flush the
// pane's pending durable save.
//
// PaneView has no component-level harness in this suite (it needs the workspace,
// sidebar-state and prefs providers plus a live CodeMirror view), so this pins
// the wiring where it can be pinned: at the source, the same shape as
// paneReloadIdentityGuard.test.ts. The defect this guards is an ABSENT CALL
// rather than a wrong function: the drop listener cleared the awareness store
// and, before this, left a pending keystroke stranded if the stream never
// returned (the pane's `reloadOpenNote` early-returns while it has pending work,
// so the stale buffer would also survive the next durable pull).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "notes",
    "components",
    "PaneView.tsx",
  ),
  "utf8",
);

/** The body of the `sync://awareness-dropped` listener: from the `listen(` call
 *  to the grace-window timer it arms. */
function dropListener(): string {
  const start = SRC.indexOf('listen("sync://awareness-dropped"');
  expect(start, "the awareness-dropped listener must exist").toBeGreaterThan(-1);
  const end = SRC.indexOf("AWARENESS_GRACE_MS", start);
  expect(end, "…and end at the grace-window timer").toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("the live-channel drop listener", () => {
  it("eagerly flushes the pane's pending durable save", () => {
    expect(dropListener()).toContain("dropFlushRef.current()");
  });

  it("still starts the awareness grace window", () => {
    expect(dropListener()).toContain("awarenessOnDrop(");
  });
});

describe("the drop-flush wiring", () => {
  it("publishes the pane's flush to the drop ref", () => {
    expect(
      SRC.indexOf("dropFlushRef.current = flushAndReport;"),
      "the pane's flush must be published to dropFlushRef",
    ).toBeGreaterThan(-1);
  });

  it("declares the ref before the drop listener uses it", () => {
    const decl = SRC.indexOf("const dropFlushRef = useRef");
    const use = SRC.indexOf('listen("sync://awareness-dropped"');
    expect(decl, "dropFlushRef must be declared").toBeGreaterThan(-1);
    expect(decl).toBeLessThan(use);
  });
});
