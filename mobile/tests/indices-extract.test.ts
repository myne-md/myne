// The mobile half of the apply payload (MYND-644, extended by myne-md/myne#452).
//
// `extractRecord` is what mobile sends to `vault_indices_apply`, and it shipped
// without its `tasks` leg — the same defect desktop had, from the same cause:
// the Rust field is `Option`, so a client that omits it produces an empty
// vector rather than an error. Every mobile task surface listed nothing and no
// layer could tell. These assertions are about the RECORD, not about
// extraction (the extractor has its own suite in the main repo) — they fail if
// the field ever stops being populated.
//
// myne-md/myne#452 found the same defect twice more, one field over each time:
// `headings` and `blockAnchors` were absent from this client's record, so every
// record mobile wrote stored two empty vectors and the `[[##` and `[[^^`
// pickers that read them back opened with zero rows.
//
// **The last describe block is the one that has to exist**, and it is not about
// extraction at all. A record is not a payload: deleting `headings: r.headings`
// from `vaultIndicesApply` leaves every `extractRecord` assertion here passing,
// because `extractRecord` never touches the wire. That is exactly the vacuity
// this repository keeps rediscovering, so the wire is asserted separately, off
// what the binding handed `invoke`.

import { describe, it, expect, vi } from "vitest";
import { extractRecord } from "../src/lib/indices-extract";
import { vaultIndicesApply } from "../src/lib/vault-indices";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

describe("extractRecord carries line-tasks", () => {
  it("populates tasks with typed fields, in document order", () => {
    const record = extractRecord(
      "n1",
      "Ev",
      null,
      ["# Ev", "", "- [ ] kirayı öde [due:: 2026-08-01] [priority:: high]", "- [x] faturayı öde"].join(
        "\n",
      ),
    );

    expect(record.tasks).toHaveLength(2);
    expect(record.tasks[0]).toMatchObject({
      lineIndex: 2,
      completed: false,
      due: "2026-08-01",
      priority: "high",
    });
    // Verbatim: the raw line is the authority a write verifies against.
    expect(record.tasks[0]!.rawLine).toBe(
      "- [ ] kirayı öde [due:: 2026-08-01] [priority:: high]",
    );
    expect(record.tasks[1]).toMatchObject({ lineIndex: 3, completed: true });
  });

  it("yields an empty vector for a note with no tasks", () => {
    // Apply replaces the whole record, so this is what clears a note whose last
    // task was deleted — an absent field would lean on the Rust default.
    expect(extractRecord("n2", "Ev", null, "# Ev\n\nsade bir not\n").tasks).toEqual([]);
  });

  it("yields nothing for a drawing note, whose body is scene JSON", () => {
    const body = "---\nkind: drawing\n---\n- [ ] phantom\n";
    expect(extractRecord("n3", "Çizim", null, body).tasks).toEqual([]);
  });
});

describe("extractRecord carries headings", () => {
  it("carries every ATX level, in document order", () => {
    const body = ["# One", "## Two", "### Three", "#### Four", "##### Five", "###### Six"].join("\n");
    expect(extractRecord("n1", "One", null, body).headings).toEqual([
      { text: "One", level: 1 },
      { text: "Two", level: 2 },
      { text: "Three", level: 3 },
      { text: "Four", level: 4 },
      { text: "Five", level: 5 },
      { text: "Six", level: 6 },
    ]);
  });

  it("carries Setext headings at the levels their underline means", () => {
    // The `[[##` picker ranks on level, so a Setext H1 arriving as level 2
    // would sort and indent wrongly while looking entirely plausible.
    const body = ["Başlık", "======", "", "Alt başlık", "----------", ""].join("\n");
    expect(extractRecord("n2", "Başlık", null, body).headings).toEqual([
      { text: "Başlık", level: 1 },
      { text: "Alt başlık", level: 2 },
    ]);
  });

  it("excludes a hash line inside frontmatter", () => {
    // Frontmatter is a YAML block, not prose. A `#` there is a comment or part
    // of a value, and promoting it to a vault-wide heading would put a config
    // line in the picker.
    const body = ["---", "title: Ev", "# bu bir yorum", "---", "", "# Gerçek"].join("\n");
    expect(extractRecord("n3", "Ev", null, body).headings).toEqual([
      { text: "Gerçek", level: 1 },
    ]);
  });

  it("excludes a hash line inside a fenced code block", () => {
    // Structural, not textual: the exclusion comes from the parse tree, which
    // is the whole reason this client does not own a second heading scanner.
    const body = ["# Gerçek", "", "```sh", "# bu bir kabuk yorumu", "```", ""].join("\n");
    expect(extractRecord("n4", "Gerçek", null, body).headings).toEqual([
      { text: "Gerçek", level: 1 },
    ]);
  });

  it("yields an empty vector for a body with no headings", () => {
    // Apply replaces the whole record, so this is what clears a note whose last
    // heading was deleted.
    expect(extractRecord("n5", "Ev", null, "sade bir not\n").headings).toEqual([]);
    expect(extractRecord("n6", "", null, "").headings).toEqual([]);
  });
});

describe("extractRecord carries block anchors", () => {
  it("carries a line-tail marker with the marker stripped from its preview", () => {
    const body = "Bir paragraf, işaretli ^abc-1\n";
    expect(extractRecord("n7", "Ev", null, body).blockAnchors).toEqual([
      { blockId: "abc-1", preview: "Bir paragraf, işaretli" },
    ]);
  });

  it("previews an own-line marker from the block it refers to", () => {
    // Obsidian's form for a non-paragraph block: the marker sits on its own
    // line and refers to what PRECEDES it, so the marker line strips to empty
    // and the preview has to come from the block above or the picker row is
    // blank.
    const body = ["| a | b |", "|---|---|", "| 1 | 2 |", "^tablo", ""].join("\n");
    expect(extractRecord("n8", "Ev", null, body).blockAnchors).toEqual([
      { blockId: "tablo", preview: "| 1 | 2 |" },
    ]);
  });

  it("yields an empty vector for a body with no markers", () => {
    expect(extractRecord("n9", "Ev", null, "sade bir not\n").blockAnchors).toEqual([]);
  });
});

describe("vaultIndicesApply puts the whole record on the wire", () => {
  // Not a restatement of the blocks above. Those assert what `extractRecord`
  // BUILT; this asserts what the binding SENT, and the two are separated by the
  // one line per field that can go missing without anything noticing.
  it("sends headings and blockAnchors with the rest of the record", async () => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    // The block id is ASCII on purpose: the dialect's marker grammar is
    // `[A-Za-z0-9-]+`, so `^işaret` is not an anchor at all and asserting on one
    // would have made this case pass for the wrong reason.
    await vaultIndicesApply(extractRecord("n1", "Ev", null, "# Ev\n\nmetin ^isaret\n"));

    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("plugin:vault-indices|vault_indices_apply");
    expect(args.headings).toEqual([{ text: "Ev", level: 1 }]);
    expect(args.blockAnchors).toEqual([{ blockId: "isaret", preview: "metin" }]);
  });

  it("sends both fields even when they are empty", async () => {
    // The replace-semantics half, and the one an `toEqual([])` on the record
    // cannot express: apply overwrites the stored vector, so a note whose last
    // heading was just deleted must put an explicit `[]` on the wire. Omitting
    // the key would lean on Rust's `unwrap_or_default()` meaning the same
    // thing, which is a different claim from this client having none.
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    await vaultIndicesApply(extractRecord("n2", "Ev", null, "sade bir not\n"));

    const [, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(args)).toContain("headings");
    expect(Object.keys(args)).toContain("blockAnchors");
    expect(args.headings).toEqual([]);
    expect(args.blockAnchors).toEqual([]);
  });

  // myne-md/myne#848: the working-set verdict is on the wire too, and it is the
  // one field the command takes as REQUIRED rather than `Option` (review
  // finding): a dropped field is a deserialization failure, not a fail-open
  // default, because a default here would put every note back inside a run's
  // reach. The two other trailing fields are display data and keep their
  // `Option`; this one does not.
  it("sends the working-set verdict, false for a trashed note", async () => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    await vaultIndicesApply(
      extractRecord("n3", "Ev", null, "---\ntrashed: 2026-08-01T00:00:00Z\n---\nbody\n"),
    );
    const [, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(args)).toContain("live");
    expect(args.live).toBe(false);
  });

  it("sends live: true for an ordinary note", async () => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    await vaultIndicesApply(extractRecord("n4", "Ev", null, "sade bir not\n"));
    const [, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.live).toBe(true);
  });
});
