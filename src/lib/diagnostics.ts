// The copyable diagnostic block (phase3-web-client task 114).
//
// # Built from an allowlist, and that is the entire security design
//
// `FailClosedError` carries the rule "NO diagnostic detail in prod (TB6 — keep
// the internal state model off the wire)". This narrows it to "no *unbounded*
// detail"; it does not reverse it. The narrowing is only safe if the payload
// cannot grow by accident, and a **blocklist cannot give that guarantee**: it
// works until someone adds a field nobody thought to forbid, which is how a note
// id or a path ends up in a block a user pastes into a public issue.
//
// So the block is assembled field by field from a literal list. Adding anything
// means editing this file, and a test asserts the produced keys equal that list
// exactly — so a field added anywhere else fails rather than ships.
//
// # What is deliberately absent, and why each one
//
// * **No error message.** A thrown `Error`'s message is arbitrary text from
//   arbitrary code; on this client it can quote a path, a note title or a
//   credential the throwing call had in scope. The bounded `code` says what
//   class of thing broke, which is what a maintainer can act on.
// * **No note id, account number or account hash.** Nothing that identifies the
//   user or their content, in a block whose whole purpose is to be pasted
//   somewhere else.
// * **No filesystem or OPFS path.** On the DENY list (`src-tauri/CLAUDE.md`) for
//   the same reason it is everywhere else.
// * **No fine-grained timestamp.** A millisecond stamp on a pasted block is a
//   usage record; the build channel and version already answer "which build".
// * **No user agent string, only the engine and version.** The full UA string is
//   a fingerprinting surface with a long tail of extensions and OEM tokens; what
//   a maintainer needs is "Chrome 140".
//
// # Nothing is transmitted
//
// This produces a string. The only consumer is a copy-to-clipboard button the
// user presses. There is no reporting endpoint, no beacon, and no automatic
// send — task 60's zero-third-party request-log assertion must keep passing with
// this feature enabled, and it does because nothing here makes a request.

/**
 * The exact fields a diagnostic block may contain, in render order.
 *
 * Exported so the test can assert the produced keys equal this list — the check
 * that makes "allowlist" a property rather than a description.
 */
export const DIAGNOSTIC_FIELDS = [
  "version",
  "channel",
  "commit",
  "bundleHash",
  "failureCode",
  "engine",
  "crossOriginIsolated",
  "storageUsedMb",
  "storageQuotaMb",
] as const;

export type DiagnosticField = (typeof DIAGNOSTIC_FIELDS)[number];

/** The environment readings a caller supplies. Each maps to one allowlisted
 *  field; there is no passthrough bag, so a caller cannot add a tenth. */
export interface DiagnosticInputs {
  readonly version: string;
  readonly channel: string;
  /** The commit the running build came from. `null` only if the caller has no
   *  reading at all — every current caller has one, since the compile-time
   *  define backs the served value up. */
  readonly commit: string | null;
  readonly bundleHash: string | null;
  /** The bounded, closed-enum failure label — never a message string. */
  readonly failureCode: string;
  /** Engine + major version, e.g. `Chrome 140`. Never the full UA string. */
  readonly engine: string;
  readonly crossOriginIsolated: boolean;
  /** `navigator.storage.estimate()` totals, in whole MB; `null` when unavailable. */
  readonly storageUsedMb: number | null;
  readonly storageQuotaMb: number | null;
}

/**
 * The block, as a stable `key: value` document.
 *
 * Deliberately not JSON: a user pastes this into an issue or a message, and a
 * flat readable list survives that better than a blob they are tempted to trim.
 */
export function buildDiagnostics(inputs: DiagnosticInputs): string {
  const record = diagnosticRecord(inputs);
  return DIAGNOSTIC_FIELDS.map((k) => `${k}: ${record[k]}`).join("\n");
}

/** The same content as a record, for the test that pins the key set. */
export function diagnosticRecord(inputs: DiagnosticInputs): Record<DiagnosticField, string> {
  const unknown = "unknown";
  return {
    version: inputs.version,
    channel: inputs.channel,
    commit: inputs.commit ?? unknown,
    bundleHash: inputs.bundleHash ?? unknown,
    failureCode: inputs.failureCode,
    engine: inputs.engine,
    crossOriginIsolated: String(inputs.crossOriginIsolated),
    storageUsedMb: inputs.storageUsedMb === null ? unknown : String(inputs.storageUsedMb),
    storageQuotaMb: inputs.storageQuotaMb === null ? unknown : String(inputs.storageQuotaMb),
  };
}

/**
 * Engine + major version from a user-agent string.
 *
 * Reduced to two tokens on purpose (see the header): the full UA carries OEM
 * tokens, extension markers and device models, and a maintainer needs none of
 * it. Order matters — Chrome's UA also contains `Safari`, and Edge's contains
 * both, so the most specific match has to win or every Edge user reports Chrome.
 */
export function engineLabel(ua: string): string {
  const RULES: Array<[RegExp, string]> = [
    [/Edg\/(\d+)/, "Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/Firefox\/(\d+)/, "Firefox"],
    [/Chrome\/(\d+)/, "Chrome"],
    [/Version\/(\d+).*Safari/, "Safari"],
  ];
  for (const [re, name] of RULES) {
    const m = ua.match(re);
    if (m) return `${name} ${m[1]}`;
  }
  return "unknown";
}
