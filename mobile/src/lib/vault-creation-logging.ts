// Logging discipline for the vault-creation flow.
//
// Per CLAUDE.md and the PRD, the only acceptable log shape is
// `console.error("[vault-creation]", error.kind)` — password / phrase /
// account number / session token / vault path must never reach the log
// stream as strings. These helpers centralize the pattern so every call
// site enforces the discipline structurally.

import type { AppError } from "../types/protocol-error";

export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    typeof (e as { kind: unknown }).kind === "string"
  );
}

export function logErrorKind(e: unknown, fallback: string): void {
  const kind = isAppError(e) ? e.kind : fallback;
  // eslint-disable-next-line no-console
  console.error("[vault-creation]", kind);
}
