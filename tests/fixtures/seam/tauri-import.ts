// The module-specifier rule, which must keep working unchanged.
import { invoke } from "@tauri-apps/api/core";

// …and a PROSE mention, which must not be a violation: the import rule is
// quote-anchored, so a package name in a comment (@tauri-apps/plugin-dialog)
// reads as text.
export const call = invoke;
