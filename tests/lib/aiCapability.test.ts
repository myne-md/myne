import { beforeEach, describe, expect, it, vi } from "vitest";

// Type-only, so it is erased at runtime and does not defeat the `vi.resetModules()`
// + dynamic-import seam below.
import type { AiCapabilityReport } from "../../src/lib/ai-capability";

const invoke = vi.fn();
vi.mock("../../src/platform/core", () => ({ invoke }));

async function seam() {
  return await import("../../src/lib/ai-capability");
}

// The AI capability report's wire contract (ai-provider-seam task 8, SYNC-5).
//
// The property worth testing is not "it parses JSON" — it is that a REJECTED
// invoke is read as "the AI feature is not compiled into this build" rather
// than propagating as an error. That conflation is correct in exactly this one
// place (a missing command can mean nothing else here), and every other reason
// a feature is unavailable must arrive as a named cause instead. A regression
// in either direction is silent: an error would blank the panel, and a
// swallowed cause would show "unavailable" for a backend that merely timed out.

const FULL = {
  compiled: true,
  backend_id: "candle",
  backend_class: "in_process_local",
  generation: { available: true, cause: null },
  embedding: { available: false, cause: "no_model" },
  transcription: { available: true, cause: null },
  auto_tag: { available: false, cause: "remote_barred" },
};

describe("aiCapabilityReport", () => {
  beforeEach(() => {
    vi.resetModules();
    invoke.mockReset();
  });

  it("maps the wire shape, preserving each feature's named cause", async () => {
    invoke.mockResolvedValue(FULL);
    const { aiCapabilityReport } = await seam();
    const report = await aiCapabilityReport();

    expect(invoke).toHaveBeenCalledWith(
      "plugin:local-inference|ai_capability_report",
    );
    expect(report.compiled).toBe(true);
    expect(report.backendClass).toBe("in_process_local");
    expect(report.generation).toEqual({ available: true, cause: null });
    expect(report.embedding).toEqual({ available: false, cause: "no_model" });
    // snake_case on the wire, camelCase on this side.
    expect(report.autoTag).toEqual({
      available: false,
      cause: "remote_barred",
    });
  });

  it("reads a rejected invoke as 'not compiled', without throwing", async () => {
    invoke.mockRejectedValue(new Error("command not found"));
    const { aiCapabilityReport, UNCOMPILED_REPORT } = await seam();
    await expect(aiCapabilityReport()).resolves.toEqual(UNCOMPILED_REPORT);
  });

  it("gives an uncompiled build a null cause, not an invented one", async () => {
    invoke.mockRejectedValue(new Error("nope"));
    const { aiCapabilityReport } = await seam();
    const report = await aiCapabilityReport();
    // Nothing refused the request — there was nothing to refuse it. Inventing
    // a cause here would put a fake EngineError kind in front of the user.
    for (const f of [
      report.generation,
      report.embedding,
      report.transcription,
      report.autoTag,
    ]) {
      expect(f).toEqual({ available: false, cause: null });
    }
    expect(report.backendId).toBeNull();
  });

  it("does not report a feature available on a malformed answer", async () => {
    // Fail closed: a truthy-but-wrong payload must not read as "available".
    invoke.mockResolvedValue({ compiled: "yes", generation: { available: 1 } });
    const { aiCapabilityReport } = await seam();
    const report = await aiCapabilityReport();
    expect(report.compiled).toBe(false);
    expect(report.generation.available).toBe(false);
  });
});

// `surfaceStateOf` — the narrowing (#191 task 1).
//
// The property under test is the one the tree did not have: FOUR distinguishable
// answers where five independent `catch → false` sites used to produce one bit.
// A test that only checked "available when available" would pass against the
// collapsed version it replaced.
describe("surfaceStateOf", () => {
  it("reports absent for a build with no AI compiled in, whatever the features say", async () => {
    const { surfaceStateOf, UNCOMPILED_REPORT } = await seam();
    for (const feature of ["generation", "embedding", "transcription", "autoTag"] as const) {
      expect(surfaceStateOf(UNCOMPILED_REPORT, feature)).toEqual({ kind: "absent" });
    }
  });

  it("keeps the host's cause instead of collapsing it to a boolean", async () => {
    const { surfaceStateOf } = await seam();
    // Annotated rather than inferred, so the NEXT field added to the report
    // fails on this line with the field's name. Untyped, the drift surfaced
    // four call sites down as "not assignable", which is how `indexReady`
    // (myne-md/myne#545) went missing here without anyone reading a name.
    const report: AiCapabilityReport = {
      compiled: true,
      backendId: "candle",
      backendClass: "in_process_local",
      generation: { available: false, cause: "no_model" },
      embedding: { available: false, cause: "remote_barred" },
      transcription: { available: false, cause: "unreachable" },
      autoTag: { available: true, cause: null },
      // Coherent with `embedding` above: nothing to index against.
      indexReady: false,
    };
    // Three unavailable features, three DIFFERENT reasons. Before this task all
    // three arrived at the UI as `false` and every surface said "select a model".
    expect(surfaceStateOf(report, "generation")).toEqual({
      kind: "unavailable",
      cause: "no_model",
    });
    expect(surfaceStateOf(report, "embedding")).toEqual({
      kind: "unavailable",
      cause: "remote_barred",
    });
    expect(surfaceStateOf(report, "transcription")).toEqual({
      kind: "unavailable",
      cause: "unreachable",
    });
    expect(surfaceStateOf(report, "autoTag")).toEqual({ kind: "available" });
  });

  it("distinguishes 'not compiled' from 'compiled but unavailable with no cause'", async () => {
    const { surfaceStateOf, UNCOMPILED_REPORT } = await seam();
    const compiledButSilent = {
      ...UNCOMPILED_REPORT,
      compiled: true,
    };
    // Same feature payload, opposite answers: the ONE distinction a boolean
    // cannot carry, and the one a user cannot act on if it is lost.
    expect(surfaceStateOf(UNCOMPILED_REPORT, "generation")).toEqual({ kind: "absent" });
    expect(surfaceStateOf(compiledButSilent, "generation")).toEqual({
      kind: "unavailable",
      cause: null,
    });
  });

  it("reads a rejected invoke as absent, end to end through the seam", async () => {
    const { aiCapabilityReport, surfaceStateOf } = await seam();
    invoke.mockRejectedValueOnce(new Error("command not found"));
    const report = await aiCapabilityReport();
    expect(surfaceStateOf(report, "generation")).toEqual({ kind: "absent" });
  });
});
