// The web build's substitute for the creation flow's local-disk affordances
// (`decisions.md` 2026-08-15).
//
// Renders nothing, and is never rendered: both controls it replaces need a disk
// this client does not have. "Back up now" writes a `.myne-backup` through a
// native save dialog (`backup` and `nativeSaveAs` are both absent capabilities
// here), and "Show vault folder" reveals a directory in an OS file manager,
// which an OPFS container does not have and a page cannot ask for.
//
// It exists so the MODULE is not in the bundle rather than merely unreachable:
// `src/lib/vault-backup.ts` carries five `plugin:backup|*` command names and is
// recorded `excluded` by `scripts/check-web-surfaces.mjs`, which reads the built
// artefact. A runtime gate would leave those names in the served code and the
// gate would fail — correctly.
//
// Typed identically to the module it replaces so the substitution is invisible
// to the caller and `tsc` still checks the call site.

export interface ReadyLocalArtefactsProps {
  pending: boolean;
  vaultId: string | null;
}

export function ReadyLocalArtefacts(_props: ReadyLocalArtefactsProps) {
  return null;
}
