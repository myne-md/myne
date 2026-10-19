#!/usr/bin/env node
// The browser clipper's WIRE DICTIONARY and its `capture_kind` closed set,
// held across two repositories (audit 2026-10-18 B4).
//
// The failure this prevents is the sibling of `check-clipper-identifiers.mjs`'s:
// the ext→host handoff envelope (SYNC-10) is written down in more than one
// place, and a drift in ANY of them is silent on both sides — the desktop crate
// compiles, the extension loads, and the clip is refused (`deny_unknown_fields`
// on the Rust side turns a renamed field into `Malformed`) or lands with the
// wrong `capture_kind`. Nothing else in either repository reports it:
//
//   - the Rust struct is `#[serde(deny_unknown_fields)]`, so a field the
//     extension adds is a hard reject and a field the extension drops silently
//     defaults;
//   - `CaptureKind` is a kebab-case enum, so a typo'd literal is rejected on
//     the wire but satisfies every compiler and every existing test;
//   - the extension's own copies were read by NOTHING before this guard.
//
// What it compares, and where each side is DECLARED (parsed, not grepped for
// usage — usage scans read the wrong set, see below):
//
//   1. `capture_kind` closed set — ALWAYS (the two main-repo copies are both
//      here): `src-tauri/src/clipper/envelope.rs::CaptureKind` (Rust enum),
//      `src/dialect/clip/captureKind.ts::CAPTURE_KINDS` (the runtime array) and
//      the `CaptureKind` union TYPE in the same file. Compared three ways.
//   2. `capture_kind`, third copy — COMPANION: the extension's
//      `src/background/clip.ts::CaptureKind` and `src/content/capture.ts::
//      CaptureKind`.
//   3. The envelope FIELD dictionary — COMPANION: `envelope.rs::
//      HandoffEnvelope`'s `pub` fields against the extension's
//      `src/background/envelope.ts::HandoffEnvelope` interface fields.
//   4. The handoff `kind` set — COMPANION: `envelope.rs::HandoffKind` against
//      the `readonly kind: "…"` of every `*Envelope` interface the extension
//      declares.
//   5. The reply `status` set — COMPANION: `envelope.rs::HostReply` (the
//      `tag = "status"` enum) against the extension's declared `HostReply`
//      union plus its `pair-wire` reply comparisons.
//
// EVERY comparison is BOTH directions: a literal on one side only fails, named.
// A pattern that stops matching fails BY NAME rather than reporting ok on an
// input it could not read (the `check-embed-layout-drift.mjs` lesson).
//
// # Why a GUARD and not a test that reads the extension's copy
//
// The three copies live in TWO repositories, the companion is absent in a fresh
// clone AND on the CI runner, and a test that skips its cross-repo half
// silently is the exact failure `check-embed-layout-drift.mjs`'s header records
// about the published vectors ("both runners skip silently when the companion
// repo is absent, which is the default in CI and in a fresh clone"). So the
// absent case prints what it could NOT check and `--require-companion` turns
// that into a failure. The INTRA-repo half (comparison 1) runs unconditionally,
// so the Rust↔dialect `capture_kind` agreement is gated everywhere including CI.
//
// # Deliberate limits, stated so a reader does not over-trust it
//
//   - The extension's `kind` set is read from `*Envelope` INTERFACES, not from
//     every `kind:` literal in the tree: `background/toolbar.ts` also declares
//     `readonly kind: "clipped" | "prompt" | …`, which are toast discriminants
//     and not wire kinds. Reading every literal would fold those in and the
//     comparison would be wrong in the direction that matters.
//   - The extension's `status` set is read from `clip.ts`'s `HostReply` type and
//     `pair-wire.ts`'s reply comparisons, not from every `status === "…"` in the
//     tree: `status-wire.ts`/`toolbar.ts` compare the extension's OWN states
//     (`"unlocked"`/`"closed"`/`"unpaired"`), and `clip.ts`'s `ClipOutcome` adds a
//     LOCAL `"unreachable"`. Those are not wire statuses and must not enter the
//     set. Consequence: a reply status handled in some NEW file this guard does
//     not read would be missed — the Rust side gaining one still fails, because
//     the comparison is two-directional.
//   - It does not compare field TYPES or the `#[serde(default)]` posture, only
//     NAMES. A field renamed on one side is the class that silently refuses or
//     drops data; a retyped field is caught at decode by serde.
//
// Zero dependencies, hand-runnable: node scripts/check-clipper-wire.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

/**
 * Where the companion checkout is, tried in the order the two layouts occur —
 * the same resolution (and the same reasoning) as `check-clipper-identifiers.mjs`,
 * whose header records why a single hardcoded `../../../` silently stopped
 * checking the cross-repo half from the ordinary checkout. `MYNE_CLIPPER_DIR`
 * overrides it so the companion-ABSENT branch stays exercisable on a machine
 * that has the companion.
 */
const COMPANION_CANDIDATES = [
  resolve(repoRoot, "myne-clipper"),
  resolve(repoRoot, "..", "..", "..", "myne-clipper"),
];
const COMPANION = process.env.MYNE_CLIPPER_DIR
  ? resolve(process.env.MYNE_CLIPPER_DIR)
  : (COMPANION_CANDIDATES.find((c) => existsSync(join(c, "src", "manifest.json"))) ??
    COMPANION_CANDIDATES[0]);
const COMPANION_MANIFEST = join(COMPANION, "src", "manifest.json");

const ENVELOPE_RS = "src-tauri/src/clipper/envelope.rs";
const CAPTURE_KIND_TS = "src/dialect/clip/captureKind.ts";
const EXT = {
  envelope: join("src", "background", "envelope.ts"),
  clip: join("src", "background", "clip.ts"),
  pairWire: join("src", "background", "pair-wire.ts"),
  contentCapture: join("src", "content", "capture.ts"),
};

const failures = [];
const notes = [];
const fail = (message) => failures.push(message);
/** Diagnostic summary of what the companion half actually compared (printed on ok). */
const companionChecks = [];

/** `FullArticle` → `full-article` — the serde `rename_all = "kebab-case"` mapping. */
const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** The substring from `start` to the first column-0 `}`, or null. */
function bodyAfter(source, start) {
  const rest = source.slice(start);
  const end = rest.search(/\n\}/);
  return end === -1 ? null : rest.slice(0, end);
}

/** The `{ … }` body of a declaration whose header matches `openRe`. */
function bracedBody(source, openRe, where, what) {
  const m = openRe.exec(source);
  if (!m) {
    fail(
      `${where}: could not find ${what}. A renamed declaration is not a smaller ` +
        `check — it is this guard reporting ok on an input it could not read.`,
    );
    return null;
  }
  const body = bodyAfter(source, m.index + m[0].length);
  if (body === null) {
    fail(`${where}: found ${what} but no closing brace, so it could not be read.`);
  }
  return body;
}

/** Kebab-cased unit/struct enum variant names out of a Rust `pub enum`. */
function rustEnumVariants(source, name, where) {
  const body = bracedBody(
    source,
    new RegExp(`pub\\s+enum\\s+${name}\\s*\\{`),
    where,
    `\`pub enum ${name}\``,
  );
  if (body === null) return null;
  const out = [...body.matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*(?:\{|,)/gm)].map((m) => kebab(m[1]));
  if (out.length === 0) {
    fail(`${where}: \`pub enum ${name}\` declared no variant this guard could read.`);
    return null;
  }
  return out;
}

/** `pub` field names out of a Rust `pub struct`. */
function rustStructFields(source, name, where) {
  const body = bracedBody(
    source,
    new RegExp(`pub\\s+struct\\s+${name}\\s*\\{`),
    where,
    `\`pub struct ${name}\``,
  );
  if (body === null) return null;
  const out = [...body.matchAll(/^\s*pub\s+([a-z_][a-z0-9_]*)\s*:/gm)].map((m) => m[1]);
  if (out.length === 0) {
    fail(`${where}: \`pub struct ${name}\` declared no field this guard could read.`);
    return null;
  }
  return out;
}

/** The string literals of `export type NAME = "a" | "b";`. */
function tsUnionLiterals(source, name, where) {
  const m = source.match(new RegExp(`export\\s+type\\s+${name}\\s*=\\s*([^;]+);`));
  if (!m) {
    fail(
      `${where}: could not find \`export type ${name} = …\`. A renamed alias is ` +
        `this guard reporting ok on an input it could not read.`,
    );
    return null;
  }
  const out = [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]);
  if (out.length === 0) {
    fail(`${where}: \`export type ${name}\` carried no string literal this guard could read.`);
    return null;
  }
  return out;
}

/** The string literals of `export const NAME = [ "a", … ];`. */
function tsArrayLiterals(source, name, where) {
  const m = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) {
    fail(`${where}: could not find \`export const ${name} = [ … ]\`.`);
    return null;
  }
  const out = [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]);
  if (out.length === 0) {
    fail(`${where}: \`export const ${name}\` carried no string literal this guard could read.`);
    return null;
  }
  return out;
}

/** `readonly` field names out of a TS `export interface`. */
function tsInterfaceFields(source, name, where) {
  const body = bracedBody(
    source,
    new RegExp(`export\\s+interface\\s+${name}\\s*\\{`),
    where,
    `\`export interface ${name}\``,
  );
  if (body === null) return null;
  const out = [...body.matchAll(/^\s*readonly\s+([a-z_][a-z0-9_]*)\s*:/gm)].map((m) => m[1]);
  if (out.length === 0) {
    fail(`${where}: \`export interface ${name}\` declared no field this guard could read.`);
    return null;
  }
  return out;
}

/**
 * The `kind` of every `*Envelope` interface a companion file declares.
 *
 * Scoped to `*Envelope` interfaces ON PURPOSE: `background/toolbar.ts` declares
 * `readonly kind: "clipped" | "prompt" | …`, which are toast discriminants, and
 * a scan for every `kind:` literal would fold them in and make the set wrong.
 */
function companionEnvelopeKinds() {
  const out = [];
  const files = [
    EXT.envelope,
    join("src", "background", "status-wire.ts"),
    EXT.pairWire,
  ];
  for (const rel of files) {
    const path = join(COMPANION, rel);
    if (!existsSync(path)) {
      fail(`${rel} is missing from the companion, so its envelope \`kind\` was NOT read.`);
      continue;
    }
    const src = readFileSync(path, "utf8");
    const re = /export\s+interface\s+(\w+Envelope)\s*\{/g;
    let m;
    let perFile = 0;
    while ((m = re.exec(src)) !== null) {
      const body = bodyAfter(src, m.index + m[0].length);
      if (body === null) {
        fail(`${rel}: \`interface ${m[1]}\` had no closing brace.`);
        continue;
      }
      const kind = body.match(/readonly\s+kind:\s*"([a-z0-9-]+)"/);
      if (kind === null) {
        fail(
          `${rel}: \`interface ${m[1]}\` declares no \`readonly kind: "…"\`, so its ` +
            `wire kind could not be read — which is the field this comparison is about.`,
        );
        continue;
      }
      out.push(kind[1]);
      perFile += 1;
    }
    if (perFile === 0) {
      fail(`${rel}: no \`export interface *Envelope\` carrying a \`kind\` was found.`);
    }
  }
  return out;
}

/**
 * The companion's reply-status vocabulary.
 *
 * From `clip.ts`'s declared `HostReply` union and `pair-wire.ts`'s reply
 * comparisons ONLY. The extension's local states (`status-wire.ts` /
 * `toolbar.ts` compare `"unlocked"` / `"closed"` / `"unpaired"`, and `clip.ts`'s
 * `ClipOutcome` adds `"unreachable"`) are NOT wire statuses; a scan for every
 * `status` literal would fold them in and break the comparison in the direction
 * that matters.
 */
function companionReplyStatuses() {
  const out = [];
  const clipPath = join(COMPANION, EXT.clip);
  if (!existsSync(clipPath)) {
    fail(`${EXT.clip} is missing from the companion, so the reply \`status\` set was NOT read.`);
  } else {
    const src = readFileSync(clipPath, "utf8");
    const m = src.match(/export\s+type\s+HostReply\s*=\s*([\s\S]*?);\s*\n/);
    if (!m) {
      fail(`${EXT.clip}: could not find \`export type HostReply = …\`, the reply union.`);
    } else {
      for (const x of m[1].matchAll(/status:\s*"([a-z-]+)"/g)) out.push(x[1]);
    }
  }
  const pairPath = join(COMPANION, EXT.pairWire);
  if (!existsSync(pairPath)) {
    fail(`${EXT.pairWire} is missing from the companion, so the reply \`status\` set was NOT read.`);
  } else {
    const src = readFileSync(pairPath, "utf8");
    for (const x of src.matchAll(/\.status\s*===\s*"([a-z-]+)"/g)) out.push(x[1]);
  }
  return out;
}

/** Compare two literal lists as sets, failing BY NAME in BOTH directions. */
function compareSets(a, b, labelA, labelB, what) {
  const setA = new Set(a);
  const setB = new Set(b);
  const onlyA = [...setA].filter((x) => !setB.has(x));
  const onlyB = [...setB].filter((x) => !setA.has(x));
  if (onlyA.length > 0) {
    fail(
      `${what} drift: ${labelA} declares ${onlyA.map((q) => `"${q}"`).join(", ")}, ` +
        `which ${labelB} does not. A value on one side only is the drift this guard ` +
        `exists for — the wire refuses it or the clip lands with the wrong shape.`,
    );
  }
  if (onlyB.length > 0) {
    fail(
      `${what} drift: ${labelB} declares ${onlyB.map((q) => `"${q}"`).join(", ")}, ` +
        `which ${labelA} does not. A value on one side only is the drift this guard ` +
        `exists for — the wire refuses it or the clip lands with the wrong shape.`,
    );
  }
}

// ── 1. The main-repo half: Rust `CaptureKind` ↔ the dialect's two declarations
const envelopeRs = read(ENVELOPE_RS);
const captureKindTs = read(CAPTURE_KIND_TS);

const rustEnvelopeFields = rustStructFields(envelopeRs, "HandoffEnvelope", ENVELOPE_RS);
const rustCaptureKinds = rustEnumVariants(envelopeRs, "CaptureKind", ENVELOPE_RS);
const rustHandoffKinds = rustEnumVariants(envelopeRs, "HandoffKind", ENVELOPE_RS);
const rustReplyStatuses = rustEnumVariants(envelopeRs, "HostReply", ENVELOPE_RS);

const dialectCaptureKinds = tsArrayLiterals(captureKindTs, "CAPTURE_KINDS", CAPTURE_KIND_TS);
const dialectCaptureKindUnion = tsUnionLiterals(captureKindTs, "CaptureKind", CAPTURE_KIND_TS);

if (rustCaptureKinds !== null && dialectCaptureKinds !== null) {
  compareSets(
    rustCaptureKinds,
    dialectCaptureKinds,
    `${ENVELOPE_RS} CaptureKind`,
    `${CAPTURE_KIND_TS} CAPTURE_KINDS`,
    "capture_kind",
  );
}
if (dialectCaptureKinds !== null && dialectCaptureKindUnion !== null) {
  compareSets(
    dialectCaptureKinds,
    dialectCaptureKindUnion,
    `${CAPTURE_KIND_TS} CAPTURE_KINDS`,
    `${CAPTURE_KIND_TS} CaptureKind type`,
    "capture_kind",
  );
}

// ── 2. The cross-repo half
const requireCompanion = process.argv.includes("--require-companion");
if (!existsSync(COMPANION_MANIFEST)) {
  const message =
    `the myne-clipper companion is not checked out at ${COMPANION}, so the ` +
    `extension's copies of the envelope FIELD dictionary, the handoff \`kind\` ` +
    `set, the reply \`status\` set and \`CaptureKind\` were NOT compared — which ` +
    `is the half no single repository can verify. Clone it with ` +
    `./workspace/setup.sh, or pass --require-companion to make this a failure.`;
  if (requireCompanion) fail(message);
  else notes.push(message);
} else {
  // 2a. capture_kind — the extension's two copies.
  const extClipPath = join(COMPANION, EXT.clip);
  const extContentPath = join(COMPANION, EXT.contentCapture);
  let extClipCaptureKinds = null;
  if (existsSync(extClipPath)) {
    extClipCaptureKinds = tsUnionLiterals(readFileSync(extClipPath, "utf8"), "CaptureKind", EXT.clip);
  } else {
    fail(`${EXT.clip} is missing from the companion.`);
  }
  if (rustCaptureKinds !== null && extClipCaptureKinds !== null) {
    compareSets(
      rustCaptureKinds,
      extClipCaptureKinds,
      `${ENVELOPE_RS} CaptureKind`,
      `${EXT.clip} CaptureKind`,
      "capture_kind",
    );
  }
  if (existsSync(extContentPath)) {
    const extContentCaptureKinds = tsUnionLiterals(
      readFileSync(extContentPath, "utf8"),
      "CaptureKind",
      EXT.contentCapture,
    );
    if (extClipCaptureKinds !== null && extContentCaptureKinds !== null) {
      compareSets(
        extClipCaptureKinds,
        extContentCaptureKinds,
        `${EXT.clip} CaptureKind`,
        `${EXT.contentCapture} CaptureKind`,
        "capture_kind",
      );
    }
  }

  // 2b. The envelope FIELD dictionary.
  const extEnvelopePath = join(COMPANION, EXT.envelope);
  if (!existsSync(extEnvelopePath)) {
    fail(`${EXT.envelope} is missing from the companion, so the envelope fields were NOT compared.`);
  } else {
    const extFields = tsInterfaceFields(
      readFileSync(extEnvelopePath, "utf8"),
      "HandoffEnvelope",
      EXT.envelope,
    );
    if (rustEnvelopeFields !== null && extFields !== null) {
      compareSets(
        rustEnvelopeFields,
        extFields,
        `${ENVELOPE_RS} HandoffEnvelope`,
        `${EXT.envelope} HandoffEnvelope`,
        "envelope field dictionary",
      );
      companionChecks.push(`fields ${extFields.length}`);
    }
  }

  // 2c. The handoff `kind` set.
  const extKinds = companionEnvelopeKinds();
  if (rustHandoffKinds !== null && extKinds.length > 0) {
    compareSets(
      rustHandoffKinds,
      extKinds,
      `${ENVELOPE_RS} HandoffKind`,
      `the extension's *Envelope kinds`,
      "handoff kind",
    );
    companionChecks.push(`kind {${[...new Set(extKinds)].sort().join(", ")}}`);
  }

  // 2d. The reply `status` set.
  const extStatuses = companionReplyStatuses();
  if (rustReplyStatuses !== null && extStatuses.length > 0) {
    compareSets(
      rustReplyStatuses,
      extStatuses,
      `${ENVELOPE_RS} HostReply`,
      `the extension's reply statuses`,
      "reply status",
    );
    companionChecks.push(`status {${[...new Set(extStatuses)].sort().join(", ")}}`);
  }
}

if (failures.length > 0) {
  console.error("clipper wire: FAILED");
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
for (const note of notes) console.warn(`clipper wire: NOT CHECKED — ${note}`);
console.log(
  `clipper wire: ok (envelope fields ${rustEnvelopeFields?.length ?? "?"}, ` +
    `capture_kind {${(rustCaptureKinds ?? []).join(", ")}}` +
    `${notes.length === 0 ? `, extension cross-checked: ${companionChecks.join("; ")}` : ""})`,
);
