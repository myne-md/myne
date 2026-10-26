// Single-field password primitive shared by every form that takes a
// password (create, recover, change). Provides:
//
//   - Input + eye toggle (caller owns `show` state so the parent can
//     coordinate visibility across multiple inputs — e.g., "Suggest
//     password" reveals new + confirm together).
//   - Optional caption + tone (caller computes; lets each consumer
//     decide what "tooShort" / "mismatch" / "Checking strength…"
//     means in its own context).
//   - Optional `labelTrailing` slot for a right-aligned helper button
//     (e.g., "Suggest password").
//
// **Lazy-loaded zxcvbn-ts strength evaluation** ships as the
// `usePasswordStrength` hook also exported from this file. The hook
// owns the dynamic-import (~140KB gzip stays out of Welcome bundle —
// arrives as a separate chunk on first password-form mount). Forms
// call the hook with the password value, get back `{ score, ready,
// warning, suggestion }`, and render `<PasswordStrength>` themselves
// in their own tree where they want the meter to land. The hook is
// idempotent across multiple consumers — Webpack/Vite caches the
// dynamic-imported module, so the second call returns the same
// promise.
//
// **Min-floor constants** (`MIN_PASSWORD_LEN = 12`,
// `MIN_ZXCVBN_SCORE = 3`) are re-exported from `client-core` so every consumer
// (vault-creation `PasswordStep`, vault-recover `PasswordResetStep`,
// change-password `PasswordChangeForm`) imports the same numbers, and so does
// MOBILE — which used to carry three copies of the floor and compare it in
// Unicode code units while this file compared USVs. Drift across forms is
// structurally impossible; the unit is impossible to get wrong through
// `passwordLength`. The docstrings and the reason live in
// `client-core/src/password-policy.ts`.
//
// Re-exported rather than moved-and-updated at every call site, which is the
// `@myne/dialect` shim shape: the consumers keep their import and the source of
// truth is one file.

import {
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Input } from "./primitives/Input";
import { Icon } from "./primitives/Icon";

export { MIN_PASSWORD_LEN, passwordLength } from "@myne/client-core/password-policy";

/** Minimum zxcvbn score (0-4) required to pass the strength gate. */
export const MIN_ZXCVBN_SCORE = 3;

/** zxcvbn produces an integer score in [0, 4]. */
export type ZxcvbnScore = 0 | 1 | 2 | 3 | 4;

/** Tone for the optional caption rendered below the input. */
export type CaptionTone = "muted" | "danger" | "pending";

interface ZxcvbnRawResult {
  score: ZxcvbnScore;
  feedback: {
    warning: string;
    suggestions: string[];
  };
}

type ZxcvbnFn = (password: string) => ZxcvbnRawResult;

/** Strength evaluation surface returned by `usePasswordStrength`. */
export interface PasswordStrengthResult {
  /** zxcvbn integer score 0–4. */
  score: ZxcvbnScore;
  /** Optional zxcvbn warning string (may be empty). */
  warning?: string;
  /** First zxcvbn suggestion (may be undefined if zxcvbn returned none). */
  suggestion?: string;
}

/** Props accepted by `PasswordInput`. */
export interface PasswordInputProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Show password as plaintext (caller-owned state). */
  show: boolean;
  /** Toggle plaintext visibility. */
  onToggleShow: () => void;
  /** Render the input with the danger-tone border. */
  invalid?: boolean;
  /** Optional caption rendered below the input. */
  caption?: string;
  /** Tone for the optional caption (default: muted). */
  captionTone?: CaptionTone;
  /** Auto-focus the input on mount. Default: false. */
  autoFocus?: boolean;
  /** Right-aligned content next to the label (e.g., "Suggest password" button). */
  labelTrailing?: ReactNode;
  /** Disable the input + eye toggle (e.g., during in-flight submit). */
  disabled?: boolean;
  /** Stable E2E selector rendered as `data-testid` on the INNER input
   *  element (SYNC-8) — the input is what scenarios type into/assert. */
  testId?: string;
}

// Sentence case, the label every first-run form uses (Welcome through the
// join screen). The uppercase tracked label this replaced was the one caps
// line left on those screens once the rest had moved.
const labelStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

/**
 * Single-field password primitive. See module docstring for the
 * design rationale + usage pattern across the three consuming forms.
 */
export function PasswordInput({
  label,
  value,
  onChange,
  show,
  onToggleShow,
  invalid,
  caption,
  captionTone = "muted",
  autoFocus,
  labelTrailing,
  disabled,
  testId,
}: PasswordInputProps) {
  const { t } = useTranslation();
  // The visible label and the input are siblings in different rows, so the
  // `<label>` had no `htmlFor` and the field had NO accessible name: a screen
  // reader announced a bare "password, edit text" for every field in every
  // password flow (myne-md/myne#845, found by the catalogue's axe gate). One
  // `useId` associates them, so the announced name IS the visible one and the
  // two cannot drift.
  const inputId = useId();
  const captionColor =
    captionTone === "danger" ? "var(--danger)" : "var(--fg-3)";
  const captionFontStyle = captionTone === "pending" ? "italic" : "normal";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "var(--space-3)",
        }}
      >
        <label htmlFor={inputId} style={labelStyle}>
          {label}
        </label>
        {labelTrailing}
      </div>
      <div style={{ position: "relative" }}>
        <Input
          id={inputId}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          invalid={invalid}
          autoFocus={autoFocus}
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled}
          data-testid={testId}
          style={{ paddingInlineEnd: 36 }}
        />
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={show ? t("password.input.hide") : t("password.input.show")}
          disabled={disabled}
          style={{
            position: "absolute",
            insetInlineEnd: 8,
            top: 7,
            background: "none",
            border: 0,
            color: "var(--fg-3)",
            cursor: disabled ? "default" : "pointer",
            padding: "var(--space-1)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={show ? "eye-off" : "eye"} size={14} />
        </button>
      </div>
      {caption && (
        <div
          style={{
            fontSize: 12,
            color: captionColor,
            fontStyle: captionFontStyle,
          }}
        >
          {caption}
        </div>
      )}
    </div>
  );
}

// Module-scope memoized loader. The dynamic-import + setOptions runs
// once per app session regardless of how many forms mount. Without
// this, `zxcvbnOptions.setOptions(...)` re-fires and a fresh loader
// promise is built on every consumer mount even though Vite caches
// the underlying module bytes.
//
// **A REJECTED promise is not memoized** (2026-10-24). It used to be, and the
// consequence was a surface with no way out: the three chunks below are fetched
// lazily, so a chunk that cannot be loaded (a stale page asking for the hashes of
// a build that is no longer served — routine after a web deploy — a blocked
// request, an offline start) rejected once, the rejection was cached for the
// process lifetime, and every consumer sat on "Checking strength…" with its
// submit disabled and nothing said about why. Clearing the memo is what makes a
// later mount try again; `usePasswordStrength` reports the failure so the form can
// stop pretending to be busy.
let zxcvbnFnPromise: Promise<ZxcvbnFn> | null = null;
function loadZxcvbn(): Promise<ZxcvbnFn> {
  if (!zxcvbnFnPromise) {
    zxcvbnFnPromise = (async () => {
      const [core, common, en] = await Promise.all([
        import("@zxcvbn-ts/core"),
        import("@zxcvbn-ts/language-common"),
        import("@zxcvbn-ts/language-en"),
      ]);
      core.zxcvbnOptions.setOptions({
        translations: en.translations,
        graphs: common.adjacencyGraphs,
        dictionary: { ...common.dictionary, ...en.dictionary },
      });
      return core.zxcvbn as unknown as ZxcvbnFn;
    })().catch((error: unknown) => {
      zxcvbnFnPromise = null;
      throw error;
    });
  }
  return zxcvbnFnPromise;
}

/**
 * Lazy-load zxcvbn-ts and evaluate the given password's strength.
 * Returns `{ ready, result, unavailable }`: `ready` flips to `true` once the
 * dynamic-import resolves, `result` is `null` while loading or when `password`
 * is empty, and `unavailable` is `true` once the import has FAILED, which is a
 * different state from still-loading and the two must not be rendered the same
 * way. Idempotent across consumers.
 */
export function usePasswordStrength(password: string): {
  ready: boolean;
  result: PasswordStrengthResult | null;
  /** The evaluator could not be loaded. Distinct from `!ready`: one is "not yet",
   *  the other is "not ever, this time". */
  unavailable: boolean;
} {
  const [zxcvbnFn, setZxcvbnFn] = useState<ZxcvbnFn | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadZxcvbn().then(
      (fn) => {
        if (!cancelled) setZxcvbnFn(() => fn);
      },
      () => {
        if (!cancelled) setUnavailable(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const result = useMemo<PasswordStrengthResult | null>(() => {
    if (!zxcvbnFn || password.length === 0) return null;
    const raw = zxcvbnFn(password);
    return {
      score: raw.score,
      warning: raw.feedback.warning || undefined,
      suggestion: raw.feedback.suggestions[0],
    };
  }, [password, zxcvbnFn]);

  return { ready: zxcvbnFn !== null, result, unavailable };
}
