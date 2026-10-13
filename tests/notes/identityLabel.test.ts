// @vitest-environment jsdom
//
// The one label rule over a `ResolvedIdentity` (`member-devices` task 5).
//
// Two surfaces show a resolved author: the version-history list and the live
// roster. Each used to own a hand-written variant switch, and the two had
// already drifted (history said "Device <code>", presence said the bare code),
// so the same unbound device was named two ways on one screen. The rule now
// lives in `src/notes/collab/identityLabel.ts`.
//
// This spec covers the rule itself. Two things about it are worth stating,
// because both were got wrong on the way here:
//
//  1. The rule returns a DESCRIPTOR, not a string, so the two halves are two
//     assertions: what the rule selects, and what `identityLabelText` renders for
//     it. A test that only ever compared rendered strings would not notice a
//     surface that re-implemented half the rule, and a test that only compared
//     descriptors would not notice a rendering that dropped an arm.
//
//  2. The behavioural half of "one rule, two surfaces" lives NEXT DOOR, in
//     `tests/notes/presenceLabels.test.tsx` and `tests/components/whoIsHereTab.test.tsx`,
//     which render the real roster over the real store: a peer resolved once is
//     rendered in the language of the RENDER, not of the resolution. What stays
//     here is the structural half, and it stays because behaviour cannot express
//     it: a component with its own copy of the switch renders identically for
//     every variant this file could enumerate, and then drifts later. That is the
//     shape the module exists to prevent, so it is checked by reading the source,
//     with the reason written beside each read.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import i18n from "../../src/i18n";
import {
  identityLabelText,
  resolvedIdentityLabel,
  type IdentityLabel,
} from "../../src/notes/collab/identityLabel";
import type { ResolvedIdentity } from "../../src/types/resolved-identity";

// The real translator, so the surface under test is handed the same thing the
// app hands it rather than a stub whose copy could differ from the shipped
// English (`i18n.t` IS a `TFunction`).
const t = i18n.t;

/** The absolute path of an app source file, read as text by the structure checks. */
function source(relative: string): string {
  const path: string = join(process.cwd(), relative);
  return readFileSync(path, "utf8");
}

/** A user-authored name, the arm that carries no copy of ours. */
const text = (value: string): IdentityLabel => ({ kind: "text", text: value });

describe("resolvedIdentityLabel, the rule", () => {
  it("names a person by their own chosen name", () => {
    const identity: ResolvedIdentity = { kind: "Person", name: "Ada" };
    expect(resolvedIdentityLabel(identity)).toEqual(text("Ada"));
  });

  it("names a device by its user-chosen label when it has one", () => {
    const identity: ResolvedIdentity = {
      kind: "Device",
      name: "Ada's Laptop",
      code: "aabbcc",
    };
    expect(resolvedIdentityLabel(identity)).toEqual(text("Ada's Laptop"));
  });

  it("falls back to the device code, never to a blank row", () => {
    const identity: ResolvedIdentity = { kind: "Device", name: null, code: "aabbcc" };
    expect(resolvedIdentityLabel(identity)).toEqual({ kind: "device", code: "aabbcc" });
  });

  it("treats an empty device label as absent rather than as a name", () => {
    const identity: ResolvedIdentity = { kind: "Device", name: "", code: "aabbcc" };
    expect(resolvedIdentityLabel(identity)).toEqual({ kind: "device", code: "aabbcc" });
  });

  it("returns null for Unknown and for an empty name, leaving the copy to the surface", () => {
    // The two surfaces deliberately say different words here ("Unknown device"
    // in history, "Someone" in the roster), so the rule must not supply one.
    expect(resolvedIdentityLabel({ kind: "Unknown" })).toBeNull();
    expect(resolvedIdentityLabel({ kind: "Person", name: "" })).toBeNull();
  });

  it("hands back only arms that carry no code of ours, or the one that does", () => {
    // The union is named after WHICH ARMS COST A TRANSLATION, so this is the property
    // rather than a restatement of the implementation: a name arm is a user's own
    // words and renders verbatim in every language, and only `device` reaches the
    // catalog. A new arm added later has to say which of the two it is.
    for (const v of [
      { kind: "Person", name: "Ada" },
      { kind: "Device", name: "Ada's Laptop", code: "aabbcc" },
      { kind: "Device", name: null, code: "aabbcc" },
    ] as ResolvedIdentity[]) {
      const label = resolvedIdentityLabel(v);
      expect(label).not.toBeNull();
      expect(["text", "device"]).toContain(label!.kind);
    }
  });
});

describe("identityLabelText, the one place a label becomes a string", () => {
  it("renders a user's own name verbatim", () => {
    expect(identityLabelText({ kind: "text", text: "Ada's Laptop" }, t)).toBe("Ada's Laptop");
  });

  it("renders the device arm through the catalog", () => {
    expect(identityLabelText({ kind: "device", code: "aabbcc" }, t)).toBe("Device aabbcc");
  });

  it("renders an EMPTY text arm as the empty string rather than inventing copy", () => {
    // The absent-copy decision belongs to the surface ("Someone" vs "Unknown
    // device"), so the rule must not fill an empty name in.
    expect(identityLabelText({ kind: "text", text: "" }, t)).toBe("");
  });

  it("emits no raw 32-hex id for any arm it can be handed", () => {
    const labels: IdentityLabel[] = [
      text("Ada"),
      text("Ada's Laptop"),
      { kind: "device", code: "aabbcc" },
    ];
    for (const label of labels) {
      expect(identityLabelText(label, t)).not.toMatch(/\b[0-9a-f]{32}\b/i);
    }
  });

  it("emits no raw 32-hex id for any variant the RULE can be handed", () => {
    const variants: ResolvedIdentity[] = [
      { kind: "Person", name: "Ada" },
      { kind: "Device", name: "Ada's Laptop", code: "aabbcc" },
      { kind: "Device", name: null, code: "aabbcc" },
      { kind: "Unknown" },
    ];
    for (const v of variants) {
      const label = resolvedIdentityLabel(v);
      expect(label === null ? "" : identityLabelText(label, t)).not.toMatch(
        /\b[0-9a-f]{32}\b/i,
      );
    }
  });
});

describe("one rule, two surfaces", () => {
  // The claim `tasks.md` states for task 5 ("Do not add a second resolution
  // rule: it must go through the same resolver"). A component that rebuilds the
  // variant switch locally contradicts the shared rule even while every
  // behavioural test passes, because the copy it picks can drift on its own,
  // which is exactly what had happened before this module existed.
  //
  // Each surface reaches the rule by its own route, so each is pinned by the
  // CALL it makes rather than by the rule's name appearing in it: a comment
  // naming the rule satisfies a substring check while the code does something
  // else, and the pane is where that matters, because its call is the only
  // production wiring the presence side has.
  const SURFACES = [
    {
      file: "src/notes/components/SnapshotsPanel.tsx",
      reaches: "resolvedIdentityLabel(author)",
    },
    {
      file: "src/notes/components/PaneView.tsx",
      reaches: "void resolvePeerLabels(",
    },
  ] as const;

  it.each(SURFACES)("$file renders no label of its own", ({ file, reaches }) => {
    const src = source(file);
    expect(src).toContain(reaches);
    // The shape a second rule takes: a local variant switch, or a local read of
    // the device code as a fallback.
    expect(src).not.toMatch(/kind\s*===\s*"Device"/);
    expect(src).not.toMatch(/kind\s*===\s*"Person"/);
    expect(src).not.toMatch(/kind\s*===\s*"Unknown"/);
  });

  it("the pane imports the presence resolver rather than reaching for the rule", () => {
    // The pane's job is the loop, not the copy: it hands the peer set and the
    // backend resolver to `presenceLabels`, which applies the shared rule. It does
    // render the label for one consumer, the editor's caret widget, and it does that
    // by calling `identityLabelText` rather than by choosing an arm itself.
    const src = source("src/notes/components/PaneView.tsx");
    expect(src).toContain('from "../collab/presenceLabels"');
    expect(src).not.toContain("resolvedIdentityLabel(");
    expect(src).toContain("identityLabelText(p.label, t)");
  });

  it("the history list keeps only its own absent-revision copy", () => {
    // The one string the list may still own, and the reason `null` exists.
    const src = source("src/notes/components/SnapshotsPanel.tsx");
    expect(src).toContain('t("notes.snapshots.unknownAuthor")');
    expect(src).toContain("identityLabelText(authorRule, t)");
  });

  it("the roster renders a stored label through the rule rather than switching on it", () => {
    // `WhoIsHereTab` reads `participant.label`, which is a DESCRIPTOR: the roster
    // renders it with the translator it holds at that render, so the row follows a
    // language change. What it must not do is pick an arm itself.
    const src = source("src/notes/components/WhoIsHereTab.tsx");
    expect(src).toContain("identityLabelText(participant.label, t)");
    expect(src).not.toContain("resolvedIdentityLabel");
    expect(src).not.toMatch(/kind\s*===\s*"device"/);
  });
});
