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
// * **No filesystem or OPFS path.** On the DENY list (`src-tauri/AGENTS.md`) for
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
  // The vault's own state, in five bounded tokens (myne-md/myne#1003). They sit right
  // after the failure code because that is the causal order a reader follows: which
  // build, which failure, and what the vault looked like while it happened. Every value
  // is a closed enum token (no identifier, no path, no key material), which is what the
  // allowlist above is for.
  "vaultGeneration",
  "vaultAuthority",
  "vaultBinding",
  "vaultKeyAtRest",
  "vaultSession",
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
  /** The commit the running build came from, or `null` when this build has no
   *  reading at all (a source tarball with no git history, or an image with no
   *  `git`), which omits the line rather than printing a placeholder. */
  readonly commit: string | null;
  readonly bundleHash: string | null;
  /** The bounded, closed-enum failure label — never a message string. */
  readonly failureCode: string;
  /**
   * The vault doctor's five facts (myne-md/myne#1003), each already a closed token.
   * `null` when there is no vault to diagnose or the read failed, which omits the line,
   * the same rule the storage figures follow, and for the same reason: a placeholder in
   * a block a user pastes reads as a broken app.
   */
  readonly vaultGeneration: string | null;
  readonly vaultAuthority: string | null;
  readonly vaultBinding: string | null;
  readonly vaultKeyAtRest: string | null;
  readonly vaultSession: string | null;
  /** Engine + major version, e.g. `Chrome 140`. Never the full UA string.
   *  `null` when the UA is unrecognisable, which omits the line. */
  readonly engine: string | null;
  readonly crossOriginIsolated: boolean;
  /** `navigator.storage.estimate()` totals, in whole MB; `null` when unavailable,
   *  which omits the line rather than printing a placeholder. */
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
  return DIAGNOSTIC_FIELDS.flatMap((k) =>
    k in record ? [`${k}: ${record[k]!}`] : [],
  ).join("\n");
}

/**
 * The same content as a record, for the test that pins the key set.
 *
 * A field whose reading the client could not take is ABSENT, not a placeholder
 * (issue #970, item 15). This block used to print `bundleHash: unknown` and two
 * `unknown` storage figures on every desktop build, and four `unknown`s out of
 * nine lines is what a user reports as a broken app; a support reader cannot
 * tell a placeholder from a value either. Omitting the line states the same
 * thing once, and the panel above no longer owes a paragraph explaining why its
 * own output looks broken.
 */
export function diagnosticRecord(inputs: DiagnosticInputs): Partial<Record<DiagnosticField, string>> {
  // Built in `DIAGNOSTIC_FIELDS` order and then filtered, so the key order IS
  // the rendered order and the allowlist test still reads as an equality rather
  // than a set comparison.
  const values: Record<DiagnosticField, string | null> = {
    version: inputs.version,
    channel: inputs.channel,
    commit: inputs.commit,
    bundleHash: inputs.bundleHash,
    failureCode: inputs.failureCode,
    vaultGeneration: inputs.vaultGeneration,
    vaultAuthority: inputs.vaultAuthority,
    vaultBinding: inputs.vaultBinding,
    vaultKeyAtRest: inputs.vaultKeyAtRest,
    vaultSession: inputs.vaultSession,
    engine: inputs.engine,
    crossOriginIsolated: String(inputs.crossOriginIsolated),
    storageUsedMb: inputs.storageUsedMb === null ? null : String(inputs.storageUsedMb),
    storageQuotaMb: inputs.storageQuotaMb === null ? null : String(inputs.storageQuotaMb),
  };
  const record: Partial<Record<DiagnosticField, string>> = {};
  for (const field of DIAGNOSTIC_FIELDS) {
    const value = values[field];
    if (value !== null && value !== "") record[field] = value;
  }
  return record;
}

/**
 * The WebView a desktop build hosts the shared tree in.
 *
 * Named by the CALLER rather than inferred, because the UA cannot tell them
 * apart: a macOS WKWebView and a Safari tab send nearly the same string, and a
 * WebKitGTK view dresses as Safari outright.
 */
export type HostWebView = "WKWebView" | "WebKitGTK" | "WebView2" | "Android WebView";

/**
 * Bytes → whole MB, or `null` (which omits the line).
 *
 * Rounded deliberately: a byte-exact figure is a finer reading of the user's
 * storage than a support block needs. Two cases are NOT rounding, though, and
 * both used to reach the pasted text as facts (myne-md/myne#556):
 *
 *   * a NON-FINITE reading. `typeof NaN === "number"`, so a partial or
 *     in-progress `estimate()` passed the old guard and `String(NaN)` landed in
 *     the block as the literal `NaN`. A field saying NaN says the app is broken
 *     in a way it is not, and the honest answer for an unusable reading already
 *     exists one line down: no line at all.
 *   * a NON-EMPTY store rounding to `0`. Anything under 512 KB — a small but
 *     real vault — came out as a bare `0`, which is not a coarse version of
 *     "some", it is the one value that says the opposite. The block exists to
 *     be acted on, and `storageUsedMb: 0` is what a maintainer uses to rule
 *     storage out of an investigation.
 *
 * So sub-megabyte usage reports as 1 rather than 0. That over-states by less
 * than a megabyte, at a granularity where a megabyte is already the unit — and
 * it is the only direction that cannot mislead: "at least a bit" is true of
 * every non-empty store, "none" is true of none of them.
 */
export function mb(bytes: number | undefined): number | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  const whole = Math.round(bytes / (1024 * 1024));
  return whole === 0 && bytes > 0 ? 1 : whole;
}

/**
 * Engine + major version from a user-agent string.
 *
 * Reduced to two tokens on purpose (see the header): the full UA carries OEM
 * tokens, extension markers and device models, and a maintainer needs none of
 * it. Order matters — Chrome's UA also contains `Safari`, and Edge's contains
 * both, so the most specific match has to win or every Edge user reports Chrome.
 */
export function engineLabel(ua: string, webview: HostWebView | null = null): string | null {
  const webkit = /AppleWebKit\/(\d+)/.exec(ua);
  // The host wins over every rule below. Issue #970 item 15 was first answered
  // by adding a WebKit rule LAST, which fixed a UA with no Safari token and
  // missed the one that matters: a WebKitGTK view sends a real
  // `Version/… Safari/…` tail, matched the Safari rule, and told a desktop user
  // they were running Safari. The app knows which view it is in, so it says so.
  if (webview) {
    const version =
      webview === "WebView2"
        ? (/Chrome\/(\d+)/.exec(ua)?.[1] ?? webkit?.[1] ?? null)
        : (webkit?.[1] ?? null);
    return version ? `${webview} ${version}` : webview;
  }
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
  // The browser fallback for a WebKit UA: last, because every Chromium UA also
  // carries `AppleWebKit/537.36` and an earlier rule would relabel every Chrome
  // and Edge user.
  if (webkit) return `WebKit ${webkit[1]}`;
  // `null`, never the word "unknown": the caller omits the line instead.
  return null;
}
