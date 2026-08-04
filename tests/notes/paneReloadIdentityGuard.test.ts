// myne#334 — the out-of-band reload continuation must check note identity.
//
// The effect keys on the reload nonce, so its `cancelled` flag only covers a
// re-run of ITSELF. A plain note switch does not re-run it — so a `noteRead`
// started for note A could resolve after the pane had moved to B, and both of
// the guards that follow the await (cancelled, hasPendingWork) passed.
//
// `acceptReloadedBody(bodyA)` then re-baselined B's autosave to A's body while
// the buffer still held B's: the compare-and-swap refuses the content swap, and
// the forced re-render carries an unchanged body, so the body-change effect
// never re-baselines either. From there `hasPendingWork()` reported true
// forever, so the pane silently ignored every later out-of-band reload — and the
// next keystroke in B fired a save whose expected base was `sha256(bodyA)`,
// which the host rejects against B's own disk bytes, minting a keep-both
// conflict copy for a note nothing ever conflicted on and relocating the user's
// in-progress edit into it.
//
// `PaneView` has no component-level harness in this suite — it needs the
// workspace, sidebar-state and prefs providers plus a live CodeMirror view. So
// this pins the guard where it can be pinned: at the source. It is the same
// shape as the wiring check for myne#336, and for the same reason — the defect
// was an absent line, not a wrong function.

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

/** The body of the out-of-band reload continuation: from the `before` snapshot
 *  that identifies this effect to the compare-and-swap that ends it.
 *
 *  `noteRead(activeId)` is NOT the anchor — the note-switch effect above awaits
 *  the same call, and slicing from there would span both, putting the switch
 *  effect's own `acceptReloadedBody` at a lower index than this effect's guard
 *  and passing the ordering assertion for the wrong reason. That effect needs no
 *  identity guard: it keys on `activeId`, so its `cancelled` flag already covers
 *  a switch. */
function reloadContinuation(): string {
  const start = SRC.indexOf("const before = contentRef.current;");
  expect(start, "the out-of-band reload continuation must exist").toBeGreaterThan(-1);
  const end = SRC.indexOf("setContent((prev) => (prev === before ? body : prev));", start);
  expect(end, "…and end at its compare-and-swap").toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("the out-of-band reload continuation", () => {
  it("re-checks the pane's note identity after the read resolves", () => {
    expect(reloadContinuation()).toContain("activeIdRef.current !== activeId");
  });

  it("does so BEFORE re-baselining the autosave", () => {
    // The CALL, not the token: the comment above the guard names
    // `acceptReloadedBody(bodyA)` when explaining the failure, and a bare-token
    // search would match that instead and pass for the wrong reason.
    const body = reloadContinuation();
    const call = body.indexOf("autosaveRef.current.acceptReloadedBody(");
    expect(call, "the continuation must re-baseline autosave").toBeGreaterThan(-1);
    const guard = body.indexOf("activeIdRef.current !== activeId");
    // Assert presence separately: a missing guard indexes to -1, which is less
    // than any call site, so an ordering check alone passes on the bug.
    expect(guard, "the identity guard must be present").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(call);
  });

  it("still re-checks dirtiness after the read too", () => {
    // The sibling guard, which the identity check must not displace: typing may
    // have started while the read was in flight.
    expect(reloadContinuation()).toContain("hasPendingWork()");
  });
});
