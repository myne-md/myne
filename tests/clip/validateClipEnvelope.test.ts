// desktop-ingest task 1 — handoff-envelope boundary validation (MYND-445).
//
// The native-messaging host (sub-feature 1, Rust `src-tauri/src/clipper/`)
// dispatches a clip handoff into desktop ingest. This module is the SINGLE
// ingress-validation chokepoint: every field crossing the trust boundary
// (A14 — the browser extension is hostile, a compromised build skips its own
// pre-handoff validation) is treated as untrusted input here. The
// extension's own validation is NOT the security line; THIS desktop gate is
// the enforcement point.
//
// These tests pin all five acceptance criteria:
//   1. a per-image `filename` carrying a path-traversal sequence (`..`,
//      absolute root, backslash, drive-letter, separators, NUL, bare dot) is
//      rejected with a typed boundary error; a clean filename passes;
//   2. a `markdownBody` that is not well-formed UTF-8 (a lone surrogate, the
//      not-well-formed case for a JS string) is rejected at the boundary —
//      NOT a corrupting pass-through;
//   3. an unrecognized `captureKind` is rejected;
//   4. `clipDate` is normalized to an RFC 3339 string; a malformed clipDate
//      is rejected;
//   5. the all-clean envelope passes through to a `ValidatedClipEnvelope`.
//
// The boundary mirrors the Rust `validate_no_path_traversal`
// (`src-tauri/src/clipper/validation.rs`) rule-for-rule, and the
// `InvalidPlaintextEncoding`-class UTF-8 rejection naming used across the
// codebase (`src/types/note-read-error.ts`, `note_read` IPC).

import { describe, expect, it } from "vitest";
import {
  validateClipEnvelope,
  type ClipEnvelopeRejection,
  type RawClipEnvelope,
  type ValidatedClipEnvelope,
} from "../../src/clip/validateClipEnvelope";

/** A fully-clean raw envelope — every field valid. Spread + override per test. */
function cleanRaw(): RawClipEnvelope {
  return {
    markdownBody: "# Hello\n\nA clean clip body.",
    captureKind: "full-article",
    sourceUrl: "https://example.com/a",
    clipDate: "2026-06-20T12:00:00Z",
    imageBytes: [
      { filename: "image.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    ],
  };
}

/** Narrow the result to its `err` arm (fails the test if it was `ok`). */
function expectErr(
  result: ReturnType<typeof validateClipEnvelope>,
): ClipEnvelopeRejection {
  if (result.kind !== "err") {
    throw new Error(`expected err, got ok: ${JSON.stringify(result.envelope)}`);
  }
  return result.reason;
}

/** Narrow the result to its `ok` arm (fails the test if it was `err`). */
function expectOk(
  result: ReturnType<typeof validateClipEnvelope>,
): ValidatedClipEnvelope {
  if (result.kind !== "ok") {
    throw new Error(`expected ok, got err: ${result.reason}`);
  }
  return result.envelope;
}

describe("validateClipEnvelope — boundary path-traversal (AC1)", () => {
  it("rejects a filename containing `..`", () => {
    const raw = cleanRaw();
    raw.imageBytes = [{ filename: "../secret.png", bytes: new Uint8Array() }];
    expect(expectErr(validateClipEnvelope(raw))).toBe("PathTraversal");
  });

  it("rejects a `..` token buried mid-path", () => {
    const raw = cleanRaw();
    raw.imageBytes = [{ filename: "a/../b.png", bytes: new Uint8Array() }];
    expect(expectErr(validateClipEnvelope(raw))).toBe("PathTraversal");
  });

  it("rejects an absolute (leading-slash) filename", () => {
    const raw = cleanRaw();
    raw.imageBytes = [{ filename: "/etc/passwd", bytes: new Uint8Array() }];
    expect(expectErr(validateClipEnvelope(raw))).toBe("PathTraversal");
  });

  it("rejects a backslash-segment filename", () => {
    const raw = cleanRaw();
    raw.imageBytes = [{ filename: "evil\\sub.png", bytes: new Uint8Array() }];
    expect(expectErr(validateClipEnvelope(raw))).toBe("PathTraversal");
  });

  it("rejects a backslash-traversal filename", () => {
    const raw = cleanRaw();
    raw.imageBytes = [{ filename: "..\\..\\x.png", bytes: new Uint8Array() }];
    expect(expectErr(validateClipEnvelope(raw))).toBe("PathTraversal");
  });

  it("rejects a Windows drive-letter prefix (`C:`)", () => {
    const raw = cleanRaw();
    raw.imageBytes = [{ filename: "C:relative.png", bytes: new Uint8Array() }];
    expect(expectErr(validateClipEnvelope(raw))).toBe("PathTraversal");
  });

  it("rejects a forward-slash separator", () => {
    const raw = cleanRaw();
    raw.imageBytes = [{ filename: "sub/image.png", bytes: new Uint8Array() }];
    expect(expectErr(validateClipEnvelope(raw))).toBe("PathTraversal");
  });

  it("rejects a NUL byte in the filename", () => {
    const raw = cleanRaw();
    raw.imageBytes = [{ filename: "image.png\0.exe", bytes: new Uint8Array() }];
    expect(expectErr(validateClipEnvelope(raw))).toBe("PathTraversal");
  });

  it("rejects an empty filename", () => {
    const raw = cleanRaw();
    raw.imageBytes = [{ filename: "", bytes: new Uint8Array() }];
    expect(expectErr(validateClipEnvelope(raw))).toBe("PathTraversal");
  });

  it("rejects a bare-dot filename", () => {
    const raw = cleanRaw();
    raw.imageBytes = [{ filename: ".", bytes: new Uint8Array() }];
    expect(expectErr(validateClipEnvelope(raw))).toBe("PathTraversal");
  });

  it("flags the LAST image's bad filename even when earlier ones are clean", () => {
    const raw = cleanRaw();
    raw.imageBytes = [
      { filename: "good.png", bytes: new Uint8Array([1]) },
      { filename: "../escape.png", bytes: new Uint8Array([2]) },
    ];
    expect(expectErr(validateClipEnvelope(raw))).toBe("PathTraversal");
  });

  it("accepts an ordinary single-component filename", () => {
    const raw = cleanRaw();
    raw.imageBytes = [
      { filename: "my clip 2026.jpeg", bytes: new Uint8Array([1]) },
      { filename: "a-b_c.d.webp", bytes: new Uint8Array([2]) },
    ];
    const env = expectOk(validateClipEnvelope(raw));
    expect(env.imageBytes.map((i) => i.filename)).toEqual([
      "my clip 2026.jpeg",
      "a-b_c.d.webp",
    ]);
  });

  it("accepts an envelope with NO images", () => {
    const raw = cleanRaw();
    raw.imageBytes = [];
    expect(expectOk(validateClipEnvelope(raw)).imageBytes).toEqual([]);
  });
});

describe("validateClipEnvelope — UTF-8 well-formedness (AC2)", () => {
  it("rejects a markdownBody carrying a lone high surrogate", () => {
    const raw = cleanRaw();
    // U+D800 is a lone high surrogate — a JS string can hold it, but it is
    // NOT well-formed Unicode (it has no UTF-8 / UTF-16 encoding).
    raw.markdownBody = `body \uD800 tail`;
    expect(expectErr(validateClipEnvelope(raw))).toBe("InvalidPlaintextEncoding");
  });

  it("rejects a markdownBody carrying a lone low surrogate", () => {
    const raw = cleanRaw();
    raw.markdownBody = `body \uDC00 tail`;
    expect(expectErr(validateClipEnvelope(raw))).toBe("InvalidPlaintextEncoding");
  });

  it("rejects a reversed surrogate pair (low before high)", () => {
    const raw = cleanRaw();
    raw.markdownBody = `\uDC00\uD800`;
    expect(expectErr(validateClipEnvelope(raw))).toBe("InvalidPlaintextEncoding");
  });

  it("accepts a well-formed body with a valid surrogate pair (emoji)", () => {
    const raw = cleanRaw();
    // "😀" is a correctly-paired surrogate (U+1F600) — well-formed.
    raw.markdownBody = "héllo 世界 😀 — clip";
    expect(expectOk(validateClipEnvelope(raw)).markdownBody).toBe(
      "héllo 世界 😀 — clip",
    );
  });

  it("does NOT corrupt/replace the body on the reject path (no partial write)", () => {
    const raw = cleanRaw();
    raw.markdownBody = `keep \uD800 me`;
    const result = validateClipEnvelope(raw);
    // The reject path yields NO validated envelope at all — there is no
    // U+FFFD-substituted body smuggled through.
    expect(result.kind).toBe("err");
    expect("envelope" in result).toBe(false);
  });
});

describe("validateClipEnvelope — capture kind (AC3)", () => {
  it("rejects an unrecognized captureKind", () => {
    const raw = cleanRaw();
    (raw as { captureKind: string }).captureKind = "delete-note";
    expect(expectErr(validateClipEnvelope(raw))).toBe("UnrecognizedCaptureKind");
  });

  it("rejects an empty-string captureKind", () => {
    const raw = cleanRaw();
    (raw as { captureKind: string }).captureKind = "";
    expect(expectErr(validateClipEnvelope(raw))).toBe("UnrecognizedCaptureKind");
  });

  it("accepts each of the three recognized kinds", () => {
    for (const kind of ["full-article", "selection", "bookmark"] as const) {
      const raw = cleanRaw();
      raw.captureKind = kind;
      expect(expectOk(validateClipEnvelope(raw)).captureKind).toBe(kind);
    }
  });
});

describe("validateClipEnvelope — clipDate normalization (AC4)", () => {
  it("normalizes a valid clipDate to an RFC 3339 string", () => {
    const raw = cleanRaw();
    raw.clipDate = "2026-06-20T12:00:00Z";
    const env = expectOk(validateClipEnvelope(raw));
    // RFC 3339: a UTC instant rendered with a `T` separator + offset.
    expect(env.clipDate).toBe("2026-06-20T12:00:00.000Z");
    // Re-parsing the normalized form must yield the same instant.
    expect(Date.parse(env.clipDate)).toBe(Date.parse(raw.clipDate));
  });

  it("normalizes an offset-bearing clipDate to the canonical UTC RFC 3339 form", () => {
    const raw = cleanRaw();
    raw.clipDate = "2026-06-20T14:00:00+02:00";
    const env = expectOk(validateClipEnvelope(raw));
    expect(env.clipDate).toBe("2026-06-20T12:00:00.000Z");
  });

  it("rejects a malformed clipDate", () => {
    const raw = cleanRaw();
    raw.clipDate = "not-a-date";
    expect(expectErr(validateClipEnvelope(raw))).toBe("MalformedClipDate");
  });

  it("rejects an empty clipDate", () => {
    const raw = cleanRaw();
    raw.clipDate = "";
    expect(expectErr(validateClipEnvelope(raw))).toBe("MalformedClipDate");
  });
});

describe("validateClipEnvelope — all-clean pass-through (AC5)", () => {
  it("validates a fully-clean envelope to a ValidatedClipEnvelope", () => {
    const raw = cleanRaw();
    const env = expectOk(validateClipEnvelope(raw));
    expect(env).toEqual({
      markdownBody: "# Hello\n\nA clean clip body.",
      captureKind: "full-article",
      sourceUrl: "https://example.com/a",
      clipDate: "2026-06-20T12:00:00.000Z",
      imageBytes: [
        { filename: "image.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
      ],
    });
  });

  it("carries NO destination_folder / tags (SYNC-15 root-only)", () => {
    const env = expectOk(validateClipEnvelope(cleanRaw()));
    expect("destinationFolder" in env).toBe(false);
    expect("tags" in env).toBe(false);
  });
});

describe("validateClipEnvelope — sourceUrl scheme allow-list (X4)", () => {
  it("rejects a javascript: scheme", () => {
    const raw = cleanRaw();
    (raw as { sourceUrl: string }).sourceUrl = "javascript:alert(1)";
    expect(expectErr(validateClipEnvelope(raw))).toBe("MalformedSourceUrl");
  });

  it("rejects a data: scheme", () => {
    const raw = cleanRaw();
    (raw as { sourceUrl: string }).sourceUrl = "data:text/html,<script>1</script>";
    expect(expectErr(validateClipEnvelope(raw))).toBe("MalformedSourceUrl");
  });

  it("rejects a file: scheme (no local-path provenance leak)", () => {
    const raw = cleanRaw();
    (raw as { sourceUrl: string }).sourceUrl = "file:///Users/secret/notes.txt";
    expect(expectErr(validateClipEnvelope(raw))).toBe("MalformedSourceUrl");
  });

  it("rejects a vbscript: scheme", () => {
    const raw = cleanRaw();
    (raw as { sourceUrl: string }).sourceUrl = "vbscript:msgbox(1)";
    expect(expectErr(validateClipEnvelope(raw))).toBe("MalformedSourceUrl");
  });

  it("rejects an unparseable / relative URL", () => {
    const raw = cleanRaw();
    (raw as { sourceUrl: string }).sourceUrl = "not a url /../etc/passwd";
    expect(expectErr(validateClipEnvelope(raw))).toBe("MalformedSourceUrl");
  });

  it("rejects an over-long URL (bloat bound)", () => {
    const raw = cleanRaw();
    (raw as { sourceUrl: string }).sourceUrl =
      "https://example.com/" + "a".repeat(9000);
    expect(expectErr(validateClipEnvelope(raw))).toBe("MalformedSourceUrl");
  });

  it("rejects a lone surrogate in the URL", () => {
    const raw = cleanRaw();
    (raw as { sourceUrl: string }).sourceUrl = "https://example.com/\ud800";
    expect(expectErr(validateClipEnvelope(raw))).toBe("MalformedSourceUrl");
  });

  it("accepts an ordinary https URL", () => {
    const raw = cleanRaw();
    (raw as { sourceUrl: string }).sourceUrl =
      "https://example.com/article?id=42#frag";
    expect(expectOk(validateClipEnvelope(raw)).sourceUrl).toBe(
      "https://example.com/article?id=42#frag",
    );
  });

  it("accepts an http URL", () => {
    const raw = cleanRaw();
    (raw as { sourceUrl: string }).sourceUrl = "http://example.org/p";
    expect(expectOk(validateClipEnvelope(raw)).sourceUrl).toBe(
      "http://example.org/p",
    );
  });

  it("accepts an empty sourceUrl (no provenance)", () => {
    const raw = cleanRaw();
    (raw as { sourceUrl: string }).sourceUrl = "";
    expect(expectOk(validateClipEnvelope(raw)).sourceUrl).toBe("");
  });
});
