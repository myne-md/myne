// Shared fixtures for the `myne://theme/install` suites (MYND-567). Both the
// parser suite and the dialog suite need to mint links the way the website
// does; one builder keeps them minting the SAME shape.

/** A minimal but structurally-valid palette (shape only — values are not
 *  value-shape-validated client-side; that is the host's job). */
export const PALETTE: Record<string, string> = {
  "--paper": "#faf6ee",
  "--paper-2": "#f2ede1",
  "--ink-1": "#2b2720",
  "--accent": "#b3603c",
  "--line-1": "#e4ddcd",
};

/** base64url-encode UTF-8 text the way the website's link builder does. */
export function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build a `myne://theme/install` link; `null` drops a parameter entirely. */
export function link(overrides: Record<string, string | null> = {}): string {
  const merged: Record<string, string | null> = {
    v: "1",
    name: "Warm Paper",
    payload: b64url(JSON.stringify(PALETTE)),
    ...overrides,
  };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value !== null) search.set(key, value);
  }
  return `myne://theme/install?${search.toString()}`;
}
