// Unit tests for `scripts/check-desktop-payload-budget.mjs` (ai-bundle-slim
// myne#190 task 2).
//
// A guard whose logic is only reachable through `process.exit` is a guard
// nobody can test, so the pure functions are exported and driven here. What is
// worth pinning is every way the measured number could become MEANINGLESS while
// the guard still printed a green line — that is the failure mode of a ratchet,
// not "it computed the wrong total".

import { describe, expect, it } from "vitest";

import {
  BASELINED,
  EXPECTED_MODELS,
  compareModelSets,
  declaredPaths,
  isLfsPointer,
  measure,
  modelMappings,
  withinBudget,
} from "../../scripts/check-desktop-payload-budget.mjs";

const LFS_POINTER = Buffer.from(
  "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 498012160\n",
);

describe("isLfsPointer", () => {
  it("recognizes the pointer a smudge-skipped checkout leaves behind", () => {
    // Undetected, THIS is what the guard would measure instead of a 475 MiB
    // model — and it would pass, forever, reporting a tiny payload.
    expect(isLfsPointer(LFS_POINTER)).toBe(true);
  });

  it("does not mistake real binary content for a pointer", () => {
    expect(isLfsPointer(Buffer.from([0x47, 0x47, 0x55, 0x46, 0x03]))).toBe(false);
    expect(isLfsPointer(Buffer.alloc(64))).toBe(false);
    // A file that merely mentions the URL somewhere inside is not a pointer:
    // the header is anchored at byte 0.
    expect(isLfsPointer(Buffer.from(`x${LFS_POINTER.toString()}`))).toBe(false);
  });
});

describe("declaredPaths / modelMappings", () => {
  const conf = {
    bundle: {
      resources: {
        "resources/dictionaries/en-US": "dictionaries/en-US",
        "resources/models/whisper": "models/whisper",
        "resources/models/ocr": "models/ocr",
        "resources/models/tag": "models/tag",
      },
    },
  };

  it("reads the map form and the array form alike", () => {
    expect(declaredPaths(conf)).toHaveLength(4);
    expect(declaredPaths({ bundle: { resources: ["a", "b"] } })).toEqual(["a", "b"]);
    expect(declaredPaths({})).toEqual([]);
  });

  it("extracts the bundled-model names, sorted and deduped", () => {
    expect(modelMappings(conf)).toEqual(["ocr", "tag", "whisper"]);
    // A dictionary path is not a model, and a nested file under a model dir is
    // not a second model.
    expect(modelMappings({ bundle: { resources: ["resources/dictionaries/de"] } })).toEqual([]);
  });
});

describe("compareModelSets — both directions", () => {
  it("names an addition", () => {
    expect(compareModelSets(["ocr", "tag", "whisper", "embed"], EXPECTED_MODELS)).toEqual({
      added: ["embed"],
      removed: [],
    });
  });

  it("names a removal — the direction a one-way check would miss", () => {
    // A silently dropped `models/ocr` breaks OCR-backed search. `ai-no-network-
    // check.sh` check 3 guards that on the CODE side; nothing guarded it on the
    // packaging side before this.
    expect(compareModelSets(["tag", "whisper"], EXPECTED_MODELS)).toEqual({
      added: [],
      removed: ["ocr"],
    });
  });

  it("is quiet only when the sets are equal", () => {
    expect(compareModelSets([...EXPECTED_MODELS].reverse(), EXPECTED_MODELS)).toEqual({
      added: [],
      removed: [],
    });
  });
});

describe("measure", () => {
  const io = (files: Record<string, { size: number; body?: Buffer }>) => ({
    existsSync: (p: string) => Object.keys(files).some((f) => p.endsWith(f)),
    statSync: (p: string) => {
      const key = Object.keys(files).find((f) => p.endsWith(f));
      return { size: files[key!].size, isDirectory: () => false };
    },
    readFileSync: (p: string) => {
      const key = Object.keys(files).find((f) => p.endsWith(f));
      return files[key!].body ?? Buffer.alloc(files[key!].size);
    },
  });

  it("reports a missing declared path instead of counting it as zero", () => {
    const r = measure("/base", ["gone"], io({}) as never);
    expect(r.missing).toEqual(["gone"]);
    expect(r.bytes).toBe(0);
  });
});

describe("withinBudget", () => {
  it("allows growth up to the margin and rejects past it", () => {
    expect(withinBudget(102, 100, 2)).toBe(true);
    expect(withinBudget(103, 100, 2)).toBe(false);
    // Shrinking always passes — that is the direction the slice is aiming for.
    expect(withinBudget(50, 100, 2)).toBe(true);
  });

  it("uses a 2% margin, not the web guard's 10", () => {
    // 10% of a ~650 MiB payload is 65 MiB of invisible growth, more than the
    // whole whisper model. Pinned here so a copy-paste from the web guard is
    // caught rather than inherited.
    const payload = 671_889_625;
    expect(withinBudget(Math.floor(payload * 1.05), payload, 2)).toBe(false);
    expect(withinBudget(Math.floor(payload * 1.05), payload, 10)).toBe(true);
  });
});

describe("BASELINED", () => {
  it("gates only the component every checkout reproduces", () => {
    // `externalBin` and `binary` depend on which target triples are staged and
    // whether a release build ran; recording either would enshrine one
    // machine's state as the budget.
    expect(BASELINED).toEqual(["resources"]);
  });
});
