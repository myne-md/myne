// Tests for the folder/title segment grammar + case-fold identity + .md-strip.
// Spec: markdown-dialect §3.6.1 segment grammar; wikilink §2.1/§3.4/§10;
// §3.7.8 tag case-fold+NFC identity. Grill: 2026-05-29-folder-hierarchy Q5.
//
// Special characters are constructed via String.fromCharCode so the source
// stays plain-ASCII and carries no invisible control/combining bytes.

import { describe, it, expect } from "vitest";
import {
  isLegalSegment,
  foldSegment,
  titleToFilename,
  filenameToTitle,
  isLegalPathLength,
  normalizeFolderPath,
  validateFolderNameInput,
  utf8ByteLength,
  MAX_SEGMENT_BYTES,
  MAX_PATH_BYTES,
} from "../../src/dialect/folderPath";

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);
const NBSP = String.fromCharCode(0xa0);
const COMBINING_ACUTE = String.fromCharCode(0x301);
const PRECOMPOSED_E_ACUTE = String.fromCharCode(0xe9);
const FOLDER_EMOJI = String.fromCodePoint(0x1f4c1);

describe("isLegalSegment — forbidden characters", () => {
  it.each([
    ["forward slash", "a/b"],
    ["backslash", "a\\b"],
    ["pipe", "a|b"],
    ["hash", "a#b"],
    ["caret", "a^b"],
    ["open bracket", "a[b"],
    ["close bracket", "a]b"],
    ["double close bracket (wikilink terminator)", "a]]b"],
    ["newline", `a${LF}b`],
    ["carriage return", `a${CR}b`],
    ["tab", `a${TAB}b`],
    ["NUL control", `a${NUL}b`],
    ["DEL control", `a${DEL}b`],
  ])("rejects a segment containing a %s", (_label, segment) => {
    expect(isLegalSegment(segment)).toBe(false);
  });
});

describe("isLegalSegment — structural rejects", () => {
  it("rejects the empty segment", () => {
    expect(isLegalSegment("")).toBe(false);
  });
  it("rejects whole-segment '.' and '..' (traversal)", () => {
    expect(isLegalSegment(".")).toBe(false);
    expect(isLegalSegment("..")).toBe(false);
  });
  it("rejects leading or trailing whitespace", () => {
    expect(isLegalSegment(" foo")).toBe(false);
    expect(isLegalSegment("foo ")).toBe(false);
    expect(isLegalSegment(`foo${NBSP}`)).toBe(false); // trailing NBSP
  });
  it("rejects a trailing dot (Windows footgun)", () => {
    expect(isLegalSegment("foo.")).toBe(false);
  });
});

describe("isLegalSegment — accepted (Obsidian permissiveness)", () => {
  it.each([
    ["interior spaces", "My Project Notes"],
    ["Cyrillic", "Проекты"],
    ["CJK", "项目"],
    ["Turkish diacritics", "Günlük"],
    ["emoji", `${FOLDER_EMOJI} inbox`],
    ["digits + underscore + dash", "2025_q1-archive"],
    ["interior dot", "v0.1 spec"],
    ["leading dot (hidden-style)", ".config"],
  ])("accepts a segment with %s", (_label, segment) => {
    expect(isLegalSegment(segment)).toBe(true);
  });
});

describe("isLegalSegment — length cap", () => {
  it("accepts a segment of exactly MAX_SEGMENT_BYTES", () => {
    expect(isLegalSegment("a".repeat(MAX_SEGMENT_BYTES))).toBe(true);
  });
  it("rejects a segment exceeding MAX_SEGMENT_BYTES (ASCII)", () => {
    expect(isLegalSegment("a".repeat(MAX_SEGMENT_BYTES + 1))).toBe(false);
  });
  it("counts UTF-8 bytes, not code points", () => {
    // 'ö' is 2 UTF-8 bytes; 128 of them = 256 bytes > 255.
    const oUmlaut = String.fromCharCode(0xf6);
    expect(utf8ByteLength(oUmlaut)).toBe(2);
    expect(isLegalSegment(oUmlaut.repeat(128))).toBe(false); // 256 bytes
    expect(isLegalSegment(oUmlaut.repeat(127))).toBe(true); // 254 bytes
  });
});

describe("foldSegment — case-fold + NFC identity", () => {
  it("collapses ASCII case (Projects ≡ projects)", () => {
    expect(foldSegment("Projects")).toBe(foldSegment("projects"));
  });
  it("collapses case across a path (trailing slash preserved equally)", () => {
    expect(foldSegment("Projects/")).toBe(foldSegment("projects/"));
  });
  it("NFC-normalizes composed vs decomposed equivalents", () => {
    const composed = `Caf${PRECOMPOSED_E_ACUTE}`; // U+00E9
    const decomposed = `Cafe${COMBINING_ACUTE}`; // e + U+0301
    expect(composed).not.toBe(decomposed); // distinct byte sequences
    expect(foldSegment(composed)).toBe(foldSegment(decomposed));
  });
  it("does not mutate its input (raw recoverable for display)", () => {
    const raw = "ProjeCTS";
    foldSegment(raw);
    expect(raw).toBe("ProjeCTS");
  });
});

describe(".md-strip round-trip", () => {
  it("appends .md to a title", () => {
    expect(titleToFilename("Wednesday")).toBe("Wednesday.md");
  });
  it("strips exactly one trailing .md", () => {
    expect(filenameToTitle("Wednesday.md")).toBe("Wednesday");
  });
  it("round-trips a note literally titled 'Foo.md'", () => {
    const title = "Foo.md";
    const filename = titleToFilename(title); // Foo.md.md
    expect(filename).toBe("Foo.md.md");
    expect(filenameToTitle(filename)).toBe(title); // back to Foo.md
  });
  it("leaves a filename with no .md extension unchanged when stripping", () => {
    expect(filenameToTitle("Foo")).toBe("Foo");
  });
});

describe("isLegalPathLength — total vault-relative path cap", () => {
  it("accepts a path of exactly MAX_PATH_BYTES", () => {
    expect(isLegalPathLength("a".repeat(MAX_PATH_BYTES))).toBe(true);
  });
  it("rejects a path exceeding MAX_PATH_BYTES", () => {
    expect(isLegalPathLength("a".repeat(MAX_PATH_BYTES + 1))).toBe(false);
  });
});

describe("normalizeFolderPath — canonical trailing-slash / root", () => {
  it("appends a trailing slash to a bare segment", () => {
    expect(normalizeFolderPath("Projects")).toBe("Projects/");
  });
  it("leaves an already-canonical path unchanged", () => {
    expect(normalizeFolderPath("Projects/Myne/")).toBe("Projects/Myne/");
  });
  it("treats null / empty / '/' as root", () => {
    expect(normalizeFolderPath(null)).toBeNull();
    expect(normalizeFolderPath("")).toBeNull();
    expect(normalizeFolderPath("/")).toBeNull();
  });
  it("collapses duplicate and leading slashes", () => {
    expect(normalizeFolderPath("Projects//Myne")).toBe("Projects/Myne/");
    expect(normalizeFolderPath("/Projects/")).toBe("Projects/");
  });
});

describe("validateFolderNameInput — the Myne-authored UI gate (§3.6.2)", () => {
  it("accepts a plain legal name", () => {
    expect(validateFolderNameInput("Projects", "Projects/")).toBeNull();
  });
  it("accepts a typed nested path (each segment legal)", () => {
    // The new-folder field permits `a/b` to create nested folders at once.
    expect(validateFolderNameInput("Projects/Myne", "Projects/Myne/")).toBeNull();
  });
  it("accepts a legal child under a (possibly imported-illegal) parent prefix", () => {
    // Only the typed segment is grammar-checked; the parent prefix is not —
    // a legal child must be creatable under an imported-illegal parent.
    expect(validateFolderNameInput("child", "a|b/child/")).toBeNull();
  });
  it.each([
    ["backslash", "a\\b"],
    ["pipe", "a|b"],
    ["hash", "a#b"],
    ["caret", "a^b"],
    ["wikilink terminator", "a]]b"],
    ["traversal", ".."],
    ["trailing dot", "foo."],
    ["leading space", " foo"],
    ["whitespace-only (non-empty after split)", "   "],
  ])("rejects illegal typed segment (%s)", (_label, typed) => {
    expect(validateFolderNameInput(typed, "x/")).toBe("illegal-segment");
  });
  it("treats input with no real segment as a cancel ('empty'), not an error", () => {
    expect(validateFolderNameInput("", "")).toBe("empty");
    expect(validateFolderNameInput("///", "")).toBe("empty");
  });
  it("rejects an over-long resulting path even when each segment is legal", () => {
    const longSeg = "a".repeat(MAX_SEGMENT_BYTES); // legal segment
    const fullPath = `${longSeg}/${longSeg}/${longSeg}/${longSeg}/${longSeg}/`; // > 1024 B
    expect(isLegalSegment(longSeg)).toBe(true);
    expect(validateFolderNameInput(longSeg, fullPath)).toBe("too-long");
  });
});
