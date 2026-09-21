// Failure artifacts, and what must never be in one (MYND-574 task 105).
//
// `e2e/AGENTS.md`'s fourth non-negotiable is that **credentials never reach
// failure output** — no password, no account number, no recovery phrase in a
// screenshot, a log or a DOM dump. On the desktop lane that is largely honoured
// by what the harness captures; here it needs to be enforced, for two reasons:
//
// * a browser DOM dump is the natural artifact and it contains input values, so
//   the account number the scenario just typed is *in* it by default;
// * the account number is the one credential the web client takes as **pre-unlock
//   input** (`src/screens/AccountNumberEntry.tsx`), which is why the SYNC-7 leak
//   budget already forbids it in `data-*` attributes — the same reasoning applies
//   with more force to an artifact CI keeps.
//
// This module is PURE. It has no browser, no filesystem and no driver, so it is
// unit-testable on any machine — which is the point: it is the rule that would
// otherwise be written blind alongside the driver and never exercised, and a
// redactor that silently does nothing looks exactly like one that works.

/** A value the scenario handled that must not appear in any artifact. */
export interface Secret {
  /** What it is, for the placeholder. Never the value. */
  readonly kind: "password" | "account-number" | "phrase" | "pin";
  readonly value: string;
}

/** Placeholder written in a secret's place. Names the KIND so a failure is still
 *  diagnosable — "the account number was here" is useful; a blank is not. */
export function placeholder(kind: Secret["kind"]): string {
  return `«${kind} redacted»`;
}

/**
 * Every form of `value` an artifact could carry it in.
 *
 * The account number is the case that forces this: the user types
 * `MY-1234-…`, the UI reformats it as it goes, and the DOM may hold it grouped,
 * ungrouped, lower-cased, or URL-encoded inside an attribute. Redacting only the
 * literal the scenario passed in would leave three of those untouched — a
 * redactor that reports success while the value is still in the file.
 */
export function variantsOf(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const bare = trimmed.replace(/[\s-]/g, "");
  const seen = new Set<string>();
  for (const v of [trimmed, bare, trimmed.toLowerCase(), bare.toLowerCase()]) {
    if (v.length >= 4) seen.add(v);
    // The encoded form of the grouped shape; `encodeURIComponent` leaves the
    // bare one unchanged, so only add it when it actually differs.
    const enc = encodeURIComponent(v);
    if (enc !== v && enc.length >= 4) seen.add(enc);
  }
  // Longest first, so a short variant cannot cut a longer one in half and leave
  // its tail behind.
  return [...seen].sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of every secret with its placeholder.
 *
 * Case-insensitive by construction (the lower-cased variants are included) and
 * substring-based rather than token-based, because an artifact is not tokenised
 * text — a value can sit inside an attribute, a JSON string or a URL.
 */
export function redact(text: string, secrets: readonly Secret[]): string {
  let out = text;
  for (const secret of secrets) {
    for (const variant of variantsOf(secret.value)) {
      out = out.split(variant).join(placeholder(secret.kind));
    }
  }
  return out;
}

/**
 * Whether `text` still contains any secret — the assertion the harness runs
 * **after** redacting, before anything is written.
 *
 * Separate from [`redact`] on purpose. "I called the redactor" is not the
 * property; "the bytes about to be written contain no secret" is. Keeping the
 * check independent is what lets it catch a redactor that missed a form, which
 * is the failure that would otherwise ship silently.
 */
export function leaks(text: string, secrets: readonly Secret[]): Secret[] {
  const lower = text.toLowerCase();
  return secrets.filter((s) =>
    variantsOf(s.value).some((v) => lower.includes(v.toLowerCase())),
  );
}

/** Thrown instead of writing an artifact that still carries a secret. */
export class ArtifactLeakError extends Error {
  constructor(kinds: readonly Secret["kind"][]) {
    // The KINDS, never the values — an error message is output too.
    super(
      `refusing to write a failure artifact: it still contains ${kinds.join(", ")}. ` +
        `Redaction missed a form (e2e-web/support/artifacts.ts).`,
    );
    this.name = "ArtifactLeakError";
  }
}

/**
 * Redact, then verify, then hand back the bytes to write.
 *
 * The one entry point the artifact writer uses, so no call site can redact and
 * forget to check — the ordering IS the guarantee.
 */
export function safeArtifact(text: string, secrets: readonly Secret[]): string {
  const cleaned = redact(text, secrets);
  const remaining = leaks(cleaned, secrets);
  if (remaining.length > 0) {
    throw new ArtifactLeakError([...new Set(remaining.map((s) => s.kind))]);
  }
  return cleaned;
}
