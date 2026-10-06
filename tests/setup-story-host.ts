// Install the story host before any test file's imports are evaluated
// (myne-md/myne#832).
//
// Vitest setup files run before the test module is imported, so a module-scope
// `invoke` on the app tree lands on this fake rather than on a missing
// `__TAURI_INTERNALS__`. The per-story fixture is swapped inside the specs
// before each render; this initial install is the benign default.

import { installStoryHost } from "../stories/src/host/internals";

installStoryHost();
