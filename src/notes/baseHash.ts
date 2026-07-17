// SHA-256 hex of a note body — the autosave's expected-base fingerprint for
// the `note_update` §11.3 guard (`expectedBaseHashHex`). First `crypto.subtle`
// use in the desktop frontend: every Tauri v2 WebView origin is a secure
// context (tauri://localhost / http://tauri.localhost, and dev
// http://localhost:1420), so SubtleCrypto is guaranteed present. The UTF-8
// encode here matches the Rust side byte-for-byte (Tauri serde delivers the
// same UTF-8 string bytes to `Sha256::digest(plaintext)`).

/** SHA-256 of the UTF-8 encoding of `text`, as 64 lowercase hex chars. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
