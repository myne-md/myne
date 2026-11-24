// Where the public documentation tree lives, for every guard that reads or writes it.
//
// The public tree is `docs/` in this repository. It carries the specification, the threat model,
// the glossary and the bundle-hash record. The decision log, the design canon and the internal
// development notes are private and are not present in a public checkout; a guard that needs one
// of those files must skip with the note below rather than fail on a file no reader can see.
//
// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The public documentation directory. */
export const DOCS_ROOT = join(REPO, "docs");

/** Join a path inside the documentation tree. */
export const docsPath = (...parts) => join(DOCS_ROOT, ...parts);

/** Whether the tree is readable from this checkout at all. */
export const docsPresent = () => existsSync(DOCS_ROOT);

/** The one sentence a guard prints when it cannot check anything. */
export const DOCS_ABSENT =
  `the public docs/ tree is not in this checkout (looked in ${DOCS_ROOT}), so this ` +
  "documentation gate did not run";
