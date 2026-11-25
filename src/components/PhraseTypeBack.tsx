// SPDX-License-Identifier: AGPL-3.0-only
// The recovery-phrase type-back challenge, shared by the two ceremonies that put
// a 24-word phrase on screen: vault creation (`CreateVault` -> `ConfirmStep`) and
// identity creation (myne-md/myne#855).
//
// `protocol.md` section 7.1.3's "demonstrate the phrase, not memorize" is a
// property of the secret, not of which ceremony produced it, so the identity
// phrase gets the same challenge the vault phrase does. Before myne-md/myne#855
// it got none (`decisions/ui/0615`'s original clause, reversed by
// `design-notes/ui/0665`), which left a user who never saved the identity
// phrase with no signal until they lost the device, and an identity cannot be
// recovered without it.
//
// Presentational only: it renders the four position-specific fields and the
// inline mismatch lines, while the CALLER owns the values and the gate. The two
// flows commit at different moments (the vault flow's reducer holds the inputs and
// the commit lives on its own button; the identity dialog gates its Done), so the
// shared part is the rendering plus `phraseTypeBackMatches`, which computes
// `allMatch` exactly as the vault reducer's step does so the two cannot drift.

import { useMemo } from "react";
import { Input } from "./primitives/Input";
import { normalizeWord } from "../screens/vault-creation/reducer";

const WORD_LABEL_STYLE = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

/** Four distinct 1-based word positions, as `drawConfirmPositions` returns them. */
export type TypeBackPositions = readonly [number, number, number, number];

/**
 * The per-position match state. `null` for an empty field (not yet wrong), `true`
 * or `false` once something is typed. `allMatch` is the gate both callers use.
 */
export function phraseTypeBackMatches(
  phrase: readonly string[],
  positions: TypeBackPositions,
  values: Readonly<Record<number, string>>,
): { matches: Array<boolean | null>; allMatch: boolean } {
  const targets = positions.map((pos) => normalizeWord(phrase[pos - 1] ?? ""));
  const matches = positions.map((pos, idx) => {
    const value = values[pos] ?? "";
    if (value.length === 0) return null;
    return normalizeWord(value) === targets[idx];
  });
  return { matches, allMatch: matches.every((m) => m === true) };
}

/**
 * Spread a pasted phrase across the challenge's positions.
 *
 * The type-back asks for four words by NUMBER, and the phrase the user is
 * holding is one ordered block of 24: copying it out of a password manager and
 * pasting it into the first field used to put all 24 words into one box and
 * leave the other three empty (myne-md/myne#945 item 04). The words are the
 * SAME words, in the same order, so the positions are a lookup rather than a
 * puzzle: `words[pos - 1]` is what belongs in the field labelled `Word #pos`.
 *
 * Returns `null` when the paste is not a whole phrase (fewer words than the
 * highest position asked for), which is the ordinary single-word paste and must
 * keep its default behaviour: inserting where the caret is.
 */
export function distributePhrasePaste(
  text: string,
  positions: readonly number[],
): Array<readonly [number, string]> | null {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return null;
  const highest = Math.max(...positions);
  if (words.length < highest) return null;
  return positions.map((pos) => [pos, words[pos - 1] ?? ""] as const);
}

export interface PhraseTypeBackProps {
  /** The 24 words, already split. */
  phrase: readonly string[];
  positions: TypeBackPositions;
  values: Readonly<Record<number, string>>;
  onChange: (position: number, value: string) => void;
  /** Field label for one position. The caller resolves it, so its `t()` key is
   *  literal and `scripts/check-i18n.mjs` can see it. */
  labelFor: (pos: number) => string;
  /** Inline mismatch line for one position. Resolved by the caller, same reason. */
  mismatchFor: (pos: number) => string;
  /** Testid stem: `<stem>-input` and `<stem>-error`, each carrying `data-index`. */
  testIdPrefix: string;
}

export function PhraseTypeBack({
  phrase,
  positions,
  values,
  onChange,
  labelFor,
  mismatchFor,
  testIdPrefix,
}: PhraseTypeBackProps) {
  const { matches } = useMemo(
    () => phraseTypeBackMatches(phrase, positions, values),
    [phrase, positions, values],
  );

  return (
    // Two by two: four words is one small task, and a grid of short fields reads
    // as that where a column of four full-width fields reads as a form.
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: "var(--space-4)",
      }}
    >
      {positions.map((pos, idx) => {
        const inputId = `${testIdPrefix}-input-${pos}`;
        const value = values[pos] ?? "";
        const invalid = matches[idx] === false;
        return (
          <div
            key={pos}
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
          >
            <label htmlFor={inputId} style={WORD_LABEL_STYLE}>
              {labelFor(pos)}
            </label>
            <Input
              id={inputId}
              // Pinned left-to-right for the same reason the grid is: the words
              // are frozen English (`protocol.md` section 7) and under an RTL
              // locale a logical-direction field puts the caret and the rendered
              // text on the wrong side of a secret whose order cannot be
              // re-checked.
              dir="ltr"
              type="text"
              value={value}
              onChange={(e) => onChange(pos, e.target.value)}
              onPaste={(e) => {
                const distributed = distributePhrasePaste(
                  e.clipboardData.getData("text"),
                  positions,
                );
                if (distributed === null) return;
                // `preventDefault` rather than letting the paste land first:
                // the whole point is that the four fields, not one, receive it.
                e.preventDefault();
                for (const [position, word] of distributed) {
                  onChange(position, word);
                }
              }}
              invalid={invalid}
              autoComplete="off"
              spellCheck={false}
              mono
              autoFocus={idx === 0}
              data-testid={`${testIdPrefix}-input`}
              data-index={pos}
            />
            {invalid && (
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--danger)" }}
                data-testid={`${testIdPrefix}-error`}
                data-index={pos}
              >
                {mismatchFor(pos)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
