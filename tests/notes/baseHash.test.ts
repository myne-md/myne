// `sha256Hex` — the autosave's expected-base fingerprint. Runs in the node
// environment (webcrypto on globalThis); pinned against a known SHA-256
// vector so the Rust side (`Sha256::digest` over the same UTF-8 bytes)
// provably computes the identical value.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/notes/baseHash";

describe("sha256Hex", () => {
  it("matches the canonical SHA-256 vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes the UTF-8 encoding (multibyte input)", async () => {
    // "π" = 0xCF 0x80 in UTF-8; distinct from any Latin-1 interpretation.
    const a = await sha256Hex("π");
    const b = await sha256Hex("p");
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
  });

  it("empty string vector", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
