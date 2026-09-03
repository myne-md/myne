// The refusal surface for a second tab on the same OPFS container (#254).
//
// Rendered INSTEAD of the app, for the same reason `UnsupportedEnvironment` is:
// the guarantee is a property of the call order, not of a check inside each
// write. A tab that never acquires the lock never starts a Worker, never starts
// the sync loop, and therefore never reaches a write path at all.
//
// It reports rather than takes over. Taking over would move the corruption from
// "two writers" to "one writer whose files vanished underneath it" — the
// double-buffered singleton writes assume exactly one writer choosing which
// buffer is next, and the per-note write-new-then-remove-old sequence assumes
// nobody removes the old copy while it runs.
//
// The reload CTA appears only once the other tab has actually gone: the module
// waits on the lock's release edge and then offers a reload, instead of a
// button the user can press five times against a vault that is still open.
//
// Tone follows PRODUCT.md: this is a limit of how one browser profile can hold
// one container, not a failure of the user.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { waitForVaultLockRelease } from "./vault-lock";

const PAGE: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "32px",
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
};

const CARD: React.CSSProperties = {
  maxWidth: 560,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const H1: React.CSSProperties = { fontSize: 20, fontWeight: "var(--weight-semibold)", margin: 0 };
const P: React.CSSProperties = {
  margin: 0,
  lineHeight: 1.6,
  color: "var(--fg-2)",
};
const CTA: React.CSSProperties = {
  alignSelf: "flex-start",
  padding: "8px 16px",
  borderRadius: "var(--radius-2)",
  border: "1px solid var(--line-2)",
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  cursor: "pointer",
};

/** English source for the copy, passed as `defaultValue` so an untranslated
 *  locale renders an honest sentence rather than a raw dotted key. */
const TITLE = "This vault is open in another tab";
const BODY =
  "Only one tab can hold a vault open at a time. Two would write to the same " +
  "storage and corrupt it. Close the other tab to continue here.";
const FREED = "The other tab has closed. Reload to open your vault here.";
const RELOAD = "Reload";

export function VaultOpenElsewhere({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const [freed, setFreed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void waitForVaultLockRelease(vaultId, controller.signal)
      .then(() => setFreed(true))
      // An aborted wait rejects — that is "this screen unmounted", not "the
      // vault is free". Swallowing it here is safe precisely because the only
      // abort is our own cleanup.
      .catch(() => {});
    return () => controller.abort();
  }, [vaultId]);

  return (
    // `data-freed` is the discriminator the browser E2E reads: which state the
    // screen is in must be legible without depending on the runner browser's
    // language. Closed-set `data-*` plus a stable testid is the sanctioned
    // shape; an interpolated testid is banned outright.
    <main
      style={PAGE}
      data-testid="web.vault-open-elsewhere"
      data-freed={freed ? "true" : "false"}
    >
      <div style={CARD}>
        <h1 style={H1} data-testid="web.vault-open-elsewhere-title">
          {t("web.openElsewhere.title", { defaultValue: TITLE })}
        </h1>
        <p style={P} data-testid="web.vault-open-elsewhere-body">
          {freed
            ? t("web.openElsewhere.freed", { defaultValue: FREED })
            : t("web.openElsewhere.body", { defaultValue: BODY })}
        </p>
        {freed && (
          <button
            type="button"
            style={CTA}
            data-testid="web.vault-open-elsewhere-reload"
            onClick={() => globalThis.location.reload()}
          >
            {t("web.openElsewhere.reload", { defaultValue: RELOAD })}
          </button>
        )}
      </div>
    </main>
  );
}
