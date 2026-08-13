// The mobile half of the apply payload (MYND-644).
//
// `extractRecord` is what mobile sends to `vault_indices_apply`, and it shipped
// without its `tasks` leg — the same defect desktop had, from the same cause:
// the Rust field is `Option`, so a client that omits it produces an empty
// vector rather than an error. Every mobile task surface listed nothing and no
// layer could tell. These assertions are about the RECORD, not about
// extraction (the extractor has its own suite in the main repo) — they fail if
// the field ever stops being populated.

import { describe, it, expect } from "vitest";
import { extractRecord } from "../src/lib/indices-extract";

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
