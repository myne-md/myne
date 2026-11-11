// @vitest-environment node
//
// Redundant entry (3.3.7) and consistent help (3.2.6)
// (myne-md/myne#728, task 15).
//
// Both criteria came back CLEAN, and both are recorded here rather than only
// in progress.md, because a clean audit that lives in a session log is an
// audit that gets redone. What is checked is the thing that would change the
// answer: a value starting to be asked twice for a reason that is not one of
// 3.3.7's exceptions, and a help mechanism appearing in a second place.
//
// 3.3.7 (Redundant Entry): information already entered in the same process may
// not be asked for again, unless re-entering is essential, is required for
// security, or the earlier answer is no longer valid.
//
// 3.2.6 (Consistent Help): IF a help mechanism is provided on multiple pages,
// it must be in the same relative place. It does not require help to exist.
// Myne provides none in-app, so the criterion imposes nothing today, and the
// scan below is what notices when that stops being true.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── 3.2.6 ────────────────────────────────────────────────────────────────

/**
 * Outbound links the app offers, each classified as a 3.2.6 help mechanism or
 * not. WCAG's help mechanisms are human contact details, a human contact
 * mechanism, a self-help option (a help page or FAQ) or an automated contact
 * mechanism. A legal document and a threat model are none of those: they are
 * reference material the user went looking for, not help with using the page.
 */
const OUTBOUND: Record<string, { help: boolean; what: string }> = {
  "https://myne.md/download": { help: false, what: "the download page, offered when a client is out of date" },
  "https://myne.md/impressum/": { help: false, what: "a legal document (German imprint requirement)" },
  "https://myne.md/themes/": { help: false, what: "the theme gallery, a content source" },
  "https://myne.md/threat-model": { help: false, what: "the published threat model, reference material" },
  "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF": { help: false, what: "a model card, shown beside the AI model picker" },
  "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF": { help: false, what: "a model card for the on-demand tag model, shown beside the AI model picker" },
  "https://huggingface.co/openai/whisper-base": { help: false, what: "a model card, shown beside the transcription model" },
  "https://ollama.com": { help: false, what: "a third-party runtime's home page" },
  // The client roster's per-client documentation URLs (mcp external access rework,
  // myne-md/myne#1052). They are a PROVENANCE record rather than a link the app
  // offers: each one names where that client's configuration shape was read, is
  // rendered nowhere, and is never opened by a user. They are classified rather
  // than removed because the entry is what lets a later reader tell a verified
  // shape from a remembered one.
  "https://modelcontextprotocol.io/docs/develop/connect-local-servers": { help: false, what: "the MCP local-server page, provenance for the generic and Claude Desktop shapes" },
  "https://docs.anthropic.com/en/docs/claude-code/mcp": { help: false, what: "Claude Code's MCP page, provenance for its snippet shape" },
  "https://cursor.com/docs/mcp": { help: false, what: "Cursor's MCP page, provenance for its required stdio type" },
  "https://opencode.ai/docs/mcp-servers/": { help: false, what: "OpenCode's MCP page, provenance for its nested local-server shape" },
  // The `$schema` URL inside the snippet itself, not a link the app offers.
  "https://opencode.ai/config.json": { help: false, what: "OpenCode's config schema id, written into the snippet verbatim" },
  "https://code.visualstudio.com/docs/copilot/reference/mcp-configuration": { help: false, what: "VS Code's MCP configuration reference, provenance for its native servers key" },
  "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp": { help: false, what: "Hermes' MCP page, provenance for its YAML mcp_servers map" },
};

// Every client tree, because the roster entry for 3.2.6 claims `web` among
// its clients and this file is what it names as the automated half. The first
// version scanned two trees, so a help link added in `web/src`, `mobile/src`
// or `editor/src` would never have been classified and the "no help mechanism
// is offered" assertion would have been made over a partial denominator.
// Latent rather than live when it was found: no `https://` literal exists in
// those three today, which is exactly why nobody would have noticed the first
// one.
const ROOTS = [
  "src",
  "client-core/src",
  "web/src",
  "mobile/src",
  "editor/src",
] as const;

function filesUnder(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") filesUnder(full, out);
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function outboundUrls(): string[] {
  const found = new Set<string>();
  for (const root of ROOTS) {
    for (const file of filesUnder(root)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/"(https:\/\/[^"${}]+)"/g)) found.add(m[1] as string);
    }
  }
  return [...found].sort();
}

describe("help stays in one place, because there is one place", () => {
  it("classifies every outbound link the app offers", () => {
    const unclassified = outboundUrls().filter((u) => !(u in OUTBOUND));
    expect(
      unclassified,
      `New outbound link(s). If any is a help mechanism (a help page, an FAQ, a contact route), 3.2.6 requires it to sit in the SAME relative place on every screen that offers it. Classify it here and say where it lives.\n${unclassified.join("\n")}`,
    ).toEqual([]);
  });

  it("a classification does not outlive its link", () => {
    const present = new Set(outboundUrls());
    const stale = Object.keys(OUTBOUND).filter((u) => !present.has(u));
    expect(stale, stale.join("\n")).toEqual([]);
  });
});
