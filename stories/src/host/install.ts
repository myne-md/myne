// Side-effect module: install the story host BEFORE any app module body runs.
//
// `main.tsx` imports this first. ES module evaluation is depth-first in import
// order, so the global exists by the time the first `src/` module that reads it
// at module scope is evaluated. The initial install carries no fixture; the
// shell swaps in each story's fixture before rendering it.
//
// Nothing else belongs in this file. It exists as its own module precisely so
// the ordering is inspectable in one line rather than buried in `main.tsx`.

import { installStoryHost } from "./internals";

installStoryHost();
