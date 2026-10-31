// Settings → Account → Danger zone → Delete vault confirmation form.
// Sub-view of AccountPanel — replaces the panel content (NOT a stacked
// modal) per `design-notes.md` 2026-05-08 single-modal-layer
// discipline and Q2 of the MYND-108 grill.
//
// Two render modes driven by `partialFailContext`:
//   - M1 idle (`null`): IRREVERSIBLE eyebrow + two-tier warning copy +
//     typed-DELETE input (case-sensitive, exact match gate) + Cancel +
//     Delete vault button row. Submit disabled until input === "DELETE"
//     and !inFlight.
//   - M2/M3 post-fail (non-null): same heading; warning copy + input +
//     Cancel/Submit row replaced by a DestructiveBanner (count + path
//     for PartialDelete, generic disk-error for Io) and a single
//     Continue button. The slot is already zeroized backend-side; this
//     terminal "Continue" fires the same `onContinueAfterPartial`
//     success signal as the happy-path Submit.
//
// Presentational only — owns no IPC, no Stage dispatch, no
// `appDataDir()` call. AccountPanel (consumer) drives state.
//
// **No "Re-display recovery phrase" affordance anywhere** — Story 17 +
// `docs/spec/recovery-flow.md` §2.4 explicit prohibition.

// A third render axis, orthogonal to the two above (phase3-web-client task 72):
// **what the command means on this client.** Where `localOnlyVault` is absent —
// the web client, whose OPFS container is a cache of a sync-held vault — this
// same command erases THIS browser's copy and leaves the account and everything
// already synced on the server. The desktop wording ("permanently deletes… the
// action cannot be undone… your recovery phrase will not restore the data") is
// false there in the dangerous direction: someone trying to destroy their notes
// would believe they had. So the idle-mode copy is selected by the capability
// and its body is a load-bearing constant, not an i18n string — same rule as
// `REMOVE_DEVICE_DISCLOSURE` (`src/AGENTS.md`, "Do NOT i18n load-bearing copy").
//
// The typed-DELETE gate does NOT relax on that path. Unsynced edits die with the
// local copy and nothing brings them back, which is the one genuinely
// irreversible thing the web erase does — and the last sentence of the
// disclosure is exactly that sentence.

import { useId, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./primitives/Button";
import { Input } from "./primitives/Input";
import { HelperDisclosure } from "./settings/HelperDisclosure";
import { DestructiveBanner } from "./DestructiveBanner";
import { has } from "../platform/capabilities";
import {
  LOCAL_ERASE_DISCLOSURE,
  MEMBER_VAULT_REMOVAL_DISCLOSURE,
} from "../lib/load-bearing-copy";

const CONFIRM_PHRASE = "DELETE";

// Re-exported from the canonical lib module so existing import sites
// (`import type { DeleteVaultPartialFailContext } from "../DeleteVaultConfirmForm"`)
// keep working without churn. Source-of-truth lives in
// `src/lib/vault-delete.ts` alongside `mapDeleteVaultError`.
export type { DeleteVaultPartialFailContext } from "../lib/vault-delete";
import type { DeleteVaultPartialFailContext } from "../lib/vault-delete";

interface DeleteVaultConfirmFormProps {
  /**
   * Idle-mode Submit handler. Invoked only when the typed phrase
   * matches `"DELETE"` exactly (case-sensitive) and `inFlight` is
   * false. Consumer (AccountPanel) fires the `vault_delete` IPC.
   */
  onSubmit: () => void;
  /**
   * Idle-mode Cancel handler. Returns the host AccountPanel from the
   * `"delete-vault"` sub-view back to `"idle"`. Hidden in post-fail
   * mode (the slot is already Empty; there is no panel-idle to return
   * to without a Stage transition).
   */
  onCancel: () => void;
  /**
   * Post-fail Continue handler. Fired on user click after the banner
   * is shown. Same terminal effect as the happy-path Submit — the
   * consumer signals delete-success and App.tsx reprobes, routing by
   * remaining vault count.
   */
  onContinueAfterPartial: () => void;
  /**
   * Externally disable Submit + Cancel (e.g., during the
   * `vault_delete` IPC window). Honors the existing
   * `onInFlightChange` chain mirrored from change-password.
   */
  inFlight?: boolean;
  /**
   * Non-null switches the form to post-fail mode. `kind` selects the
   * banner copy (PartialDelete vs Io); `vaultDirPath` is the
   * UI-resolved `<app_data_dir>/vault` string for the manual-cleanup
   * pointer per PRD §"F3" (UI-side path display is legitimate; backend
   * DENY-list discipline forbids surfacing path via tracing, not
   * via the response itself).
   */
  partialFailContext: DeleteVaultPartialFailContext | null;
  /**
   * Which sentence this form is making, and it is not a styling switch
   * (audit 2026-10-18 K2-i, shipped 2026-10-19).
   *
   * `"owner"` (the default) is the owner's destructive delete: permanent, no
   * recovery phrase will bring it back, the vault is gone.
   *
   * `"member"` is a SHARED vault being removed from this device: the vault and its
   * notes stay on the server and on the owner's other devices, the member's
   * account is untouched, and it is NOT a removal from the vault (only its owner
   * can do that). The owner copy said to a member is false twice, in the
   * dangerous direction each time, which is why this is a prop rather than a
   * rewritten heading: the two claims are different claims, not two wordings.
   */
  variant?: "owner" | "member";
}

const HEADING_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "baseline",
  gap: "var(--space-3)",
};

const HEADING_STYLE: CSSProperties = {
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
  margin: 0,
  letterSpacing: "var(--tracking-tight)",
};

const EYEBROW_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--danger)",
};

const COPY_PRIMARY_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-1)",
  margin: 0,
};

/** The disclosure trigger's row, on the primary paragraph's left edge. */
const DISCLOSURE_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  margin: 0,
};

const INPUT_LABEL_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const INPUT_HINT_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  marginTop: "var(--space-1)",
};

const BUTTON_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "var(--space-2)",
  justifyContent: "flex-end",
  marginTop: "var(--space-2)",
};

const VAULT_PATH_STYLE: CSSProperties = {
  display: "block",
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg-2)",
  wordBreak: "break-all",
};

export function DeleteVaultConfirmForm({
  onSubmit,
  onCancel,
  onContinueAfterPartial,
  inFlight,
  partialFailContext,
  variant = "owner",
}: DeleteVaultConfirmFormProps) {
  const { t } = useTranslation();
  const detailsId = useId();
  const [typed, setTyped] = useState("");
  const submitReady = typed === CONFIRM_PHRASE && !inFlight;
  // Read once per render, not memoised: the seam is a synchronous constant
  // lookup by construction (`src/platform/capabilities.ts`), so caching it would
  // add a dependency array to protect nothing.
  const onlyCopy = has("localOnlyVault");
  // A DIFFERENT question from `onlyCopy`, and conflating the two is what shipped
  // this line on the one client that has no keychain: `localOnlyVault` says
  // whether this client's copy is the only one, while the disclosure below is
  // about a system keychain. This predicate separates the browser (where no
  // per-vault keychain item was ever created, and whose copy is a different
  // claim about a different store) from the Tauri clients. It does NOT mean "a
  // keychain item exists here": on desktop the capability is true for every
  // platform, and the sentence itself names the ones that have a key.
  const hasKeychainItem = has("biometricQuickUnlock");

  // The member arm FIRST, and it does not fold into `onlyCopy`: a member vault on
  // a sync-backed client is both (this device's copy is a cache AND the removal is
  // not a deletion), so the two questions are independent and the member one
  // decides the claims.
  const copy =
    variant === "member"
      ? {
          heading: t("settings.deleteVault.memberHeading"),
          eyebrow: t("settings.deleteVault.memberEyebrow"),
          primary: MEMBER_VAULT_REMOVAL_DISCLOSURE,
          primaryTestId: "delete-vault.member-removal-disclosure",
          submit: inFlight
            ? t("settings.deleteVault.memberSubmitInFlight")
            : t("settings.deleteVault.memberSubmit"),
        }
      : onlyCopy
        ? {
            heading: t("settings.deleteVault.heading"),
            eyebrow: t("settings.deleteVault.eyebrow"),
            primary: t("settings.deleteVault.copyPrimary"),
            primaryTestId: null,
            submit: inFlight
              ? t("settings.deleteVault.submitInFlight")
              : t("settings.deleteVault.submit"),
          }
        : {
            heading: t("settings.deleteVault.localEraseHeading"),
            eyebrow: t("settings.deleteVault.localEraseEyebrow"),
            primary: LOCAL_ERASE_DISCLOSURE,
            primaryTestId: "delete-vault.local-erase-disclosure",
            submit: inFlight
              ? t("settings.deleteVault.localEraseSubmitInFlight")
              : t("settings.deleteVault.localEraseSubmit"),
          };

  const handleSubmit = () => {
    if (!submitReady) return;
    onSubmit();
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4)",
        alignSelf: "stretch",
        width: "100%",
      }}
    >
      <div style={HEADING_ROW_STYLE}>
        <h3 style={HEADING_STYLE} data-testid="delete-vault.heading">
          {copy.heading}
        </h3>
      </div>

      {partialFailContext === null ? (
        <>
          <div style={EYEBROW_STYLE} data-testid="delete-vault.eyebrow">
            {copy.eyebrow}
          </div>
          <p
            style={COPY_PRIMARY_STYLE}
            {...(copy.primaryTestId === null ? {} : { "data-testid": copy.primaryTestId })}
          >
            {copy.primary}
          </p>
          {/* The mechanics, one press away (myne-md/myne#960). These two
              sentences were two grey paragraphs under the warning, which is the
              essay-under-a-dialog shape `#885` removed from the settings panels;
              the same disclosure shape now applies here.

              Both claims are unchanged and both are still made. The erase
              destroys the per-vault keychain item on the platforms that have one
              (myne-md/myne#761, `design-notes/security/0709`), and the note is
              gated on the provider capability rather than on `onlyCopy`: the
              browser has no per-vault keychain item and its copy is a different
              claim about a different store, so the sentence is omitted there. */}
          <div style={DISCLOSURE_ROW_STYLE}>
            <HelperDisclosure
              paragraphs={[
                t("settings.deleteVault.copySecondary"),
                ...(hasKeychainItem ? [t("settings.deleteVault.keychainNote")] : []),
              ]}
              descriptionId={detailsId}
              testId="delete-vault.details"
              triggerLabel={t("settings.deleteVault.detailsLabel")}
              visibleLabel
            />
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
            }}
          >
            <label
              htmlFor="delete-vault-confirm-input"
              style={INPUT_LABEL_STYLE}
            >
              {t("settings.deleteVault.typeToConfirmLabel")}
            </label>
            <Input
              id="delete-vault-confirm-input"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={inFlight}
              autoFocus
              aria-describedby={detailsId}
              data-testid="delete-vault.confirm-input"
            />
            <div style={INPUT_HINT_STYLE}>
              {t("settings.deleteVault.caseSensitiveHint")}
            </div>
          </div>

          <div style={BUTTON_ROW_STYLE}>
            <Button
              variant="secondary"
              onClick={onCancel}
              disabled={inFlight}
              data-testid="delete-vault.cancel"
            >
              {t("settings.deleteVault.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={handleSubmit}
              disabled={!submitReady}
              data-testid="delete-vault.submit"
            >
              {copy.submit}
            </Button>
          </div>
        </>
      ) : (
        <>
          <DestructiveBanner>
            <div
              style={{
                ...EYEBROW_STYLE,
                marginBottom: "var(--space-2)",
              }}
            >
              {partialFailContext.kind === "partial-delete"
                ? t("settings.deleteVault.partialFailTitle")
                : t("settings.deleteVault.ioFailTitle")}
            </div>
            <div>
              {partialFailContext.kind === "partial-delete"
                ? t("settings.deleteVault.partialFailBody", {
                    count: partialFailContext.remainingCount,
                  })
                : t("settings.deleteVault.ioFailBody")}
            </div>
            {/* No path on a client that has none. `appDataDir()` is a typed
                refusal in the browser seam, so the web consumer passes `null`
                rather than a fabricated string — and a "Vault path:" line with
                nothing after it would be worse than its absence. */}
            {partialFailContext.vaultDirPath !== null && (
              <code style={VAULT_PATH_STYLE}>
                {t("settings.deleteVault.vaultPath", {
                  path: partialFailContext.vaultDirPath,
                })}
              </code>
            )}
          </DestructiveBanner>

          <div style={BUTTON_ROW_STYLE}>
            <Button
              variant="danger"
              onClick={onContinueAfterPartial}
              data-testid="delete-vault.continue"
            >
              {t("settings.deleteVault.continue")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
