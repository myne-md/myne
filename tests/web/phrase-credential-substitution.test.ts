// The recovery-phrase credential cannot be constructed in the web build
// (phase3-web-client task 92).
//
// Three defences stand between a browser and a 24-word phrase, and they are
// deliberately at different layers because each one alone has a hole:
//
//  1. **The UI gate** — `has("phraseRecovery")` is false, so the arm is not
//     rendered. Bypassed by one `invoke` from a devtools console.
//  2. **The dispatcher** — `web/wasm/src/dispatch.rs` answers the recovery
//     credential kind with a typed `unsupported`, before any network, any KDF
//     and any phrase handling. Covers the console, but the CODE still shipped.
//  3. **The substitution — this file.** The module that imports
//     `bip39-normalize` is replaced at build time, so served code has no import
//     edge to the wordlist at all. That is stronger than the grep it replaces:
//     a grep describes today's tree-shake of a runtime branch, and this
//     describes the module graph.
//
// The stake is that one exposure is permanent — `protocol.md` §7 preserves the
// phrase across every password change and there is no rotation command — and
// that per `server-protocol.md` §3.1 the recovery path SELF-APPROVES, so a
// phrase credential from a browser would also walk past the device-approval
// gate.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const real = await import("../../src/components/sync/phrase-credential");
const web = await import("../../web/src/components/sync/phrase-credential");

const PHRASE = Array.from({ length: 24 }, () => "abandon");

describe("the desktop module", () => {
  it("builds a normalised credential", () => {
    expect(real.buildPhraseCredential(PHRASE)).toBe(PHRASE.join(" "));
  });

  it("normalises rather than concatenating — the phrase feeds Argon2id directly", () => {
    // `protocol.md` §7: no PBKDF2 step, so whitespace and Unicode form change
    // the derived key. A "tidy-up later" reading of this call is wrong.
    expect(real.buildPhraseCredential(["  abandon ", "ability"])).toBe("abandon ability");
  });

  it("offers the 24 cells the protocol specifies", () => {
    expect(real.PHRASE_CELL_COUNT).toBe(24);
  });
});

describe("the web substitution", () => {
  /**
   * It THROWS rather than returning an empty string, and that choice is the
   * test. An empty credential would reach `sync_enroll` and fail there as a
   * wrong credential — the same message a mistyped password gets — so a bug
   * that resurrected this path would read as user error and stay in the
   * product. A throw names the boundary at the moment it is crossed.
   */
  it("refuses to construct a credential, loudly", () => {
    expect(() => web.buildPhraseCredential(PHRASE)).toThrow(/recovery-phrase credential/);
  });

  /** Zero, not 24: a caller still mapping over a grid renders nothing rather
   *  than 24 empty inputs no code on this client can read. */
  it("has no grid", () => {
    expect(web.PHRASE_CELL_COUNT).toBe(0);
  });

  /**
   * The structural claim, asserted on the SOURCE rather than on behaviour: the
   * substitute must not import the wordlist, however it is later edited. A
   * behavioural test cannot see an import that is present but unused, and an
   * unused import is exactly what a bundler would still pull in.
   */
  it("imports nothing at all", () => {
    const src = readFileSync("web/src/components/sync/phrase-credential.ts", "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toContain("bip39");
  });

  /** The two modules must stay interface-compatible, or the substitution stops
   *  being a substitution and starts being a build break nobody sees until the
   *  web bundle is built. */
  it("exports the same names as the module it replaces", () => {
    expect(Object.keys(web).sort()).toEqual(Object.keys(real).sort());
  });
});
