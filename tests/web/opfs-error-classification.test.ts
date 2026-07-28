// Every storage-pressure exception has a DECIDED kind (phase3-web-client task 91).
//
// # Why the default arm is the bug
//
// `IoFailureKind` is a closed four-variant enum that crosses the Worker
// boundary and is matched exhaustively on the Rust side. The OPFS backend is the
// only place a browser's `DOMException` becomes one of those four — so an
// exception that reaches the `default` arm has not been *classified*, it has
// merely landed somewhere, and it arrives at the command layer as an untyped
// `Other`.
//
// That matters most for exactly the one the user meets: a `QuotaExceededError`
// on a note save is "the medium ran out of writable bytes", whose remedy (free
// space and retry) is what `NoSpace` means — and as `Other` it is
// indistinguishable from a bug.
//
// So this file enumerates the names a browser actually throws under storage
// pressure and asserts each one's kind by value. The list is the point: a new
// name added to the switch without a test here is a name nobody decided about.

import { describe, expect, it } from "vitest";
import { IO_KIND, classify } from "../../web/src/worker/opfs";

/** A `DOMException`-shaped throwable. jsdom has the real constructor, but the
 *  mapping keys off `.name` alone and a literal keeps the test honest about
 *  that — it is what the browser hands us, not a class we control. */
function domException(name: string): unknown {
  return { name, message: `${name} (test)` };
}

describe("OPFS exception classification", () => {
  it("maps a quota exhaustion to NoSpace, not to the catch-all", () => {
    // The load-bearing one. `NoSpace` is documented as "the underlying medium
    // ran out of writable bytes — the frontend CTA is identical (free up space
    // and retry)", which is exactly what a browser storage quota means.
    expect(classify(domException("QuotaExceededError")).kind).toBe(IO_KIND.noSpace);
  });

  it("maps a locked file to PermissionDenied, which means STOP", () => {
    // `NoModificationAllowedError` is a file already held by another sync access
    // handle. `permissionDenied` rather than `other` because the caller's correct
    // response is to stop rather than retry in a loop, and `other` invites the
    // loop.
    expect(classify(domException("NoModificationAllowedError")).kind).toBe(
      IO_KIND.permissionDenied,
    );
  });

  it("maps a stale handle to Other, which means RE-ACQUIRE", () => {
    // The mirror of the case above, and the reason the two are not merged: an
    // `InvalidStateError` handle should be re-acquired, which is a retry.
    // Classifying it `permissionDenied` would tell the caller to give up on a
    // condition one fresh handle fixes.
    expect(classify(domException("InvalidStateError")).kind).toBe(IO_KIND.other);
  });

  it("gives every named storage exception a kind from the closed set", () => {
    const NAMES = [
      "NotFoundError",
      "QuotaExceededError",
      "NotAllowedError",
      "SecurityError",
      "NoModificationAllowedError",
      "TypeMismatchError",
      "InvalidStateError",
    ];
    const valid = new Set(Object.values(IO_KIND));
    for (const name of NAMES) {
      const kind = classify(domException(name)).kind;
      expect(valid.has(kind), `${name} produced a kind outside IoFailureKind`).toBe(true);
    }
  });

  it("names each of them EXPLICITLY rather than leaning on the default", () => {
    // The property the test above cannot state: the catch-all also produces a
    // valid kind, so "it is in the set" passes either way. Read the source and
    // require a `case` for each — because a name that only works via `default`
    // is one nobody made a decision about, and the decision is the artefact.
    const src = readSource();
    for (const name of [
      "QuotaExceededError",
      "NoModificationAllowedError",
      "InvalidStateError",
    ]) {
      expect(src, `${name} must have its own case arm, not fall to default`).toContain(
        `case "${name}":`,
      );
    }
  });

  it("still reports an unrecognised exception rather than throwing", () => {
    // The default arm is not deleted — it is the answer for something a browser
    // invents later, and a classifier that threw would turn an unknown storage
    // fault into an unhandled rejection crossing the Worker boundary.
    expect(classify(domException("SomeFutureError")).kind).toBe(IO_KIND.other);
    expect(classify("not an exception at all").kind).toBe(IO_KIND.other);
  });
});

function readSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  return readFileSync(join(process.cwd(), "web", "src", "worker", "opfs.ts"), "utf8");
}
