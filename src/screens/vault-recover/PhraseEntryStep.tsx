// Phrase-entry sub-step — 24-cell BIP-39 phrase grid + Cancel +
// Submit. Per `recovery-flow.md` § 3.2:
//
//   - 24 numbered cells (positions 1–24 visible to the user) in a
//     4-column grid, monospace cell content.
//   - **No per-cell validation** — empty / filled / focused all look
//     the same. Spec § 3.2 forbids any visual cue tied to BIP-39
//     wordlist membership; positive (green) and negative (red) hints
//     would both leak a 1-bit-per-word membership signal to anyone
//     observing the screen.
//   - **No typeahead, no autocomplete, no spellcheck.** Browser-level
//     `autocomplete="off" spellcheck="false" autocapitalize="off"`
//     applied to every input.
//   - **Paste-to-distribute** (Q5 hybrid rule): paste with 2+ tokens
//     into any cell N fills cells N..min(24, N+token_count-1); cells
//     1..N-1 preserved; tokens beyond cap silently truncated. Single-
//     token paste fills only the target cell.
//   - **No auto-advance, no typed whitespace.** Spaces are filtered
//     in the reducer (defense in depth) and at `onChange`.
//   - **Submit gating:** all 24 cells non-empty.
//   - **NFKD normalize at submit** (§ 7.4) before A8d invocation —
//     unicode-normalize + lowercase + trim + collapse whitespace runs
//     to single ASCII space.
//
// Outcome handling per Q7 A8d matrix is owned by the orchestrator
// (`VaultRecover.tsx`) — its `useEffect` keyed on `subStep ===
// "decrypting"` fires `recover_with_phrase`, maps the resulting
// `VaultRecoveryError` to a `PhraseOutcome`, and dispatches
// `phrase-result`. This component just transitions the sub-step via
// `submit-phrase` after stashing the normalized phrase in the
// orchestrator's ref.
//
// **Cancel.** Visible only on this sub-step (`recovery-flow.md` § 3.3
// + § 4.1 forbid Cancel on the chained Decrypting / password-reset
// sub-steps). Click dispatches `recover.cancel` to App.tsx via the
// `onCancel` callback prop. Slot is `Empty` at this point (A8d hasn't
// fired), so no `vault_lock` is needed.

import {
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type ClipboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { DestructiveBanner } from "../../components/DestructiveBanner";
import { normalizeBip39Phrase } from "../../lib/bip39-normalize";
import {
  PHRASE_CELL_COUNT,
  type Action,
  type VaultRecoverState,
} from "./reducer";
import { stageRootStyle } from "../../components/primitives/stageRoot";
import { scrollRegionStyle } from "../../hooks/useScrollEdges";

interface PhraseEntryStepProps {
  state: VaultRecoverState;
  dispatch: (action: Action) => void;
  onCancel: () => void;
  /** Called when the user submits a fully-filled grid. The argument
   *  is the joined phrase already NFKD-normalized per `protocol.md`
   *  § 7.4. The orchestrator stashes it in a ref and fires A8d via a
   *  `useEffect` keyed on `subStep === "decrypting"`. */
  onSubmitNormalizedPhrase: (normalizedPhrase: string) => void;
}

const ROOT_STYLE: CSSProperties = {
  ...stageRootStyle,
  background: "var(--bg-1)",
  fontFamily: "var(--font-sans)",
  padding: "var(--space-6)",
};

// Wider than CenteredCard's 480 — the 24-cell grid needs ~600px to
// fit four columns of cells comfortably (Penpot canon).
const CARD_STYLE: CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-6)",
  maxWidth: 600,
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  // Bounded and scrollable, because `stageRootStyle` bounds the root. This is
  // the tallest surface in the tree (24 cells plus chrome) and it is the screen
  // a user with nothing but their recovery phrase has to complete. A capped root
  // with `alignItems: center` pushes a too-tall card out of BOTH ends, so on a
  // short window the heading and the submit button leave together, with no way
  // to reach either. `CenteredCard` and `VaultPicker` carry the same pair.
  ...scrollRegionStyle,
  maxHeight: "100%",
};

const EYEBROW_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-2xl)",
  lineHeight: "var(--leading-snug)",
  letterSpacing: "var(--tracking-tight)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-display)",
  margin: 0,
};

const BODY_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  fontWeight: "var(--weight-regular)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
  margin: 0,
};

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 6,
};

const CELL_WRAP_BASE: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  background: "var(--paper-1)",
  borderRadius: 2,
  paddingInlineStart: 28,
  paddingInlineEnd: 8,
  height: 32,
  cursor: "text",
  transition: "border-color 80ms linear",
};

function cellWrapStyle(focused: boolean): CSSProperties {
  return {
    ...CELL_WRAP_BASE,
    border: `1px solid ${focused ? "var(--accent)" : "var(--line-1)"}`,
    background: focused ? "var(--bg-1)" : "var(--paper-1)",
  };
}

const CELL_NUMBER_STYLE: CSSProperties = {
  position: "absolute",
  insetInlineStart: 8,
  top: "50%",
  transform: "translateY(-50%)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  pointerEvents: "none",
  userSelect: "none",
};

const CELL_INPUT_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  background: "transparent",
  border: 0,
  outline: "none",
  appearance: "none",
  WebkitAppearance: "none",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
  padding: 0,
  margin: 0,
  boxShadow: "none",
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  marginTop: "var(--space-2)",
};

const CANCEL_STYLE: CSSProperties = {
  background: "transparent",
  color: "var(--fg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "7px 14px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  cursor: "pointer",
};

// MYND-108-bis: danger-tinted link-style affordance for the lost-
// credentials cul-de-sac escape. Always visible in phrase-entry
// (covers both immediate "I lost everything" intent and the
// try-recovery-then-fail journey). Subdued visual weight relative to
// CANCEL_STYLE — link-style, not button-style — so it doesn't
// compete with the primary Unlock CTA.
const DELETE_LINK_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  marginInlineStart: "var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  color: "var(--danger)",
  cursor: "pointer",
  textDecoration: "underline",
};

function submitStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled ? "var(--bg-3)" : "var(--accent)",
    color: disabled ? "var(--fg-3)" : "var(--accent-on)",
    border: disabled ? "1px solid var(--line-1)" : "none",
    borderRadius: "var(--radius-2)",
    padding: "7px 14px",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--weight-medium)",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

export function PhraseEntryStep({
  state,
  dispatch,
  onCancel,
  onSubmitNormalizedPhrase,
}: PhraseEntryStepProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  // Clear the typed words when the page is hidden or unloaded
  // (`recovery-flow.md` §3.5 as amended 2026-08-15).
  //
  // A browser restores form state on back-navigation and session restore, from
  // storage this client neither owns nor can reach. §3.4's "wipe all 24 cells
  // from React state" does not touch that copy, and the copy is AS11 — the one
  // credential no password change rotates. `autoComplete="off"` on each cell is
  // the first half and is already there; this is the second.
  //
  // **Stated as best-effort, because that is what it is.** `pagehide` is the
  // event that fires on bfcache entry as well as unload, which is why it is the
  // one used, but nothing here can guarantee the browser has not already
  // snapshotted the field. §3.5's posture is exactly this: say what each layer
  // can deliver, and do not claim the layer above it.
  useEffect(() => {
    const clear = () => {
      for (let i = 0; i < PHRASE_CELL_COUNT; i += 1) {
        dispatch({ type: "set-cell", index: i, value: "" });
      }
    };
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, [dispatch]);

  const allFilled = state.cells.every((c) => c.length > 0);

  const handleCellChange = (index: number) => (e: ChangeEvent<HTMLInputElement>) => {
    dispatch({ type: "set-cell", index, value: e.target.value });
  };

  const handlePaste = (index: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    const tokens = pasted.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length < 2) return; // single-token: native paste fills only the target cell
    e.preventDefault();
    dispatch({ type: "paste-into-cell", index, tokens });
  };

  const handleSubmit = () => {
    if (!allFilled) return;
    const normalized = normalizeBip39Phrase(state.cells.join(" "));
    onSubmitNormalizedPhrase(normalized);
    // Subsequent dispatch transitions sub-step → decrypting; the
    // orchestrator's useEffect fires A8d after seeing the new
    // sub-step. We send the normalized string up via the callback
    // *before* dispatching submit-phrase so the ref is populated by
    // the time the effect runs.
    dispatch({ type: "submit-phrase" });
  };

  return (
    <div style={ROOT_STYLE}>
      <div style={CARD_STYLE}>
        <div style={EYEBROW_STYLE}>{t("vaultRecover.phrase.eyebrow")}</div>
        <h1 style={TITLE_STYLE}>{t("vaultRecover.phrase.title")}</h1>
        <p style={BODY_STYLE}>{t("vaultRecover.phrase.body")}</p>

        {state.banner != null && (
          <DestructiveBanner testId="recover.banner">{state.banner}</DestructiveBanner>
        )}

        <div style={GRID_STYLE} data-testid="recover.phrase-grid">
          {Array.from({ length: PHRASE_CELL_COUNT }, (_, i) => {
            const inputId = `${baseId}-cell-${i}`;
            const focused = focusedIndex === i;
            return (
              <label key={i} htmlFor={inputId} style={cellWrapStyle(focused)}>
                <span style={CELL_NUMBER_STYLE}>{i + 1}</span>
                <input
                  id={inputId}
                  type="text"
                  value={state.cells[i] ?? ""}
                  onChange={handleCellChange(i)}
                  onPaste={handlePaste(i)}
                  onFocus={() => setFocusedIndex(i)}
                  onBlur={() => setFocusedIndex((cur) => (cur === i ? null : cur))}
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  inputMode="text"
                  style={CELL_INPUT_STYLE}
                  aria-label={t("vaultRecover.phrase.cellLabel", { index: i + 1 })}
                  data-testid="recover.phrase-cell"
                  data-index={i + 1}
                />
              </label>
            );
          })}
        </div>

        <div style={FOOTER_STYLE}>
          <button
            type="button"
            onClick={onCancel}
            style={CANCEL_STYLE}
            data-testid="recover.cancel"
          >
            {t("vaultRecover.phrase.back")}
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "request-delete" })}
            style={DELETE_LINK_STYLE}
            data-testid="recover.delete-link"
          >
            {t("vaultRecover.phrase.deleteLink")}
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!allFilled}
            style={submitStyle(!allFilled)}
            data-testid="recover.submit"
          >
            {t("vaultRecover.phrase.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
