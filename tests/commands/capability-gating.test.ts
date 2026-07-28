// Capability gating of the command registry (phase3-web-client task 27).
//
// `COMMAND_ACTIONS` is read by the command palette, the keyboard-shortcut
// resolver AND the settings-search index. Gating at the registry — rather than
// at each of those three render sites — is what makes "hidden from the menu,
// still reachable by shortcut" impossible instead of merely unlikely. That gap
// is the specific failure the task names, so these tests are about the
// registry's filtering, not about any one surface.

import { describe, expect, it } from "vitest";
import { COMMAND_ACTIONS } from "../../src/commands/actions";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync("src/commands/actions.ts", "utf8");

/**
 * Every action id the registry actually exposes.
 *
 * Read from `COMMAND_ACTIONS` rather than scraped from the source. The first
 * version scraped `id: "…"` literals and under-counted by 28: not every action
 * is declared as `const x: CommandAction = { id: "…" }` — the theme and split
 * variants are built by other shapes. Comparing the map against a partial scrape
 * would have "passed" while leaving those 28 unverifiable.
 */
function registryIds(): Set<string> {
  return new Set(COMMAND_ACTIONS.map((a) => a.id));
}

/** The `ACTION_CAPABILITY` map's keys. */
function mappedIds(): Set<string> {
  const start = SOURCE.indexOf("const ACTION_CAPABILITY");
  const end = SOURCE.indexOf("});", start);
  const body = SOURCE.slice(start, end);
  return new Set([...body.matchAll(/"([a-z0-9.\-]+)":\s*"[A-Za-z]+"/g)].map((m) => m[1]));
}

describe("command registry capability gating", () => {
  it("every gated id names a real action", () => {
    // The failure this catches, found the hard way while writing the map: I
    // wrote `vault.restore-backup` where the action's id is `vault.restore`.
    // A capability mapping keyed on a nonexistent id is silently INERT — the
    // action stays ungated and reachable on a platform that cannot run it, and
    // nothing anywhere reports the mismatch.
    const declared = registryIds();
    const unknown = [...mappedIds()].filter((id) => !declared.has(id));
    expect(unknown, "ACTION_CAPABILITY keys that match no action id").toEqual([]);
  });

  it("the map is non-empty and the scan actually parsed", () => {
    // A regex that silently matched nothing would make the assertion above
    // vacuously true — the classic failure of a source-scanning test.
    expect(mappedIds().size).toBeGreaterThan(0);
    expect(registryIds().size).toBeGreaterThan(mappedIds().size);
  });

  it("desktop keeps every gated action", () => {
    // These tests import the DESKTOP seam (vitest resolves `src/platform/`
    // unsubstituted), so nothing should be filtered out. Asserted against the
    // GATED set specifically — those are the only ones the filter can drop, so
    // this is the assertion that would fail if the desktop descriptor ever lost
    // a capability it should have.
    const present = registryIds();
    for (const id of mappedIds()) {
      expect(present.has(id), `${id} is gated but missing from the desktop registry`).toBe(
        true,
      );
    }
  });

  it("no two actions share an id", () => {
    // Ids are the gating key; a duplicate would make one of the pair
    // ungatable, because the map is keyed by id.
    const ids = COMMAND_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
