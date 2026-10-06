// SPDX-License-Identifier: AGPL-3.0
// The two platform caveats owed by any screen that shows a once-only secret and
// offers to copy it.
//
// Both are chosen off `has(...)` rather than written once, and that is a
// `recovery-flow.md` §2.2 requirement as amended 2026-08-15: a client may not
// claim a guarantee it cannot perform. The desktop copy sentence promises a
// clipboard clear in 30 seconds; where `clipboardAutoClear` is absent nothing is
// scheduled at all, so the screen says so instead.
//
// Extracted alongside `PhraseGrid` (myne-md/myne#468) so the recovery kit, which
// exports the phrase and the account number as one file, renders the same two
// lines as the phrase-only screens rather than a second copy of them.

import { useTranslation } from "react-i18next";
import { has } from "../platform/capabilities";
import type { CSSProperties } from "react";

/**
 * Secondary ink and the small type scale: facts to read once, not warnings to be
 * alarmed by (`PRODUCT.md` register; `docs/design/README.md` voice).
 */
const CAVEAT_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  margin: 0,
  maxWidth: 560,
};

export interface SecretDisplayCaveatsProps {
  /** Testid stem: `<stem>-clipboard-notice` and `<stem>-extension-notice`. */
  testIdPrefix: string;
}

export function SecretDisplayCaveats({ testIdPrefix }: SecretDisplayCaveatsProps) {
  const { t } = useTranslation();
  return (
    <>
      {!has("clipboardAutoClear") && (
        <p data-testid={`${testIdPrefix}-clipboard-notice`} style={CAVEAT_STYLE}>
          {t("vaultCreation.phrase.clipboardNotCleared")}
        </p>
      )}
      {!has("screenCaptureProtection") && (
        <p data-testid={`${testIdPrefix}-extension-notice`} style={CAVEAT_STYLE}>
          {t("vaultCreation.phrase.extensionNotice")}
        </p>
      )}
    </>
  );
}
