// @vitest-environment jsdom
//
// Accessible authentication (myne-md/myne#728, task 13; WCAG 2.2 SC 3.3.8).
//
// The criterion forbids a cognitive-function test in an authentication step
// unless a mechanism assists the user. The mechanism this app relies on is the
// ordinary one: the credential can be copied out of a password manager and
// PASTED in. Blocking paste in a credential field, which some products still
// do believing it is a security measure, is the specific failure.
//
// The audit found NOTHING blocking paste. That is the point of this file:
// nothing changed, and without a test the next security-flavoured edit that
// adds `onPaste={(e) => e.preventDefault()}` to a password box would be a
// silent 3.3.8 regression that no compiler, lint or other guard here reports.
//
// The surfaces are NAMED rather than discovered. A sweep for "files with a
// password input" would quietly stop covering a field that moved, and the
// roster is compared against the filesystem so a rename fails loudly instead.

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PhraseEntryStep } from "../../src/screens/vault-recover/PhraseEntryStep";
import {
  initialState,
  vaultRecoverReducer,
  type Action,
  type VaultRecoverState,
} from "../../src/screens/vault-recover/reducer";

afterEach(cleanup);

/**
 * Every surface that takes, or reveals, a credential. Each entry says what the
 * field IS, because "is this an authentication step" is the judgement 3.3.8
 * turns on and a bare path list would hide it.
 */
const CREDENTIAL_SURFACES: ReadonlyArray<[path: string, what: string]> = [
  ["src/screens/Unlock.tsx", "the vault password, the main front door"],
  ["src/components/QuickUnlockEntry.tsx", "the quick-unlock PIN"],
  ["src/screens/AccountNumberEntry.tsx", "the account number"],
  ["src/screens/vault-creation/PasswordStep.tsx", "the password being chosen"],
  ["src/screens/vault-creation/KitStep.tsx", "the recovery kit: phrase + account number, shown once"],
  ["src/screens/vault-creation/ConfirmStep.tsx", "four words of the phrase, re-entered"],
  ["src/screens/vault-recover/PhraseEntryStep.tsx", "the 24-word recovery grid"],
  ["src/components/sync/EnrollPhraseCredential.tsx", "a phrase grid, device enrolment"],
  ["src/notes/import/MyneVaultSetup.tsx", "a phrase grid, vault import"],
];

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("no credential field blocks paste", () => {
  it("the roster names files that exist", () => {
    // A renamed surface must fail here rather than silently leave the scan.
    for (const [path] of CREDENTIAL_SURFACES) {
      expect(existsSync(path), `${path} is on the roster but not on disk`).toBe(true);
    }
    expect(CREDENTIAL_SURFACES.length).toBeGreaterThanOrEqual(9);
  });

  it.each(CREDENTIAL_SURFACES)("%s (%s) suppresses no clipboard event", (path) => {
    const src = code(path);
    // The shapes a "paste is insecure" edit actually takes.
    expect(src, "a paste handler that cancels the paste").not.toMatch(
      /onPaste=\{[^}]*preventDefault/,
    );
    expect(src, "a paste handler that swallows the paste").not.toMatch(
      /onPaste=\{\s*\(\)?\s*=>\s*(false|undefined|\{\s*\})/,
    );
    expect(src, "copy suppressed").not.toMatch(/onCopy=\{[^}]*preventDefault/);
    expect(src, "cut suppressed").not.toMatch(/onCut=\{[^}]*preventDefault/);
  });

  // Selectability is deliberately NOT part of the sweep above. A blanket
  // `userSelect: "none"` scan cannot tell a credential from an ornament, and
  // the recovery grid proves it: its cell NUMBERS are unselectable so that
  // sweeping a selection across the words does not pick up "1. 2. 3.", which
  // is correct and would have failed a blanket rule. Inputs are selectable by
  // the caret regardless, so the only place the question is real is the one
  // screen that DISPLAYS a credential for the user to copy.

  it("the revealed phrase is selectable, which is what makes copy possible", () => {
    // `userSelect` flips to `text` on reveal; before reveal it is `none`, and
    // that is correct: there is nothing to select behind the blur.
    //
    // The grid lives in the shared `PhraseGrid` as of myne-md/myne#468, split out
    // of `SecretPhraseReveal` (myne-md/myne#768) so the recovery kit can show the
    // phrase beside the account number and export both as one file. Every caller
    // renders this one grid, so the assertion reads the single implementation
    // rather than a per-screen copy.
    const grid = code("src/components/PhraseGrid.tsx");
    expect(grid).toMatch(/userSelect:\s*revealed\s*\?\s*"text"/);
    // And a Copy control exists on each screen that shows it, so the mechanism
    // does not depend on the user dragging a selection across 24 words. Two
    // screens, two copy targets: the phrase alone, and the whole kit.
    expect(code("src/components/SecretPhraseReveal.tsx")).toContain(
      'data-testid={`${testIdPrefix}-copy`}',
    );
    expect(code("src/screens/vault-creation/KitStep.tsx")).toContain(
      'data-testid="create.kit-copy"',
    );
  });
});

// ── the grid's paste actually works ──────────────────────────────────────
//
// The scan above proves nothing is BLOCKED. This proves the one field with
// real paste LOGIC does the right thing with it, which is the case a scan
// cannot see: a 24-cell grid where a naive implementation drops 23 words.

function Grid({ onState }: { onState?: (s: VaultRecoverState) => void }) {
  const [state, setState] = [
    gridState.current,
    (next: VaultRecoverState) => {
      gridState.current = next;
      onState?.(next);
    },
  ];
  return (
    <PhraseEntryStep
      state={state}
      dispatch={(action: Action) => setState(vaultRecoverReducer(state, action))}
      onCancel={vi.fn()}
      onSubmitNormalizedPhrase={vi.fn()}
    />
  );
}

const gridState = { current: initialState("phrase-entry") };

function pasteInto(cellIndex: number, text: string): VaultRecoverState {
  gridState.current = initialState("phrase-entry");
  let seen = gridState.current;
  render(<Grid onState={(s) => (seen = s)} />);
  const cells = screen.getAllByTestId("recover.phrase-cell");
  fireEvent.paste(cells[cellIndex] as HTMLElement, {
    clipboardData: { getData: () => text },
  });
  return seen;
}

const TWENTY_FOUR = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);

describe("a whole phrase can be pasted at once", () => {
  it("spreads 24 words across the 24 cells from the first", () => {
    // The transcription test 3.3.8 is about: typing 24 words by hand, one cell
    // at a time, reading them off a piece of paper.
    const state = pasteInto(0, TWENTY_FOUR.join(" "));
    expect(state.cells).toEqual(TWENTY_FOUR);
  });

  it("accepts a phrase pasted with newlines and runs of spaces", () => {
    // What a real clipboard carries: a phrase copied out of a text file, or
    // out of the reveal screen's own grid layout.
    const state = pasteInto(0, `  ${TWENTY_FOUR.slice(0, 4).join("\n")}   ${TWENTY_FOUR[4]} `);
    expect(state.cells.slice(0, 5)).toEqual(TWENTY_FOUR.slice(0, 5));
  });

  it("fills forward from the cell pasted into, not always from the first", () => {
    const state = pasteInto(2, "alpha beta gamma");
    expect(state.cells.slice(0, 5)).toEqual(["", "", "alpha", "beta", "gamma"]);
  });

  it("drops the overflow rather than wrapping round to cell 1", () => {
    // Wrapping would silently overwrite words the user had already entered.
    const state = pasteInto(22, "alpha beta gamma delta");
    expect(state.cells[22]).toBe("alpha");
    expect(state.cells[23]).toBe("beta");
    expect(state.cells[0]).toBe("");
  });

  it("lets a SINGLE word fall through to the native paste", () => {
    // One token is an ordinary paste into one field; intercepting it would
    // take over the caret and the selection for no reason.
    gridState.current = initialState("phrase-entry");
    render(<Grid />);
    const cell = screen.getAllByTestId("recover.phrase-cell")[0] as HTMLElement;
    const prevented = !fireEvent.paste(cell, {
      clipboardData: { getData: () => "alpha" },
    });
    expect(prevented).toBe(false);
  });
});
