// The ONE parser for `workspace/manifest.txt`.
//
// The manifest is read by three things: `workspace/setup.sh` (which clones what
// it names), `scripts/check-server-env-roster.mjs` (which fails by name when a
// companion it scans is not listed) and `tests/scripts/protectedBranchGuard.test.ts`
// (which derives the expected set of lefthook configs from it). Two of those are
// JavaScript and share this file; the shell half parses the same grammar by hand
// because it cannot import it, which is why the grammar is stated rather than
// assumed:
//
//   <repo-name> [(private)]        `#` starts a comment; blank lines are ignored
//
// A NAME is everything up to the first whitespace. `(private)` is an optional
// trailing annotation meaning "this repository stays private, so an unreachable
// one is expected rather than an error", and it exists so a consumer can tell
// "you are not a member" apart from "this is meant to be public and is missing".
//
// The failure this parser prevents is the silent one: a consumer that reads raw
// lines and compares them as names stops matching the moment an annotation is
// added, and it reports that as either a missing companion or a renamed one.

/** Parse manifest text into `{ name, private }` entries, in file order. */
export function manifestRepos(text) {
  const entries = [];
  for (const raw of text.split("\n")) {
    // A comment ends the line: `myne-ops (private) # why` is one entry, not three.
    const line = raw.replace(/#.*$/, "");
    const trimmed = line.trim();
    if (!trimmed) continue;
    entries.push({
      name: trimmed.split(/\s+/)[0],
      private: /\(private\)/.test(trimmed),
    });
  }
  return entries;
}
