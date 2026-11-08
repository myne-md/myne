// Where the documentation tree lives, for every guard that reads or writes it.
//
// The specification, the threat model, the design canon and the decision log moved out of this
// repository into the private `myne-agents` companion, so a guard that verifies a document now
// depends on a clone that may not be there. Two callers exist and they want opposite things: a
// developer's checkout has the companion beside this repo and must run the gate, while CI clones
// it into a scratch directory and says so with `MYNE_AGENTS_DIR`. A checkout with neither (a fork
// pull request) gets the note below rather than a red that names a file nobody can see.
//
// The root is derived from this file rather than from the caller's cwd, because the guards run
// from the repo root, from `scripts/`, and from a `--root` argument in tests.
//
// SPDX-License-Identifier: AGPL-3.0
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The `docs` directory of the companion: `MYNE_AGENTS_DIR/docs`, else `myne-agents/docs`. */
export const DOCS_ROOT = process.env.MYNE_AGENTS_DIR
  ? join(process.env.MYNE_AGENTS_DIR, "docs")
  : join(REPO, "myne-agents", "docs");

/** Join a path inside the documentation tree. */
export const docsPath = (...parts) => join(DOCS_ROOT, ...parts);

/** Whether the tree is readable from this checkout at all. */
export const docsPresent = () => existsSync(DOCS_ROOT);

/** The one sentence a guard prints when it cannot check anything. */
export const DOCS_ABSENT =
  `the myne-agents companion is not in this checkout (looked in ${DOCS_ROOT}), so this ` +
  "documentation gate did not run; point MYNE_AGENTS_DIR at a clone of it to run it";
