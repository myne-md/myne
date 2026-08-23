// @vitest-environment jsdom
//
// The attachment-transfer registry has no production writer — myne-md/myne#557,
// the `attachments.sync-transfers` bullet.
//
// The roster row asked a person to watch attachment transfer progress during a
// sync, once a release. There is nothing to watch: `useAttachmentTransfers.ts`
// says so in its own header (⚠️ MOCK BACKEND, pending MYND-424 — "today it is
// empty unless seeded"), and the only writer it has, `__seedMockTransfers`, is
// documented "tests + the design preview only" and today is called by nothing at
// all. So the honest answer to "does the progress UI report transfers correctly"
// is that it reports none, on every platform, deterministically — which is a
// static fact, not an observation.
//
// Pinning it costs one test and buys two things:
//
//  * the manual walk stops being scheduled for a surface that cannot move, and
//  * **the day a real writer lands, this fails by name**, which is the signal
//    that the roster row has to be re-derived rather than silently reinstated.
//    That is the whole value: a permanently-true assertion would be dead weight,
//    and this one is deliberately a tripwire on the MYND-424 landing.
//
// Same shape as `scripts/check-unwired.mjs` one layer in: that guard asks whether
// a MODULE has a production importer; this asks whether one EXPORT inside an
// imported module has a production caller.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();

/** The module that defines the registry — its own writer does not count. */
const DEFINING_MODULE = "src/hooks/useAttachmentTransfers.ts";

/** The shared client trees a production writer could live in. */
const PRODUCTION_ROOTS = ["src", "web/src", "mobile/src", "editor/src", "dialect/src"];

function sourcesUnder(root: string): string[] {
  const abs = join(REPO_ROOT, root);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) out.push(relative(REPO_ROOT, p));
    }
  };
  walk(abs);
  return out;
}

const ALL_PRODUCTION_SOURCES = PRODUCTION_ROOTS.flatMap(sourcesUnder);

describe("the registry's only writer has no production caller", () => {
  it("scans a non-empty production tree", () => {
    // A walk that found nothing would report ok forever.
    expect(ALL_PRODUCTION_SOURCES.length).toBeGreaterThan(200);
    expect(ALL_PRODUCTION_SOURCES).toContain(DEFINING_MODULE);
  });

  it("no production module calls __seedMockTransfers", () => {
    const callers = ALL_PRODUCTION_SOURCES.filter((rel) => {
      if (rel === DEFINING_MODULE) return false;
      return readFileSync(join(REPO_ROOT, rel), "utf8").includes("__seedMockTransfers");
    });
    expect(
      callers,
      "a production caller of __seedMockTransfers appeared. If that is the " +
        "MYND-424 sync engine finally writing to the registry, the attachment " +
        "transfer surface has become observable and its manual roster row has " +
        "to be re-derived rather than left retired. If it is anything else, it " +
        "is a mock seeded into production.",
    ).toEqual([]);
  });

  it("the writer is still marked as the tests-and-preview-only escape hatch", () => {
    // If the doc comment loses that mark, the export stops reading as a mock
    // hatch and the next author has no reason not to call it.
    const src = readFileSync(join(REPO_ROOT, DEFINING_MODULE), "utf8");
    expect(src).toContain("__seedMockTransfers");
    expect(
      /tests \+ the design preview only/.test(src),
      "the writer's doc comment no longer says it is a test-only hatch",
    ).toBe(true);
    // …and the module still says the backend is a mock. When this line goes,
    // the assertion above stops being the right question.
    expect(src).toContain("MOCK BACKEND");
  });
});

describe("what the progress UI actually shows today", () => {
  afterEach(cleanup);

  it("reports its empty state with the registry unseeded", async () => {
    // The behavioural half. The static scan proves nothing writes the registry;
    // this proves what the user sees as a result, which is what the roster row
    // was asking a person to look at.
    const { AttachmentSyncProgress } = await import(
      "../../src/components/attachments/AttachmentSyncProgress"
    );
    render(<AttachmentSyncProgress />);
    expect(screen.getByTestId("attachments.sync-progress-empty")).toBeTruthy();
    expect(screen.queryByTestId("attachments.sync-progress-row")).toBeNull();
  });

  it("renders rows once the registry IS seeded, so the empty state is not vacuous", async () => {
    // Without this the test above would pass on a component that renders
    // nothing under any conditions.
    const mod = await import("../../src/hooks/useAttachmentTransfers");
    const { AttachmentSyncProgress } = await import(
      "../../src/components/attachments/AttachmentSyncProgress"
    );
    mod.__seedMockTransfers([
      {
        id: "a1b2",
        name: "diagram.png",
        direction: "upload",
        transferred: 512,
        total: 2048,
        status: "active",
      },
    ]);
    try {
      render(<AttachmentSyncProgress />);
      expect(screen.getAllByTestId("attachments.sync-progress-row").length).toBe(1);
      expect(screen.queryByTestId("attachments.sync-progress-empty")).toBeNull();
    } finally {
      // Module-scope registry: leaving it seeded would leak into every later
      // test in this worker.
      mod.__seedMockTransfers([]);
    }
  });

  it("hides itself entirely when asked to, with nothing in flight", async () => {
    const { AttachmentSyncProgress } = await import(
      "../../src/components/attachments/AttachmentSyncProgress"
    );
    const { container } = render(<AttachmentSyncProgress hideWhenEmpty />);
    expect(container.textContent).toBe("");
  });
});

// A guard that has never failed is a guard nobody has tested, so this file was
// verified by injecting a production caller of `__seedMockTransfers` into
// `src/components/attachments/AttachmentSyncProgress.tsx`, watching the second
// test name it, and restoring.
