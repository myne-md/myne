// Which AI call site declares which provenance (ai-remote-providers task 8,
// SYNC-14).
//
// **Why this is a source-reading test rather than a behavioural one.** The bar
// itself is host-side and proved there (`state.rs::remote_bar_proof` shows an
// ambient request opens zero sockets). What the host cannot check is whether
// each *call site* declares the truth about itself — that is a property of the
// TypeScript, and getting it wrong is silent: ghost text declaring
// user-initiated would route every keystroke to a metered provider, and the
// host would be right to serve it.
//
// The constraint that makes a naive version wrong: **ghost text and the
// deliberate slash commands used to share one command.** A bar keyed on the
// command name bars everything or nothing, which is why `infer_ambient` exists
// as its own command and why the split has to be asserted at the call sites.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** Code lines only — a doc comment naming a command is documentation, and this
 *  test is about what runs. (The provider-registry check learned this the hard
 *  way when a header sentence tripped its own scan.) */
function codeOf(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const WRITING_ASSISTANT = read("../../src/lib/writing-assistant.ts");
const GHOST_TEXT = read("../../editor/src/ai/ghostText.ts");
const AI_SLASH = read("../../editor/src/slash/aiSlash.ts");

describe("AI call-site provenance (SYNC-14)", () => {
  it("exposes two distinct commands, one per class", () => {
    // The mechanism: the class is decided by WHICH COMMAND RAN, host-side.
    // Inferring it from a payload field would be reading a caller-supplied
    // value and calling it a property of the seam.
    const code = codeOf(WRITING_ASSISTANT);
    expect(code).toContain('"plugin:local-inference|infer"');
    expect(code).toContain('"plugin:local-inference|infer_ambient"');
  });

  it("ghost text — the one surface that fires without being asked — declares AMBIENT", () => {
    const code = codeOf(GHOST_TEXT);
    expect(code).toContain("inferAmbient(");
    // The load-bearing negative: it must NOT reach the user-initiated door.
    // `inferAmbient` contains `infer`, so match a call rather than a substring.
    expect(code).not.toMatch(/[^A-Za-z]infer\s*\(/);
  });

  it("the deliberate slash commands declare USER-INITIATED", () => {
    const code = codeOf(AI_SLASH);
    // `/devam` and `/yeniden-yaz` are things the user asked for, now.
    expect(code).toMatch(/[^A-Za-z]infer\b/);
    expect(code).not.toContain("inferAmbient");
  });

  it("the two wrappers cannot be confused: each invokes only its own command", () => {
    // Extract each exported wrapper's body and check it names exactly one
    // command. A wrapper that fell through to the other would satisfy every
    // assertion above while sending ambient traffic through the open door.
    const body = (name: string): string => {
      const start = WRITING_ASSISTANT.indexOf(`export async function ${name}(`);
      expect(start, `${name} must exist`).toBeGreaterThan(-1);
      const next = WRITING_ASSISTANT.indexOf("\nexport ", start + 1);
      return WRITING_ASSISTANT.slice(start, next === -1 ? undefined : next);
    };
    const plain = codeOf(body("infer"));
    const ambient = codeOf(body("inferAmbient"));
    expect(plain).toContain("|infer\"");
    expect(plain).not.toContain("infer_ambient");
    expect(ambient).toContain("infer_ambient");
  });

  it("the content-scoped gate is not local-only", () => {
    // `ai_excluded_folders` is the OTHER control (SYNC-14 has two halves: a
    // time-scoped bar and a content-scoped one). It lives in the shared entry
    // gate every surface passes through, so it applies to whichever backend is
    // active — there is no per-backend branch that could make it local-only.
    const code = codeOf(WRITING_ASSISTANT);
    expect(code).toContain("isNoteAiExcluded");
    expect(code).toContain("export function aiEntryAllowed");
    // No backend/provider conditional anywhere near the gate.
    for (const branch of ["backendClass", "isRemote", "provider ===", "backendId"]) {
      expect(code, `${branch} must not gate the folder exclusion`).not.toContain(branch);
    }
  });
});
