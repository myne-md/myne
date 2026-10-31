import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { strengthLevel } from "../../lib/password-strength";
import type { CSSProperties, ReactNode } from "react";
import {
  Screen,
  ScreenScroll,
  FlowHeader,
  Title,
  Lead,
  FooterBar,
  Button,
  StrengthMeter,
  RecoveryGrid,
  AccountNumber,
  Checkbox,
  Icon,
  MyneMark,
  Banner,
  BlockingOverlay,
} from "../../components";
import {
  beginVaultCreation,
  commitVaultCreation,
  cancelVaultCreation,
  unlockWithPassword,
} from "../../lib/commands";
import { HAS_TAURI } from "../../lib/app-window";
import { seedExampleVault } from "../../lib/exampleVault";
import { LOST_BOTH_SECRETS_SENTENCE } from "../../lib/load-bearing-copy";
import {
  copySecretToClipboard,
  saveSecretToDocuments,
  secretSaveMessage,
} from "../../lib/secret-export";
import { canHoldSecretOnClipboard } from "../../lib/clipboardTransport";
import { setVaultLabel } from "../../lib/prefs";
import { pickChallenge, phraseTypeBackMatches } from "../../lib/phraseChallenge";
// The kit's file format, ALIASED to the desktop implementation rather than
// re-derived here (`mobile/vite.config.ts` carries the reason): a kit saved on a
// phone is read back by the recovery flow on a computer, so the document has to
// be one function.
import { recoveryKitText } from "@myne/recovery-kit";
import type { CreateVaultFlowProps } from "./types";

// Browser-dev placeholders (no Tauri host → no IPC). Let the multi-step flow
// stay fully navigable under `pnpm dev`; the real backend runs `pnpm tauri dev`.
const PLACEHOLDER_PHRASE = [
  "ribbon", "kernel", "voyage", "marble", "harvest", "cobalt",
  "thistle", "quarry", "lantern", "pebble", "summit", "cedar",
  "anchor", "bishop", "candle", "dolphin", "ember", "falcon",
  "gravel", "hazel", "indigo", "jasmine", "kettle", "willow",
];
const PLACEHOLDER_ACCOUNT = "MY-4F2A-9C17-8E2D-1B5F-K";
const PLACEHOLDER_SESSION = "dev-session-token";
const PLACEHOLDER_VAULT_ID = "dev-vault";

type Step =
  | "briefing"
  /** What to call this vault (myne-md/myne#468 K10). Desktop's twin: `name`. */
  | "name"
  | "password"
  | "encrypting"
  /**
   * The recovery kit: the phrase and the account number on ONE screen, styled as
   * the file it saves. Replaces the former `phrase` step and the `account` step
   * that followed the challenge (myne-md/myne#468 K11/K13).
   */
  | "kit"
  | "typeback"
  | "committing"
  | "ready"
  | "unlocking";

/** Read the `.kind` discriminant off a rejected invoke into a copy KEY (resolved
 *  with `t()` at the render site — never at module top level). */
function beginErrorMessage(e: unknown): string {
  const kind = (e as { kind?: string } | null)?.kind;
  if (kind === "WeakNewPassword") return "createVault.beginWeakPassword";
  return "createVault.beginGeneric";
}

// ── Shared bordered input shell (mirrors the design Field / PasswordField) ─────
function FieldShell({
  focused,
  error = false,
  height = 52,
  children,
  style,
}: {
  focused: boolean;
  error?: boolean;
  height?: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const borderColor = error ? "var(--danger)" : focused ? "var(--accent)" : "var(--line-2)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height,
        border: `${focused || error ? 1.5 : 1}px solid ${borderColor}`,
        borderRadius: 6,
        background: "var(--bg-1)",
        padding: "0 14px",
        boxShadow: focused ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── Editable password row (masked monospace + reveal eye) ─────────────────────
function PasswordRow({
  value,
  onChange,
  revealed,
  onToggleReveal,
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  revealed: boolean;
  onToggleReveal: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  return (
    <FieldShell focused={focused}>
      <input
        type={revealed ? "text" : "password"}
        value={value}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: 1,
          minWidth: 0,
          border: "none",
          outline: "none",
          background: "transparent",
          fontFamily: "var(--font-mono)",
          fontSize: revealed ? 16 : 14,
          letterSpacing: revealed ? "0" : "0.14em",
          color: "var(--fg-1)",
        }}
      />
      <button
        type="button"
        onClick={onToggleReveal}
        aria-label={revealed ? t("password.input.hide") : t("password.input.show")}
        style={{ border: "none", background: "transparent", padding: 0, marginInlineStart: 8, cursor: "pointer", display: "flex" }}
      >
        <Icon name={revealed ? "eye-off" : "eye"} size={20} color="var(--fg-3)" strokeWidth={1.6} />
      </button>
    </FieldShell>
  );
}

// ── Editable confirm row (masked, check when it matches) ──────────────────────
function ConfirmRow({
  value,
  onChange,
  match,
}: {
  value: string;
  onChange: (v: string) => void;
  match: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <FieldShell focused={focused}>
      <input
        type="password"
        value={value}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: 1,
          minWidth: 0,
          border: "none",
          outline: "none",
          background: "transparent",
          fontFamily: "var(--font-mono)",
          fontSize: 14,
          letterSpacing: "0.14em",
          color: "var(--fg-1)",
        }}
      />
      {match && <Icon name="check" size={14} color="var(--success)" strokeWidth={2} />}
    </FieldShell>
  );
}

// ── Vault-name field (myne-md/myne#468) ───────────────────────────────────────
//
// Its own row rather than `Field` from `../../components`: this file already owns
// `FieldShell` and its two siblings (`PasswordRow`, `ConfirmRow`), so a fourth
// row on the same shell keeps the four fields of this flow identical by
// construction. Sans rather than mono — a vault name is prose, unlike a password
// or a BIP-39 word.
function NameRow({
  value,
  onChange,
  placeholder,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onSubmit: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <FieldShell focused={focused}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        autoCorrect="off"
        spellCheck={false}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        // The software keyboard's Go/Done key advances the step, so naming the
        // vault does not need the keyboard dismissed first.
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
        data-testid="create-vault.name-input"
        style={{
          flex: 1,
          minWidth: 0,
          border: "none",
          outline: "none",
          background: "transparent",
          fontSize: "var(--text-md)",
          color: "var(--fg-1)",
        }}
      />
    </FieldShell>
  );
}

// ── Editable type-back word field ─────────────────────────────────────────────
function WordEntry({
  position,
  value,
  onChange,
  error,
}: {
  position: number;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)", marginBottom: 6 }}>
        {t("createVault.wordNumber", { position })}
      </div>
      <FieldShell focused={focused} error={!!error} height={50}>
        <input
          // Pinned left-to-right for the same reason `RecoveryGrid` is: the words
          // are frozen English (`protocol.md` §7), and under an RTL locale a
          // logical-direction field puts the caret and the typed word on the
          // opposite side from where the grid showed them, on the one screen
          // whose job is to catch a transcription error.
          dir="ltr"
          value={value}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            background: "transparent",
            fontFamily: "var(--font-mono)",
            fontSize: 16,
            fontWeight: 500,
            color: "var(--fg-1)",
          }}
        />
      </FieldShell>
      {error && (
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6, color: "var(--danger)", fontSize: 13 }}>
          <Icon name="info" size={14} color="var(--danger)" strokeWidth={1.4} />
          {error}
        </div>
      )}
    </div>
  );
}

// ── Briefing acknowledgement row (interactive CheckRow) ───────────────────────
function AckRow({
  checked,
  onToggle,
  children,
  why,
  whyOpen,
  onToggleWhy,
  last,
}: {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
  why?: ReactNode;
  whyOpen?: boolean;
  onToggleWhy?: () => void;
  last?: boolean;
}) {
  const { t } = useTranslation();
  // The curve follows the direction, as it does on the desktop row and in
  // NoteList's `DisclosureWrapper`: `--ease-out` leads an entrance and
  // `--ease-standard` an exit.
  const whyEasing = whyOpen ? "var(--ease-out)" : "var(--ease-standard)";
  // `useId`, not a constant: this component renders once per acknowledgement
  // on the same screen, and two labels sharing a DOM id would point every
  // `aria-labelledby` at whichever rendered first.
  const ackLabelId = useId();
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "14px 0",
        borderTop: "1px solid var(--line-1)",
        borderBottom: last ? "1px solid var(--line-1)" : undefined,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={checked}
        // Named by the sentence beside it (myne#728, task 16). The button
        // contains only a `Checkbox` glyph, so before this it was an
        // `aria-pressed` toggle with NO accessible name: a screen reader read
        // "pressed, button" and the user had to guess what they were agreeing
        // to. The text is not made a second control, because this one already
        // is one; its own onClick stays as a mouse/touch convenience.
        aria-labelledby={ackLabelId}
        style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "flex", flex: "none" }}
      >
        <Checkbox checked={checked} />
      </button>
      <div style={{ flex: 1 }}>
        <div
          id={ackLabelId}
          onClick={onToggle}
          style={{ fontSize: 15, lineHeight: 1.45, color: "var(--fg-1)", cursor: "pointer" }}
        >
          {children}
        </div>
        {why && (
          <>
            <button
              type="button"
              onClick={onToggleWhy}
              aria-expanded={whyOpen}
              data-testid="create-vault.briefing-why"
              style={{
                marginTop: 8,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                color: "var(--accent)",
                fontSize: 13,
                fontWeight: 500,
                border: "none",
                background: "transparent",
                padding: 0,
                cursor: "pointer",
              }}
            >
              {t("vaultCreation.briefing.why")}
              <Icon
                name="chevron-down"
                size={11}
                color="var(--accent)"
                strokeWidth={1.6}
                style={{
                  // One glyph turned over in place (myne-md/myne#868): swapping
                  // chevron-up/chevron-down remounts the node, and a remount
                  // cannot animate.
                  transform: whyOpen ? "rotate(180deg)" : "rotate(0deg)",
                  transition: `transform var(--duration-base) ${whyEasing}`,
                }}
              />
            </button>
            <WhyDisclosure open={!!whyOpen}>
              <div
                data-testid="create-vault.briefing-why-text"
                style={{
                  marginTop: 8,
                  background: "var(--bg-2)",
                  border: "1px solid var(--line-1)",
                  borderRadius: 6,
                  padding: "10px 12px",
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: "var(--fg-2)",
                }}
              >
                {why}
              </div>
            </WhyDisclosure>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * How long a collapsing body stays mounted after `open` flips false: one
 * `--duration-base` transition (180ms) plus the same 60ms slack the desktop
 * row's constant takes, so the node leaves the DOM only once the motion has
 * settled. The phone's global `prefers-reduced-motion` rule zeroes the
 * TRANSITION, but this deferral is a timer, so the reduced-motion arm below is
 * what keeps it out of the way for those users.
 */
const WHY_SETTLE_MS = 240;

/**
 * The animated "Why?" body (myne-md/myne#868), mirroring `WhyDisclosure` in the
 * desktop `src/screens/vault-creation/BriefingStep.tsx`, which carries the long
 * rationale: a `grid-template-rows` 1fr<->0fr track plus an opacity fade, both
 * on `--duration-base`, with the curve per direction (`--ease-out` opening,
 * `--ease-standard` closing), an inner box clipped by `min-height: 0` +
 * `overflow: hidden`, a deferred unmount so the collapse can finish, and an
 * instant path under `prefers-reduced-motion`.
 *
 * The two rows differ in layout only, so the mobile row needs none of the
 * desktop row's gap surgery: its children stack in a block, and the body's own
 * `marginTop` sits INSIDE the clipped box, which is what keeps a collapsing
 * body the same size as an absent one.
 */
function WhyDisclosure({ open, children }: { open: boolean; children: ReactNode }) {
  // `mounted` = the node is in the DOM; `shown` = its animated (open) value.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useLayoutEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    if (open) {
      // Already open, which is the mount run whose initial state matches.
      if (shown) return;
      setMounted(true);
      if (reduce) {
        setShown(true);
        return;
      }
      // Mount at the collapsed value, then flip on the next frame so the
      // property change has a value to transition FROM.
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }

    // A row that was never opened has nothing mounted to animate out.
    if (!mounted) return;
    setShown(false);
    if (reduce) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), WHY_SETTLE_MS);
    return () => clearTimeout(timer);
    // `[open]` alone, as on the desktop twin: this reacts to a CHANGE, so the
    // reads above are the committed values at that moment, and reacting to them
    // would re-enter on this effect's own updates.
  }, [open]);

  if (!mounted) return null;
  const easing = shown ? "var(--ease-out)" : "var(--ease-standard)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: shown ? "1fr" : "0fr",
        gridTemplateColumns: "minmax(0, 1fr)",
        minWidth: 0,
        opacity: shown ? 1 : 0,
        transition: `grid-template-rows var(--duration-base) ${easing}, opacity var(--duration-base) ${easing}`,
      }}
    >
      <div style={{ minHeight: 0, minWidth: 0, overflow: "hidden" }}>{children}</div>
    </div>
  );
}

// Small uppercase field label (mirrors the static FieldLabel).
function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--fg-3)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

/** Wordmark: mark + "myne" (ready screen). */
function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <MyneMark size={size} radius={6} />
      <span style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)" }}>myne</span>
    </div>
  );
}

/**
 * Vault creation — the wired multi-step counterpart of the static onboarding
 * screens (OB-01…OB-06). Secrets (password, 24-word phrase) live in refs and
 * are wiped on every exit + on unmount; an uncommitted session is best-effort
 * cancelled on unmount.
 */

/**
 * The phrase step's action buttons (Copy, Save to file).
 *
 * Extracted rather than duplicated when myne-md/myne#455 added the second one.
 * Copying the neighbour's inline literals would have grown this file's
 * hardcoded-value count, which `check-token-adoption.mjs` ratchets, correctly:
 * an inline literal outranks every stylesheet, so it is unreachable to any
 * custom theme, permanently. One shared object keeps the two buttons identical
 * by construction AND leaves the count where it was.
 */
const PHRASE_ACTION_STYLE = { marginTop: 14, height: 40, fontSize: 13 } as const;

/** The recovery kit's sheet (myne-md/myne#468): page-coloured, bordered and
 *  lifted, so it reads as a document rather than as another recessed card.
 *  Hoisted out of the render for the same reason `PHRASE_ACTION_STYLE` is — an
 *  inline object here would add to the hardcoded-value count the token ratchet
 *  holds, in a file that is already near it. */
const KIT_SHEET_STYLE = {
  marginTop: "var(--space-4)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  padding: "var(--space-4)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3)",
  boxShadow: "var(--shadow-1)",
} as const;

/** The sheet's internal hairlines. A `<div>` rather than `<hr>`: `<hr>` carries a
 *  `separator` role, and three of them inside one document is chrome a screen
 *  reader reads out rather than structure it uses. */
const KIT_RULE_STYLE = { height: 1, background: "var(--line-1)" } as const;

/** A kit section's label: what this secret is, and what it is FOR. */
const KIT_SECTION_LABEL_STYLE = {
  margin: 0,
  fontSize: "var(--text-sm)",
  lineHeight: 1.45,
  color: "var(--fg-2)",
} as const;

export function CreateVaultFlow({
  briefing,
  onCancel,
  onAutoUnlockSuccess,
  onAutoUnlockFailed,
}: CreateVaultFlowProps) {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState<Step>(briefing ? "briefing" : "name");

  // The vault's name, from the step before the password (myne-md/myne#468).
  // NOT secret, so plain state rather than a ref, and it is applied as the
  // vault's label after the auto-unlock — `prefs|vault_set_label` is
  // unlock-gated, and during creation there is no unlocked slot to write into.
  const [vaultName, setVaultName] = useState("");

  // Belt and braces on top of `copyMsg` being its own state: clear BOTH messages
  // whenever the step changes, so no confirmation can cross a step boundary and
  // be read as the result of an action on the next screen. `fileMsg` had exactly
  // that shape, never reset, rendered by two steps, and this is the general
  // fix rather than one more per-message reset someone can forget.
  useEffect(() => {
    setCopyMsg(null);
    setFileMsg(null);
  }, [step]);

  // OB-01 acknowledgements
  const [acks, setAcks] = useState<boolean[]>([false, false, false]);
  const [why2Open, setWhy2Open] = useState(false);
  const [why3Open, setWhy3Open] = useState(false);

  // OB-02 password (authoritative secret in pwdRef; `pwd` mirrors for render).
  const pwdRef = useRef("");
  const [pwd, setPwd] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [beginError, setBeginError] = useState<string | null>(null);

  // Session-derived material.
  const phraseRef = useRef<string[]>([]);
  const sessionRef = useRef<string | null>(null);
  const vaultIdRef = useRef<string | null>(null);
  const committedRef = useRef(false);
  const startedRef = useRef(false);
  const [account, setAccount] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);

  // OB phrase reveal
  const [showSecondHalf, setShowSecondHalf] = useState(false);

  // OB-04 type-back
  const [challenge, setChallenge] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(["", "", "", ""]);

  // Feedback for the kit's "Save to file" action.
  const [fileMsg, setFileMsg] = useState<string | null>(null);
  // The copy outcome keeps its OWN state, not `fileMsg`, and the reason is worth
  // keeping now that the two steps have merged into one.
  //
  // `fileMsg` used to be rendered by the phrase step AND the account step and was
  // never reset, so a phrase-copy confirmation stayed on screen and reappeared
  // two steps later directly under the ACCOUNT NUMBER, reading as a confirmation
  // that the account number had been copied and was expiring — a false statement
  // about a bearer token. The merge removes the two-step distance but not the
  // argument: Copy and Save are still two affordances with two claims, and one
  // field for both is how a stale confirmation gets read as a fresh one.
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  // Tier 1's render gate (myne-md/myne#455). Starts `false`, so on the frame
  // before the probe answers the button is ABSENT rather than present, a
  // control that appears and then vanishes on an Android phone would be worse
  // than one that never appeared.
  const [canCopyPhrase, setCanCopyPhrase] = useState(false);
  useEffect(() => {
    let live = true;
    void canHoldSecretOnClipboard().then(
      (ok) => {
        if (live) setCanCopyPhrase(ok);
      },
      () => {
        // The probe failed, so this OS's answer is unknown. Unknown resolves to
        // NO: the gate exists to avoid implying a guarantee, and an unanswered
        // question is not a yes.
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const wipeSecrets = () => {
    pwdRef.current = "";
    phraseRef.current = [];
  };

  // Unmount: wipe secrets + best-effort cancel an uncommitted session.
  useEffect(() => {
    return () => {
      wipeSecrets();
      if (HAS_TAURI && sessionRef.current && !committedRef.current) {
        void cancelVaultCreation(sessionRef.current).catch(() => {});
      }
    };
  }, []);

  // OB-03 encrypting: derive keys + mint phrase/account on first entry.
  useEffect(() => {
    if (step !== "encrypting" || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        if (HAS_TAURI) {
          const res = await beginVaultCreation(pwdRef.current);
          if (cancelled) return;
          // `null` means the vault was born under a person identity, whose
          // generation retires the vault phrase (myne-md/myne#911 task 5). This
          // client's person plane is live (task 12), so the arm is REACHED
          // whenever the user holds an identity, not held open for a later task:
          // a person-born vault skips the kit and the type-back entirely and
          // commits straight from here.
          phraseRef.current = res.phrase ?? [];
          sessionRef.current = res.session_token;
          setAccount(res.account_number);
          if (res.phrase === null) {
            void commit();
            return;
          }
        } else {
          phraseRef.current = [...PLACEHOLDER_PHRASE];
          sessionRef.current = PLACEHOLDER_SESSION;
          setAccount(PLACEHOLDER_ACCOUNT);
        }
        if (cancelled) return;
        setStep("kit");
      } catch (e) {
        if (cancelled) return;
        startedRef.current = false; // allow a retry from the password step
        setBeginError(beginErrorMessage(e));
        setStep("password");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  // The pending clipboard auto-clear. `copySecretToClipboard` returns a cancel
  // its caller MUST invoke on unmount — otherwise the timer's closure keeps the
  // account number (a bearer token) alive in the JS heap for the full 30 s.
  const clipboardCancelRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      clipboardCancelRef.current?.();
      clipboardCancelRef.current = null;
    },
    [],
  );

  const setPassword = (v: string) => {
    pwdRef.current = v;
    setPwd(v);
  };

  const strength = strengthLevel(pwd);
  const passwordValid = pwd.length >= 8 && pwd === confirm;
  const confirmMatch = confirm.length > 0 && pwd === confirm;

  const { matches: corrects, allCorrect } = phraseTypeBackMatches(
    phraseRef.current,
    challenge,
    answers,
  );

  // ── Handlers ────────────────────────────────────────────────────────────────
  const startTypeBack = () => {
    setChallenge(pickChallenge());
    setAnswers(["", "", "", ""]);
    setStep("typeback");
  };

  const commit = async () => {
    setCommitError(null);
    setStep("committing");
    try {
      if (HAS_TAURI) {
        vaultIdRef.current = await commitVaultCreation(sessionRef.current ?? "");
      } else {
        vaultIdRef.current = PLACEHOLDER_VAULT_ID;
      }
      committedRef.current = true;
      setStep("ready");
    } catch {
      // A person-born vault has NO phrase (`phraseRef.current` is empty), so the
      // type-back step is a trap there: the challenge draws four positions, every
      // word is compared against a word that does not exist, `allCorrect` can
      // never become true and `backToPhrase` opens a kit around an empty grid.
      // The desktop reducer returns to the password step for exactly this case,
      // and the two clients must not disagree about a recovery path
      // (myne-md/myne#911 review).
      setCommitError(t("createVault.commitError"));
      setStep(phraseRef.current.length === 0 ? "password" : "typeback");
    }
  };

  const openVault = async () => {
    setStep("unlocking");
    const id = vaultIdRef.current ?? undefined;
    try {
      if (HAS_TAURI) await unlockWithPassword(pwdRef.current, id);
      wipeSecrets();
      // The name from the first step becomes the vault's label, and it has to
      // happen HERE: `prefs|vault_set_label` writes under the active vault's
      // `prefs_key`, so it is unlock-gated and the line above is what unlocks.
      // Best-effort, like `seedExampleVault` below and for the same reason: the
      // vault is open, so a failed rename must not route a successfully unlocked
      // user to the unlock-failed path. An empty name leaves the picker's neutral
      // fallback, which is the right answer, so nothing is written for one.
      if (HAS_TAURI && vaultName.trim().length > 0) {
        await setVaultLabel(vaultName.trim()).catch(() => {});
      }
      // Seed the first-run example vault now the new vault is unlocked
      // (note_create requires an unlocked slot). The note SET comes from the
      // shared `@myne/dialect/exampleVault` builder, i.e. the same one desktop
      // seeds, so both clients hand a new user the same first run
      // (myne-md/myne#960; supersedes the MYND-118 Welcome note).
      // Best-effort: seedExampleVault never throws, so a failure here can't
      // bounce a successfully-unlocked user to the unlock-failed path.
      if (HAS_TAURI) await seedExampleVault();
      onAutoUnlockSuccess(id);
    } catch {
      wipeSecrets();
      onAutoUnlockFailed(id);
    }
  };

  // What Save writes and what Copy puts on the clipboard: the same bytes, from
  // the same shared function the desktop uses, so a kit saved on a phone is the
  // document the recovery flow on a computer expects (myne-md/myne#468).
  const kitText = (): string =>
    recoveryKitText({
      vaultName,
      savedOn: new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(
        new Date(),
      ),
      phrase: phraseRef.current,
      accountNumber: account,
      labels: {
        title: t("vaultCreation.kit.documentTitle"),
        phraseHeading: t("vaultCreation.kit.phraseFor"),
        accountHeading: t("vaultCreation.kit.accountFor"),
      },
    });


  // Tier 1: the recovery KIT — both secrets, as one document. Same secret path
  // the account number used to have of its own, and the difference is the GATE
  // above, not the write. Both outcomes are reported inline through `copyMsg`,
  // because a shown-once screen wants a persistent confirmation rather than a
  // toast the user can miss.
  //
  // The two outcome strings keep their `createVault.phrase*` key names. They are
  // accurate for a kit — what they claim is about the CLIPBOARD, not about which
  // secret is on it — and renaming them would leave thirty-one catalogs stale for
  // no gain the reader can see.
  const copyKit = () => {
    void (async () => {
      const cancel = await copySecretToClipboard(kitText(), {
        onSuccess: { kind: "inline", run: () => setCopyMsg(t("createVault.phraseCopied")) },
        onFailure: { kind: "inline", run: () => setCopyMsg(t("createVault.phraseCopyFailed")) },
      });
      if (cancel === null) return;
      clipboardCancelRef.current?.();
      clipboardCancelRef.current = cancel;
    })();
  };

  // The message names the DELIVERY the platform actually performed
  // (myne-md/myne#504). Both used to say "Saved to Documents/<file>", and on iOS
  // that folder is not in the Files app, so the sentence pointed the user at a
  // place they cannot open for the one file that is never shown again.
  //
  // A `switch` over the union rather than a ternary chain, so a fourth kind is
  // a compile error here instead of falling into whichever arm happens to be
  // last. The three sentences differ in exactly what they CLAIM, which is the
  // point of the union: one names a folder, one names the share sheet as the
  // route, and one names neither because the probe that would have decided
  // between them failed.
  // The switch itself moved to `secretSaveMessage` in `lib/secret-export.ts`
  // (myne-md/myne#970): the identity flow's phrase screen makes the same three
  // claims about the same three outcomes, and one copy is what keeps the two
  // screens from drifting into different promises about one file.
  const saveKitFile = () => {
    void (async () => {
      const { key, params } = secretSaveMessage(
        await saveSecretToDocuments("myne-recovery-kit.txt", kitText()),
      );
      setFileMsg(t(key, params));
    })();
  };

  // ── OB-01 · Safety briefing ─────────────────────────────────────────────────
  if (step === "briefing") {
    return (
      <Screen>
        {/* No number. The briefing is first-run only, so counting it promises a
            length the flow does not have on the picker's "create another" entry
            (myne-md/myne#468). The four steps the user ALWAYS walks are numbered;
            this one and the three waits are not. */}
        <FlowHeader label={t("createVault.briefingTitle")} />
        <ScreenScroll style={{ padding: "18px 22px 0" }}>
          <Title>{t("createVault.briefingTitle")}</Title>
          <Lead>
            {t("createVault.briefingLead")}
          </Lead>
          <Banner kind="danger" icon={false} style={{ marginTop: 16 }}>
            {LOST_BOTH_SECRETS_SENTENCE}
          </Banner>
          <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 2 }}>
            <AckRow checked={acks[0]} onToggle={() => setAcks([!acks[0], acks[1], acks[2]])}>
              Myne has no access to my notes and cannot read or recover them.
            </AckRow>
            <AckRow
              checked={acks[1]}
              onToggle={() => setAcks([acks[0], !acks[1], acks[2]])}
              why="Your password and phrase never leave this device. Nothing on our servers can decrypt them, so there is nothing for us to reset."
              whyOpen={why2Open}
              onToggleWhy={() => setWhy2Open((v) => !v)}
            >
              There is no password reset and no email recovery.
            </AckRow>
            <AckRow
              checked={acks[2]}
              onToggle={() => setAcks([acks[0], acks[1], !acks[2]])}
              why={LOST_BOTH_SECRETS_SENTENCE}
              whyOpen={why3Open}
              onToggleWhy={() => setWhy3Open((v) => !v)}
              last
            >
              My 24-word recovery phrase is the only way back into my vault.
            </AckRow>
          </div>
        </ScreenScroll>
        <FooterBar>
          <Button variant="secondary" full={false} onClick={onCancel}>
            {t("common.back")}
          </Button>
          <Button disabled={!acks.every(Boolean)} onClick={() => setStep("name")}>
            {t("common.continue")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── Name the vault (myne-md/myne#468 K10) ───────────────────────────────────
  //
  // Blank is a legitimate answer: there is no validation beyond the 4096-byte cap
  // the backend already enforces, and an empty name leaves the neutral fallback
  // the picker has always had. So Continue is never disabled — a step the user
  // may skip must not look like a gate.
  if (step === "name") {
    const goOn = () => {
      setVaultName((v) => v.trim());
      setStep("password");
    };
    return (
      <Screen>
        <FlowHeader
          label={t("createVault.stepLabel", { current: 1, total: 4 })}
          onBack={briefing ? () => setStep("briefing") : onCancel}
        />
        <div style={{ flex: 1, padding: "18px 22px 0" }}>
          <Title>{t("vaultCreation.name.heading")}</Title>
          <Lead>{t("vaultCreation.name.intro")}</Lead>
          <div style={{ marginBlockStart: "var(--space-5)" }}>
            <NameRow
              value={vaultName}
              onChange={setVaultName}
              placeholder={t("vaultCreation.name.placeholder")}
              onSubmit={goOn}
            />
          </div>
          <div
            style={{
              marginBlockStart: "var(--space-2)",
              fontSize: "var(--text-sm)",
              lineHeight: 1.5,
              color: "var(--fg-3)",
            }}
          >
            {t("vaultCreation.name.helper")}
          </div>
        </div>
        <FooterBar style={{ padding: "14px 20px" }}>
          <Button
            variant="secondary"
            full={false}
            onClick={briefing ? () => setStep("briefing") : onCancel}
          >
            {t("common.back")}
          </Button>
          <Button onClick={goOn} data-testid="create-vault.name-continue">
            {t("common.continue")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── OB-02 · Create password ─────────────────────────────────────────────────
  if (step === "password") {
    return (
      <Screen>
        <FlowHeader label={t("createVault.stepLabel", { current: 2, total: 4 })} onBack={() => setStep("name")} />
        <div style={{ flex: 1, padding: "18px 22px 0" }}>
          <Title>{t("createVault.passwordTitle")}</Title>
          {beginError && (
            <Banner kind="danger" style={{ marginTop: 16 }}>
              {t(beginError)}
            </Banner>
          )}
          <div style={{ marginTop: 22 }}>
            <FieldLabel>{t("sync.enroll.passwordLabel")}</FieldLabel>
            <PasswordRow value={pwd} onChange={setPassword} revealed={reveal} onToggleReveal={() => setReveal((v) => !v)} autoFocus />
          </div>
          {pwd.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <StrengthMeter level={strength} />
            </div>
          )}
          <div style={{ marginTop: 20 }}>
            <FieldLabel>{t("createVault.confirmPasswordLabel")}</FieldLabel>
            <ConfirmRow value={confirm} onChange={setConfirm} match={confirmMatch} />
          </div>
          <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
            {t("createVault.passwordHelper")}
          </div>
        </div>
        <FooterBar style={{ padding: "14px 20px" }}>
          <Button variant="secondary" full={false} onClick={() => setStep("name")}>
            {t("common.back")}
          </Button>
          <Button disabled={!passwordValid} onClick={() => { setBeginError(null); setStep("encrypting"); }}>
            {t("common.continue")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── OB-03 · Encrypting (blocking) ───────────────────────────────────────────
  if (step === "encrypting") {
    return (
      <Screen>
        <BlockingOverlay
          title={t("editor.attachment.progress.encrypting")}
          subtitle={t("createVault.encryptingSubtitle")}
        />
      </Screen>
    );
  }

  // ── The recovery kit (myne-md/myne#468 K11/K13) ──────────────────────────────
  //
  // The phrase and the account number on ONE screen, styled as the document the
  // Save button writes. This replaces the former phrase step and the account step
  // that used to follow the challenge: no product in the research survey asks a
  // user to absorb two consecutive "keep this forever" moments, and the second
  // one arrived after the challenge had already been passed, so it read as an
  // epilogue. One sheet, one Save, one acknowledgement.
  //
  // No "both secrets are in one file" warning box: the sheet IS that statement,
  // which is the whole argument for the merge.
  //
  // Mobile keeps its own two things. The phrase reveals in halves
  // (`showSecondHalf`) because 24 mono words do not fit a phone at a readable
  // size, and the export actions stay gated on the full reveal, as they were.
  if (step === "kit") {
    const words = showSecondHalf ? phraseRef.current : phraseRef.current.slice(0, 12);
    return (
      <Screen>
        <FlowHeader label={t("createVault.stepLabel", { current: 3, total: 4 })} />
        <ScreenScroll style={{ padding: "18px 22px 8px" }}>
          <Title>{t("vaultCreation.kit.heading")}</Title>
          <p style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)" }}>
            {t("vaultCreation.kit.intro")}
          </p>
          <Banner kind="danger" icon={false} style={{ marginTop: 16 }}>
            This is the only key to your vault. We can't reset it. Lose these words and the notes are
            gone for good.
          </Banner>

          {/* The sheet: page-coloured, bordered and lifted, so it reads as a
              document on the screen rather than as another recessed card. */}
          <div style={KIT_SHEET_STYLE} data-testid="create-vault.kit-sheet">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <span
                style={{
                  fontSize: "var(--text-base)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--fg-1)",
                }}
              >
                {t("vaultCreation.kit.documentTitle")}
              </span>
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--fg-3)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                data-testid="create-vault.kit-meta"
              >
                {vaultName}
              </span>
            </div>
            <div style={KIT_RULE_STYLE} />
            <p style={KIT_SECTION_LABEL_STYLE}>{t("vaultCreation.kit.phraseFor")}</p>
            <RecoveryGrid words={words} />
            {!showSecondHalf && (
              <Button
                variant="secondary"
                onClick={() => setShowSecondHalf(true)}
                style={{ marginTop: 4, height: 40, fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 500 }}
              >
                {t("createVault.showSecondHalf")}
              </Button>
            )}
            <div style={KIT_RULE_STYLE} />
            {/* The account number's stated reason is ADDING A DEVICE (K13), not
                "registering for sync": the second device signs in with the
                account number and a password, which is what `sync.join.help`
                says, and it is a reason a first-time user can act on. */}
            <p style={KIT_SECTION_LABEL_STYLE}>{t("vaultCreation.kit.accountFor")}</p>
            <AccountNumber value={account} />
          </div>

          {showSecondHalf && (
            <>
              {/* Tier 1 (myne-md/myne#455). Rendered only where the OS can hold
                  the phrase to the standard this screen already demands of
                  screenshots: confined to this device AND expired by the system.
                  That is iOS; Android has an equivalent of neither, so the
                  button is ABSENT there rather than present-and-weaker. A button
                  that appears and then explains its own limits is still a button
                  implying a guarantee.

                  Before this, the step offered only Save-to-file, and that is
                  not a neutral default: typing twenty-four words into a password
                  manager on a phone has a high enough error rate that people
                  screenshot the phrase instead, which is what `screen_guard`
                  exists to prevent. */}
              {canCopyPhrase && (
                <Button
                  variant="secondary"
                  onClick={copyKit}
                  style={PHRASE_ACTION_STYLE}
                  data-testid="create-vault.kit-copy"
                >
                  <Icon name="copy" size={16} color="var(--fg-2)" strokeWidth={1.5} />
                  {t("vaultCreation.kit.copy")}
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={saveKitFile}
                style={PHRASE_ACTION_STYLE}
                data-testid="create-vault.kit-save"
              >
                <Icon name="download" size={16} color="var(--fg-2)" strokeWidth={1.5} />
                {t("createVault.saveToFile")}
              </Button>
              {(copyMsg ?? fileMsg) && <p role="status" aria-live="polite" style={{ margin: "8px 0 0", fontSize: 13, color: "var(--fg-3)", textAlign: "center" }}>{copyMsg ?? fileMsg}</p>}
            </>
          )}
        </ScreenScroll>
        <FooterBar>
          <Button disabled={!showSecondHalf} onClick={startTypeBack}>
            {t("createVault.writtenThemDown")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── OB-04 · Type-back confirmation ──────────────────────────────────────────
  if (step === "typeback") {
    return (
      <Screen>
        <FlowHeader label={t("createVault.stepLabel", { current: 4, total: 4 })} onBack={() => setStep("kit")} />
        <div style={{ flex: 1, padding: "18px 22px 0" }}>
          <Title>{t("createVault.typebackTitle")}</Title>
          <Lead>{t("createVault.typebackLead")}</Lead>
          {/* The commit failure lands here, because this is where the commit is
              requested from now that the account number has no step of its own. */}
          {commitError && (
            <Banner kind="danger" style={{ marginTop: 16 }}>
              {commitError}
            </Banner>
          )}
          <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 16 }}>
            {challenge.map((idx, i) => (
              <WordEntry
                key={idx}
                position={idx + 1}
                value={answers[i]}
                onChange={(v) => setAnswers((prev) => prev.map((a, j) => (j === i ? v : a)))}
                error={corrects[i] === false ? t("createVault.wordMismatch", { pos: idx + 1 }) : undefined}
              />
            ))}
          </div>
        </div>
        <FooterBar style={{ padding: "14px 20px" }}>
          <Button variant="secondary" full={false} style={{ fontSize: 14, padding: "0 18px" }} onClick={() => setStep("kit")}>
            {t("createVault.backToPhrase")}
          </Button>
          {/* This COMMITS. The challenge is the last step, and what gates it is
              the type-back rather than the checkbox the account step used to
              carry: `protocol.md` §7.1.3 says a bare checkbox is not evidence, so
              deleting it made the gate stronger rather than looser. */}
          <Button
            disabled={!allCorrect}
            onClick={() => void commit()}
            data-testid="create-vault.commit"
          >
            {t("createVault.commit")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── Committing (blocking) ───────────────────────────────────────────────────
  if (step === "committing") {
    return (
      <Screen>
        <BlockingOverlay title={t("createVault.committingTitle")} subtitle={t("createVault.committingSubtitle")} />
      </Screen>
    );
  }

  // ── Unlocking (blocking) ────────────────────────────────────────────────────
  if (step === "unlocking") {
    return (
      <Screen>
        <BlockingOverlay title={t("createVault.unlockingTitle")} subtitle={t("createVault.unlockingSubtitle")} />
      </Screen>
    );
  }

  // ── OB-06 · Ready / vault created ───────────────────────────────────────────
  return (
    <Screen style={{ alignItems: "center", padding: "0 30px" }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <Wordmark />
        <h1
          style={{
            margin: "26px 0 0",
            fontSize: 30,
            lineHeight: 1.12,
            letterSpacing: "-0.025em",
            fontWeight: 600,
            color: "var(--fg-display)",
          }}
        >
          {t("createVault.readyTitle")}
        </h1>
        <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 300 }}>
          {t("createVault.readyBody")}
        </p>
        <div
          style={{
            marginTop: 18,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: "var(--bg-2)",
            border: "1px solid var(--line-1)",
            borderRadius: 999,
            padding: "7px 14px",
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--success)" }} />
          <span style={{ fontSize: 13, color: "var(--fg-2)" }}>{t("createVault.personalLabel")} · </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-2)" }}>{account}</span>
        </div>
      </div>
      <div style={{ flex: "none", paddingBottom: 52, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
        <Button onClick={() => void openVault()}>{t("createVault.openVault")}</Button>
      </div>
    </Screen>
  );
}
