// Web substitute for the Myne vault-import setup step (myne-md/myne#464).
//
// # Why the module is replaced rather than the branch gated
//
// `vaultImport` is absent on this client, so `availableSourceOrder()` never
// offers the card and this component is unreachable through the UI. That makes
// it a runtime gate, and a runtime gate is not the bar here: the real module
// renders a field that accepts a 24-word RECOVERY PHRASE, and a hidden field is
// still in the artefact, one devtools breakpoint or one edited route away.
// `scripts/check-web-no-phrase.mjs` exists because exactly that was tried once
// for device enrolment and the grid was found still shipping behind a branch.
//
// `decisions.md` 2026-08-15 bounds this client to asking for the phrase in ONE
// situation, a recovery the user started themselves, and reasons it from
// `threat-model.md` A18: every ROUTINE phrase prompt in a page is what teaches a
// user that typing 24 words into a browser is normal. An import is routine, and
// `protocol.md` §7 is why one exposure is permanent rather than recoverable, so
// the phrase survives every password change and no rotation command exists.
//
// # And the feature is absent on the merits, not merely unported
//
// A browser origin holds exactly ONE container, under a constant vault id
// (`phase3-web-client` task 85). There is no second vault to import FROM, so
// the source list would be permanently empty even with the phrase question
// settled, and `web/wasm/src/capability.rs` classifies the whole `importer:`
// plugin `Class::Unsupported`, so every command behind the flow refuses.
//
// # What this file keeps
//
// The type and the export name, so the shared modal type-checks against the
// same signature. The body throws rather than rendering a placeholder: this is
// not a "not available here" screen a user can reach, it is a branch that
// should be unreachable, and a silent empty render would hide a routing bug
// that made it reachable.

import type { ReactElement } from "react";

export interface MyneVaultSetupProps {
  readonly activeVaultId: string | null;
  readonly onReady: (args: {
    sourceVaultId: string;
    importLabel: string;
    credential: { password: string } | { recoveryPhrase: string };
  }) => void;
  readonly onCancel: () => void;
  readonly onBack?: (() => void) | undefined;
}

export function MyneVaultSetup(_props: MyneVaultSetupProps): ReactElement {
  // A plain Error rather than `PlatformUnsupportedError`: that type's
  // `operation` is the seam's own union of IPC command names, and this is not a
  // seam call that was attempted. It is a component that must never mount.
  throw new Error(
    "MyneVaultSetup is absent on the web client (capability `vaultImport`); " +
      "reaching it means the source picker's capability filter was bypassed",
  );
}
