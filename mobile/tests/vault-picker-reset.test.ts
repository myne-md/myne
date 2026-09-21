// The two picker sets are vault-scoped, and the reset that makes them so
// (myne-md/myne#452).
//
// Why this is a SOURCE test rather than a behavioural one. The hazard needs a
// `vaultId` prop swap while `EditorFlow` stays mounted, and every routine exit
// today routes through the unlock stage, which unmounts. So the defect is not
// reachable from the flow tier, and the comment on the reset effect itself says
// why it is defended anyway: "the vault id is a prop, so a swap without a
// remount is expressible". A guarantee nothing can exercise is exactly the kind
// that decays silently, so what is pinned here is membership of the reset list.
//
// What it costs if it decays: `blockAnchorRows` carries `preview` lines lifted
// from note bodies, plus each note's title and folder. Carried across a swap
// they are vault A's plaintext rendered inside vault B, and selecting one writes
// a link to a vault-A note into a vault-B note. `joinVaultBlockAnchors` drops
// them as a second line of defence, and a filter is not a lifecycle: it depends
// on the new vault's note-set already having loaded.
//
// The behavioural halves live elsewhere: `tests/notes/vaultBlockAnchorsJoin.test.ts`
// covers the join, and `tests/flow-logic/editor/vault-pickers.flow.ts` covers the
// fetch.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const source: string = readFileSync(
  fileURLToPath(new URL("../src/app/flows/EditorFlow.tsx", import.meta.url)),
  "utf8",
);

/** The body of the one `useEffect` keyed on the vault id. */
function vaultResetEffectBody(): string {
  const dep = "}, [vaultId, searchDelta, indicesDelta]);";
  const end = source.indexOf(dep);
  expect(end, "the [vaultId] reset effect was not found, so nothing below checked anything").
    toBeGreaterThan(-1);
  const start = source.lastIndexOf("useEffect(() => {", end);
  expect(start, "the reset effect's opening was not found").toBeGreaterThan(-1);
  return source.slice(start, end);
}

describe("everything vault-scoped is cleared when the vault id changes", () => {
  it("clears both picker row sets and the fetch trigger", () => {
    const body = vaultResetEffectBody();
    // Non-vacuity first: the two resets that were always here must be found by
    // the same extraction, or an extraction that silently returned the wrong
    // slice would make every assertion below pass against nothing.
    expect(body).toContain("searchDelta.reset()");
    expect(body).toContain("indicesDelta.reset()");

    // `EMPTY_ROWS` and not `null`, and that is the whole point of the assertion.
    // `null` reaches `<CMEditor>` as an ABSENT prop, which it reads as "no
    // opinion" and does not dispatch, so the compartment keeps the previous
    // vault's rows and the reset clears nothing that renders. Worse than no
    // reset, because the join alone WOULD have emptied it.
    // `tests/editor/vault-picker-facet-clearing.test.tsx` is that contract,
    // asserted against a real mounted editor rather than restated here.
    expect(
      body,
      "`headingRows` is vault-scoped and is not cleared on a vault swap",
    ).toContain("setHeadingRows(EMPTY_ROWS)");
    expect(
      body,
      "`blockAnchorRows` holds vault-A note titles, folders and body previews; " +
        "not clearing them on a vault swap renders one vault's plaintext in another's picker",
    ).toContain("setBlockAnchorRows(EMPTY_ROWS)");
    expect(
      body,
      "the reset must not use `null`: that reaches CMEditor as an absent prop, which is not " +
        "dispatched, so the previous vault's rows stay in the compartment",
    ).not.toContain("setHeadingRows(null)");
    expect(
      body,
      "the picker fetch trigger is vault-scoped too, or the new vault inherits the old one's retry budget",
    ).toContain("setPickerFetch(");
  });

  it("initialises both sets to the SAME cleared value the reset uses", () => {
    // There is deliberately one cleared value, not two. A version of this held
    // `null` for "never read" and `[]` for "read and empty", so that a refused
    // read would not render as the answer "this vault has no headings". It was
    // deleted for two measured reasons, and this assertion is what stops it
    // coming back by halves: `null` is not observable (it reaches `<CMEditor>`
    // as an absent prop, and an absent prop leaves the facet on its own seeded
    // empty, so both render zero rows), and it was not reachable either (the
    // reset effect runs in the first effect flush, so the measured state history
    // with every read refused was `["null", "arr:0"]`, one frame).
    //
    // The direction that matters is that the initialiser and the reset agree. If
    // a future change reintroduces `null`, it has to reintroduce it in BOTH, and
    // the reset is where `null` silently stops clearing the compartment.
    expect(source).toContain("useState<readonly VaultHeadingRow[]>(EMPTY_ROWS)");
    expect(source).toContain("useState<readonly VaultBlockAnchor[]>(EMPTY_ROWS)");
    expect(
      source,
      "a `null` picker-row state is unreachable after the first effect flush and unobservable at " +
        "the editor; reintroducing it needs a mount guard AND a consumer that can tell the two apart",
    ).not.toContain("VaultHeadingRow[] | null>");
  });
});
