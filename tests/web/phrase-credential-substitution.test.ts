// The recovery-phrase credential cannot be constructed in the web build
// (phase3-web-client task 92).
//
// Two defences stand between a browser and a 24-word phrase, and they are
// deliberately at different layers because each one alone has a hole:
//
//  1. **The UI gate** — `has("phraseEnrolment")` is false, so the arm is not
//     rendered. Bypassed by one `invoke` from a devtools console.
//  2. **The dispatcher** — `web/wasm/src/dispatch.rs` answers the recovery
//     credential kind with a typed `unsupported`, before any network, any KDF
//     and any phrase handling. Covers the console.
//
// This file used to name a third: a build-time substitution of
// `web/src/screens/EnrollPhraseCredential.tsx`, asserted against the built
// bundle by `scripts/check-web-no-phrase.mjs`. Both are deleted
// (`decisions.md` 2026-10-18, entry 0704), so the enrolment grid SHIPS and the
// only things between a browser and a phrase credential are the two above. That
// is a weaker claim than the one this comment made, and it is the true one: the
// code is in the artefact, and the gate that stops it running is the capability
// descriptor plus the dispatcher.
//
// An earlier block here also asserted a substitution of `phrase-credential`
// ITSELF, which no longer exists: the 2026-08-15 reversal ships phrase ENTRY on
// web, so `EnrollDeviceForm` imports the real module and the wordlist has a
// legitimate import edge into the bundle. That block kept passing against a stub
// nothing resolved to, which is a test describing a mechanism the build had
// stopped performing.
//
// The stake is that one exposure is permanent — `protocol.md` §7 preserves the
// phrase across every password change and there is no rotation command — and
// that per `server-protocol.md` §3.1 the recovery path SELF-APPROVES, so a
// phrase credential from a browser would also walk past the device-approval
// gate.

import { describe, expect, it } from "vitest";

const real = await import("../../src/components/sync/phrase-credential");

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
