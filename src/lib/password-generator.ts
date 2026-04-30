// CSPRNG-backed random password generator. Uses Web Crypto's
// crypto.getRandomValues with rejection sampling to eliminate modulo bias.
//
// Tauri 2 WebView (WebKit on macOS/Linux, WebView2 on Windows) ships
// crypto.getRandomValues natively; no polyfill required.

const ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" +
  "!@#$%^&*()-_=+[]{}|;:,.<>?/";

export function generatePassword(length = 24): string {
  const ab = ALPHABET;
  // Largest multiple of |alphabet| within 2^32 — values >= max are rejected
  // so the kept values map uniformly onto the alphabet via modulo.
  const max = Math.floor(2 ** 32 / ab.length) * ab.length;
  const out: string[] = [];
  const buf = new Uint32Array(1);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    if (buf[0] < max) {
      out.push(ab[buf[0] % ab.length]);
    }
  }
  return out.join("");
}
