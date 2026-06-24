// Generator for the `frontmatter-surgery` vector category — the TS-side
// analogue of the protocol crate's `#[ignore]` generators. Runs only when
// GEN_FM_SURGERY=1; writes cases.json into the companion repo, self-validating
// each case for idempotency (patch∘patch == patch) and purity (input bytes
// untouched) before emitting.
//
//   GEN_FM_SURGERY=1 pnpm vitest run tests/dialect/_genFrontmatterSurgeryVectors.test.ts
//
// Live runner: `frontmatterSurgery.test.ts`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  patchArchivedField,
  patchFolderField,
  patchFolderIndexField,
  patchFrontmatterField,
  patchTemplateField,
  patchTitleField,
  patchTrashedField,
  patchUpdatedField,
  TEMPLATE_FLAG_VALUE,
} from "../../src/dialect/surgery";

const enc = new TextEncoder();
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type Kind =
  | "updated"
  | "title"
  | "folder"
  | "trashed"
  | "archived"
  | "template"
  | "folder-index"
  | "generic";

type Spec = {
  slug: string;
  kind: Kind;
  desc: string;
  source: string;
  iso?: string; // updated
  value?: string | null; // title/folder/trashed/archived/template/generic
  flag?: boolean; // folder-index
  key?: string; // generic
};

const NO_FM = "Just a note body.\n";
const WITH_FM = "---\ntitle: Old Title\nupdated: 2020-01-01T00:00:00Z\nfolder: Old/\n---\n\nBody text.\n";
const ISO = "2026-06-24T12:30:00Z";

function applyPatch(s: Spec, bytes: Uint8Array): Uint8Array {
  switch (s.kind) {
    case "updated":
      return patchUpdatedField(bytes, s.iso!);
    case "title":
      return patchTitleField(bytes, s.value as string);
    case "folder":
      return patchFolderField(bytes, s.value ?? null);
    case "trashed":
      return patchTrashedField(bytes, s.value ?? null);
    case "archived":
      return patchArchivedField(bytes, s.value ?? null);
    case "template":
      return patchTemplateField(bytes, s.value ?? null);
    case "folder-index":
      return patchFolderIndexField(bytes, s.flag!);
    case "generic":
      return patchFrontmatterField(bytes, s.key!, s.value ?? null);
  }
}

const SPECS: Spec[] = [
  { slug: "add-to-bare-note", kind: "updated", desc: "Stamping updated on a note with no frontmatter inserts a new frontmatter block.", source: NO_FM, iso: ISO },
  { slug: "replace-existing", kind: "updated", desc: "Stamping updated replaces the existing updated value in place.", source: WITH_FM, iso: ISO },

  { slug: "add-title", kind: "title", desc: "Setting the title on a note with no frontmatter inserts it.", source: NO_FM, value: "Meeting notes" },
  { slug: "replace-title", kind: "title", desc: "Setting the title replaces the existing one.", source: WITH_FM, value: "New Title" },
  { slug: "title-needs-quoting", kind: "title", desc: "A title containing a colon+space is YAML-quoted.", source: WITH_FM, value: "Q3: planning" },

  { slug: "set-folder", kind: "folder", desc: "Setting the folder replaces the existing folder value.", source: WITH_FM, value: "Projects/" },
  { slug: "remove-folder", kind: "folder", desc: "Passing null removes the folder field.", source: WITH_FM, value: null },

  { slug: "set-trashed", kind: "trashed", desc: "Setting trashed inserts a trashed timestamp field.", source: WITH_FM, value: "2026-06-24T00:00:00Z" },
  { slug: "remove-trashed", kind: "trashed", desc: "Passing null on a note without trashed is a no-op (field stays absent).", source: WITH_FM, value: null },

  { slug: "set-archived", kind: "archived", desc: "Setting archived inserts an archived timestamp field.", source: WITH_FM, value: "2026-06-24T00:00:00Z" },
  { slug: "remove-archived", kind: "archived", desc: "Passing null on a note without archived is a no-op.", source: WITH_FM, value: null },

  { slug: "set-template", kind: "template", desc: "Marking a note as a template inserts the template flag.", source: WITH_FM, value: TEMPLATE_FLAG_VALUE },
  { slug: "remove-template", kind: "template", desc: "Passing null on a note without the template flag is a no-op.", source: WITH_FM, value: null },

  { slug: "folder-index-on", kind: "folder-index", desc: "Turning the folder-index flag on inserts it.", source: WITH_FM, flag: true },
  { slug: "folder-index-off", kind: "folder-index", desc: "Turning the folder-index flag off on a note without it is a no-op.", source: WITH_FM, flag: false },

  { slug: "generic-set", kind: "generic", desc: "Setting an arbitrary frontmatter key inserts it.", source: WITH_FM, key: "status", value: "draft" },
  { slug: "generic-remove", kind: "generic", desc: "Setting an arbitrary key to null removes it.", source: WITH_FM, key: "title", value: null },
];

function build(): string {
  const cases = SPECS.map((s) => {
    const input = enc.encode(s.source);
    const snapshot = Uint8Array.from(input);
    const out = applyPatch(s, input);
    // Purity: the input buffer must be untouched.
    if (toHex(input) !== toHex(snapshot)) {
      throw new Error(`[${s.kind}/${s.slug}] patch mutated its input`);
    }
    // Idempotency: re-applying the same patch is a fixed point.
    const twice = applyPatch(s, out);
    if (toHex(twice) !== toHex(out)) {
      throw new Error(`[${s.kind}/${s.slug}] patch is not idempotent`);
    }
    const c: Record<string, unknown> = {
      vector_id: `frontmatter-surgery/v0.1/${s.slug}`,
      description: s.desc,
      case_kind: s.kind,
      input_plaintext_utf8_hex: toHex(input),
      informational_plaintext: s.source,
    };
    if (s.kind === "updated") c.input_iso = s.iso;
    else if (s.kind === "folder-index") c.input_flag = s.flag;
    else if (s.kind === "generic") {
      c.input_key = s.key;
      if (s.value !== null && s.value !== undefined) c.input_value_utf8_hex = toHex(enc.encode(s.value));
    } else if (s.kind === "title") {
      c.input_value_utf8_hex = toHex(enc.encode(s.value as string));
    } else {
      // folder / trashed / archived / template — nullable
      if (s.value !== null && s.value !== undefined) c.input_value_utf8_hex = toHex(enc.encode(s.value));
    }
    c.expected_output_utf8_hex = toHex(out);
    c.informational_output = Buffer.from(out).toString("utf8");
    return c;
  });
  const doc = {
    schema: "frontmatter-surgery",
    protocol_version: "v0.1",
    spec_section: "markdown-dialect.md (frontmatter field surgery)",
    description:
      "Pins protocol-adjacent frontmatter field patchers in src/dialect/surgery.ts — pure Uint8Array → Uint8Array transforms that insert/replace/remove a single frontmatter field while leaving the rest of the note (and YAML formatting) byte-stable. Eight case_kinds, one per patcher: updated (patchUpdatedField, ISO arg), title (patchTitleField), folder/trashed/archived/template (nullable patchers — value null removes the field; an absent input_value_utf8_hex encodes null), folder-index (patchFolderIndexField, boolean flag), generic (patchFrontmatterField, key+nullable value). Each output is a fixed point (idempotent) and the patch is pure (input untouched). TS-runner category (no Rust generator); the live patchers are asserted by tests/dialect/frontmatterSurgery.test.ts.",
    cases,
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

const ENABLED = process.env.GEN_FM_SURGERY === "1";
const maybe = ENABLED ? describe : describe.skip;
maybe("regenerate frontmatter-surgery vectors", () => {
  it("writes frontmatter-surgery/v0.1/cases.json", () => {
    const out = build();
    const dir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../myne-test-vectors/vectors/frontmatter-surgery/v0.1",
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cases.json"), out);
    console.warn("[ok] wrote frontmatter-surgery/v0.1/cases.json");
  });
});
