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
// `MIN_ZXCVBN_SCORE = 3`) live here so every consumer (vault-creation
// `PasswordStep`, vault-recover `PasswordResetStep`, change-password
// `PasswordChangeForm`) imports the same numbers. Drift across forms
// is structurally impossible.

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Input } from "./primitives/Input";
import { Icon } from "./primitives/Icon";

/** Minimum password length enforced by every consumer (frontend gate). */
export const MIN_PASSWORD_LEN = 12;

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

const labelStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 600,
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
          gap: 12,
        }}
      >
        <label style={labelStyle}>{label}</label>
        {labelTrailing}
      </div>
      <div style={{ position: "relative" }}>
        <Input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          invalid={invalid}
          autoFocus={autoFocus}
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled}
          data-testid={testId}
          style={{ paddingRight: 36 }}
        />
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={show ? "Hide password" : "Show password"}
          disabled={disabled}
          style={{
            position: "absolute",
            right: 8,
            top: 7,
            background: "none",
            border: 0,
            color: "var(--fg-3)",
            cursor: disabled ? "default" : "pointer",
            padding: 4,
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
    })();
  }
  return zxcvbnFnPromise;
}

/**
 * Lazy-load zxcvbn-ts and evaluate the given password's strength.
 * Returns `{ ready, result }` where `ready` flips to `true` once the
 * dynamic-import resolves, and `result` is `null` while loading or
 * when `password` is empty. Idempotent across consumers.
 */
export function usePasswordStrength(password: string): {
  ready: boolean;
  result: PasswordStrengthResult | null;
} {
  const [zxcvbnFn, setZxcvbnFn] = useState<ZxcvbnFn | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadZxcvbn().then((fn) => {
      if (!cancelled) setZxcvbnFn(() => fn);
    });
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

  return { ready: zxcvbnFn !== null, result };
}
