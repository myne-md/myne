// Spec: docs/spec/markdown-dialect.md §3.6 (line-1-anchored detection,
// YAML 1.2 body) and §3.6.1 (Myne-managed canonical fields).

import { load as parseYaml, YAMLException } from "js-yaml";
import { locateFrontmatter } from "../lezer/frontmatter";
import type { Frontmatter, YamlParseError } from "../types";

function adaptYamlError(
  err: YAMLException,
  bodyStart: number,
): YamlParseError {
  const mark = err.mark;
  return {
    kind: "yaml",
    severity: "error",
    message: err.message ?? err.reason ?? "YAML parse failed",
    line: (mark?.line ?? 0) + 1,
    column: (mark?.column ?? 0) + 1,
    byteOffset: bodyStart + (mark?.position ?? 0),
  };
}

/**
 * Parse the leading frontmatter block. Always returns a `Frontmatter`.
 * No frontmatter (no opener, or opener-without-closer) → all-null shape.
 * Malformed YAML → `parsed: null` + `error: { kind: "yaml" }`.
 *
 * js-yaml v4 only throws `YAMLException` from `load`; non-YAMLException
 * throws are treated as bugs and propagate.
 */
export function parseFrontmatter(source: string): Frontmatter {
  const located = locateFrontmatter(source);
  if (located === null) {
    return { raw: null, parsed: null, byteRange: null, error: null };
  }
  const { blockStart, blockEnd, bodyStart, bodyEnd } = located;
  const raw = source.substring(bodyStart, bodyEnd);
  const byteRange = { start: blockStart, end: blockEnd };

  if (raw.length === 0) {
    return { raw, parsed: {}, byteRange, error: null };
  }

  let loaded: unknown;
  try {
    loaded = parseYaml(raw);
  } catch (err) {
    if (err instanceof YAMLException) {
      return { raw, parsed: null, byteRange, error: adaptYamlError(err, bodyStart) };
    }
    throw err;
  }

  // Canonicalize non-mapping YAML (undefined / null / scalar / top-level
  // array) to an empty object — Obsidian rejects non-mapping frontmatter,
  // and consumers iterate `parsed` without null-checking key types.
  if (loaded === undefined || loaded === null) {
    return { raw, parsed: {}, byteRange, error: null };
  }
  if (typeof loaded !== "object" || Array.isArray(loaded)) {
    return { raw, parsed: {}, byteRange, error: null };
  }

  return {
    raw,
    parsed: loaded as Record<string, unknown>,
    byteRange,
    error: null,
  };
}
