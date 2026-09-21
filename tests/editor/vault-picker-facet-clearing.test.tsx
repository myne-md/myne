// @vitest-environment jsdom
//
// What `<CMEditor>` RENDERS after a host clears a vault-wide picker set
// (myne-md/myne#452).
//
// This exists because a fix shipped for one review round that cleared nothing.
// A host that holds "vault A's heading rows" and then wants to forget them has
// two ways to say so, and only one of them works:
//
//   - pass `[]`        -> dispatched, the compartment is emptied.
//   - pass `undefined` -> NOT dispatched. `CMEditor` reads an absent prop as
//                         "this host has no opinion" and returns before the
//                         dispatch, so the compartment keeps what it last held.
//
// The second is the correct contract at MOUNT, where it lets the facet keep the
// empty set its own extension seeded rather than having a host assert an answer
// it has not read yet. It is the wrong thing on a VAULT SWITCH, where the
// compartment already holds the previous vault's rows and an absent prop freezes
// them there. `mobile/src/app/flows/EditorFlow.tsx`'s `[vaultId]` reset is the
// caller that depends on this distinction, and `mobile/tests/vault-picker-reset.test.ts`
// pins that it passes the working one.
//
// Block-anchor rows are the ones that matter most: they carry note titles,
// folders and `preview` lines lifted from note bodies, all of it vault plaintext.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";
import { CMEditor } from "../../editor/src/CMEditor";
import {
  readVaultHeadings,
  type VaultHeading,
} from "../../editor/src/wikilink/vault-headings";
import {
  readVaultBlockAnchors,
  type VaultBlockAnchor,
} from "../../editor/src/wikilink/vault-block-anchors";

afterEach(cleanup);

const HEADINGS: VaultHeading[] = [
  { noteUuid: "vault-a-note", title: "Vault A note", folder: null, heading: "Vault A heading", level: 2 },
];

const ANCHORS: VaultBlockAnchor[] = [
  {
    noteUuid: "vault-a-note",
    title: "Vault A note",
    folder: null,
    blockId: "a1",
    preview: "a line of vault A's plaintext",
  },
];

/** Mount with a set, then re-render with whatever the host says next. */
function mountThenPass(next: {
  vaultHeadings?: readonly VaultHeading[];
  vaultBlockAnchors?: readonly VaultBlockAnchor[];
}): EditorView {
  // A holder rather than a `let`: TypeScript tracks assignments to a local and
  // sees only the `null`, so the null check below would narrow it to `never` and
  // every `.state` read after it would be an error. A declared property type is
  // not flow-narrowed that way. (`@types/node` is absent in these trees, so an
  // implicit any here would be invisible rather than caught.)
  const held: { view: EditorView | null } = { view: null };
  const props = {
    noteId: null,
    value: "body",
    onChange: () => {},
    onReady: (v: EditorView | null) => {
      if (v) held.view = v;
    },
  };
  const { rerender } = render(
    <CMEditor {...props} vaultHeadings={HEADINGS} vaultBlockAnchors={ANCHORS} />,
  );
  const view = held.view;
  if (view === null) throw new Error("CMEditor did not expose its view");
  // Non-vacuity: the sets have to be IN the facets before a test can claim
  // anything about clearing them.
  expect(readVaultHeadings(view.state)).toHaveLength(1);
  expect(readVaultBlockAnchors(view.state)).toHaveLength(1);

  rerender(<CMEditor {...props} {...next} />);
  return view;
}

describe("clearing a vault-wide picker set through CMEditor", () => {
  it("an empty array clears both facets", () => {
    const view = mountThenPass({ vaultHeadings: [], vaultBlockAnchors: [] });
    expect(readVaultHeadings(view.state)).toEqual([]);
    expect(readVaultBlockAnchors(view.state)).toEqual([]);
  });

  it("an ABSENT prop does not clear them, which is why a host must not use it to forget a vault", () => {
    // Pinning the trap rather than the fix. If this ever starts clearing, the
    // `[vaultId]` reset in EditorFlow could go back to `null` and the comment
    // there explaining why it cannot should go with it.
    const view = mountThenPass({});
    expect(readVaultHeadings(view.state)).toHaveLength(1);
    expect(readVaultBlockAnchors(view.state)).toHaveLength(1);
    expect(readVaultBlockAnchors(view.state)[0]!.preview).toContain("vault A");
  });

  it("a replacement set replaces rather than merges", () => {
    const view = mountThenPass({
      vaultHeadings: [
        { noteUuid: "vault-b-note", title: "Vault B note", folder: null, heading: "Vault B heading", level: 1 },
      ],
      vaultBlockAnchors: [],
    });
    expect(readVaultHeadings(view.state).map((h) => h.heading)).toEqual(["Vault B heading"]);
    expect(readVaultBlockAnchors(view.state)).toEqual([]);
  });
});
