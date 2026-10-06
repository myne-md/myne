// Settings → Privacy panel: interactive "Screen-capture protection"
// toggle (MYND-160 ships persistence) + interactive "Auto-lock" timeout
// selector (MYND-121 + MYND-122). The auto-lock control is a native
// <select> — keyboard-navigable + screen-reader-friendly by construction —
// offering ENABLED durations only (NO "Off"): auto-lock is an always-on A6
// guarantee. Supersedes MYND-55's disabled "Auto-lock on idle" placeholder.
//
// Penpot canon: `screen------settings--privacy` (frame id
// `9fb59646-2811-8082-8007-fd1cbf80a20b`). MYND-121 turned the disabled
// auto-lock toggle placeholder into the interactive select drawn there.
//
// i18n: copy is inline EN, consistent with the rest of the app (no i18n
// framework exists yet). TR strings ("Otomatik kilit" / "Bu kadar
// hareketsizlik sonrası kasayı kilitle.") await an app-wide i18n layer.

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { mutationFrom } from "../../lib/prefs";
import { useTranslation } from "react-i18next";
import { usePrefs } from "../../hooks/usePrefs";
import {
  hideNamesWriteNotice,
  hideVaultNamesErrorKind,
  readHideVaultNames,
  readKeychainStatus,
  setHideVaultNames,
  type HideNamesNotice,
  type KeychainStatus,
} from "../../lib/vault-label";
import {
  useScreenCaptureOverride,
  type ScreenCaptureOverrideStatus,
} from "../../hooks/useScreenCaptureOverride";
import type { ScreenCaptureOverrideView } from "../../lib/screen-capture-override";
import { has } from "../../platform/capabilities";
import { SearchableSelect } from "../primitives/SearchableSelect";
import type { SelectOption } from "../primitives/Select";
import { Switch } from "../primitives/Switch";
import { CliAccessSettings } from "./CliAccessSettings";
import { QuickUnlockSettings } from "./QuickUnlockSettings";
import { RecoveryDrillRow } from "./RecoveryDrillRow";
import { SettingRow } from "./SettingRow";
import { HELPER_STYLE, PANEL_ROOT_STYLE } from "./panel-styles";

// MYND-160 grill Q2.1 disclosure: when the user toggles off, the
// helper text MUST disclose the off-after-unlock semantic so a
// "I turned it off, why is the unlock screen still black?" support
// question is foreseeable + answered at the UI surface. When the
// toggle is on (the default), the helper carries the platform-
// support disclosure inherited from MYND-55/78's disabled placeholder
// copy — modified to drop the "Per-vault toggle ... coming in a
// future release" sentence since the toggle is now interactive.
function screenCaptureHelperText(
  enabled: boolean,
  t: (key: string) => string,
): string {
  if (enabled) {
    return t("settings.privacy.screenCaptureHelperOn");
  }
  return t("settings.privacy.screenCaptureHelperOff");
}

// ── The device-local override (myne-md/myne#482) ────────────────────────────
//
// The per-vault switch above is a `vault.prefs` field, so it is unreadable
// before unlock. And "unreadable before unlock" is exactly the state that
// locked a remote-desktop or magnifier user out of every pre-unlock screen. The
// escape hatch therefore lives in a device-local file, is reachable from the
// pre-unlock skip link in `src/components/ScreenCaptureEscape.tsx`, and is
// mirrored HERE so a user who took it has an obvious way back.
//
// # It supersedes the switch above rather than fighting it
//
// The override is device-wide, before unlock and after (a pre-unlock-only one
// would put the black window straight back in front of the person it exists
// for), so while it is on the per-vault switch governs nothing. Rendering both
// as live controls over one native state is how a settings screen comes to
// disagree with the window beside it, so the switch is disabled and says why,
// the same shape `hide-vault-names-unavailable` uses when its option cannot
// work on this device.
//
// # `via_flag` is reported apart from the file, and has to be
//
// A run launched with `--disable-screen-capture-protection` has an empty file
// and an unprotected window. A row that showed only the file's value would
// offer to "turn protection back on", write `disabled: false`, report success,
// and leave the window exactly as it was.

function ScreenCaptureOverrideRow({
  view,
  status,
  onSave,
}: {
  /** The last read of the override, or `null` before the first read lands. */
  view: ScreenCaptureOverrideView | null;
  status: ScreenCaptureOverrideStatus;
  /** Persist and adopt. The panel owns the value because the row ABOVE needs it
   *  to know it is superseded, so this row is presentational. */
  onSave: (disabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const busy = status === "saving";
  const disabled = view?.disabled ?? false;
  const viaFlag = view?.via_flag ?? false;

  return (
    <SettingRow
      anchorId="privacy.screen-capture-override"
      testId="settings.screen-capture-override"
      stateAttrs={{
        "data-disabled": String(disabled),
        "data-via-flag": String(viaFlag),
      }}
      label={t("settings.privacy.screenCaptureOverrideLabel")}
      helper={t("settings.privacy.screenCaptureOverrideHelper")}
      // Through SettingRow's own error slot rather than a paragraph in
      // `children`: that slot renders ERROR_STYLE with role="alert", which is
      // announced on insertion, where a helper-coloured status line reads as
      // explanatory text. Twelve sibling panels use it.
      error={
        status === "failed"
          ? t("screenCaptureEscape.saveFailed")
          : null
      }
      control={(helperId) => (
        <Switch
          checked={disabled}
          onChange={busy ? undefined : onSave}
          ariaLabel={t("settings.privacy.screenCaptureOverrideLabel")}
          ariaDescribedBy={helperId}
          testId="settings.screen-capture-override-toggle"
        />
      )}
    >
      {viaFlag && (
        <p style={HELPER_STYLE} data-testid="settings.screen-capture-override-flag">
          {t("screenCaptureEscape.flagNotice")}
        </p>
      )}
    </SettingRow>
  );
}

// MYND-121 auto-lock-on-idle timeout selector. Options sit within the backend
// protective-envelope bounds (FLOOR 30s / DEFAULT 5min / CEILING 60min) and
// offer NO "Off" — auto-lock is an always-on A6 guarantee. The default shown
// when no value is stored mirrors the Rust `auto_lock::DEFAULT_AUTO_LOCK_SECS`
// (keep in sync if that constant changes; the backend is authoritative for the
// actual timer — this is only the selector's display-when-unset).
const AUTO_LOCK_DEFAULT_SECS = 300;

const AUTO_LOCK_OPTIONS: ReadonlyArray<{ secs: number; label: string }> = [
  { secs: 60, label: "1 min" },
  { secs: 300, label: "5 min" },
  { secs: 900, label: "15 min" },
  { secs: 1800, label: "30 min" },
  { secs: 3600, label: "1 hour" },
];

// The same offered durations as SearchableSelect options (value = the seconds
// as a string; the row maps back to a number on change).
const AUTO_LOCK_SELECT_OPTIONS: readonly SelectOption<string>[] =
  AUTO_LOCK_OPTIONS.map((o) => ({ value: String(o.secs), label: o.label }));

/**
 * Resolve the value the selector displays: the stored timeout when it matches
 * an offered option, otherwise the default. Covers both the unset case (`null`
 * → default) and the defensive case where a replayed / out-of-range stored
 * value has no matching `<option>` (fall back to default so the native select
 * always shows a valid selection; the backend clamps the actual timer anyway).
 */
function selectedAutoLockSecs(stored: number | null): number {
  if (stored !== null && AUTO_LOCK_OPTIONS.some((o) => o.secs === stored)) {
    return stored;
  }
  return AUTO_LOCK_DEFAULT_SECS;
}

interface AutoLockRowProps {
  seconds: number;
  onChange: (secs: number) => void;
}

function AutoLockRow({ seconds, onChange }: AutoLockRowProps) {
  const { t } = useTranslation();
  return (
    <SettingRow
      label={t("settings.privacy.autoLockLabel")}
      helper={t("settings.privacy.autoLockHelper")}
      control={
        <SearchableSelect
          options={AUTO_LOCK_SELECT_OPTIONS}
          selected={[String(seconds)]}
          onChange={(next) => {
            const secs = Number(next[0]);
            if (!Number.isNaN(secs)) onChange(secs);
          }}
          aria-label={t("settings.privacy.autoLockLabel")}
          testId="settings.auto-lock-select"
          searchPlaceholder={t("settings.privacy.autoLockSearchPlaceholder")}
          emptyText={t("settings.privacy.autoLockSearchEmpty")}
        />
      }
    />
  );
}

// ── Hide vault names on the lock screen (myne-md/myne#411) ──────────────────
//
// The picker renders before any vault is open, so the names it shows come from
// a device-local sealed cache rather than from `vault.prefs`. This row is the
// switch that destroys that cache and stops it being refilled.
//
// # Not gated by Developer mode, deliberately
//
// `developer_mode` is a `vault.prefs` field and therefore per vault, while the
// picker is device-wide: gating on it would need a rule about which vault's
// preference governs a shared screen. And cryptographic erase cannot reach a
// snapshot taken earlier, so the person for whom this option is fully honest is
// the one who sets it BEFORE a first unlock ever writes a name. A control
// behind Developer mode cannot be found by that person.
//
// # The copy states the bound in the same breath as the promise
//
// Two sentences, always visible, never behind a disclosure toggle. Writing
// "erases" and letting the reader supply their own idea of how far it reaches
// is the failure this row exists to prevent, and a bound the reader has to
// click for is a bound most readers never see. They are bounded by
// `docs/threat-model.md` §7 and by `design-notes/security/0491-…`, and they
// say the same two things the user guide says at greater length.
//
// # Omitted, not greyed, where there are no vault names to hide
//
// The row is gated on `lockedVaultNames` and on nothing else, which on desktop
// means it renders for everyone. Where that capability is absent (web) the
// switch governs nothing: the locked picker it is about is unreachable there,
// and the sealed store it erases needs an OS keychain a page does not have. So
// the row is omitted rather than rendered against three commands that reject,
// per the normative omit-never-grey rule in `decisions.md` 2026-07-26.
//
// # `available: false` is never a licence to show a name from somewhere else
//
// The probe reports whether this device has a usable keychain at all. When it
// does not, nothing writes a name in the clear as a fallback (that would look
// identical on screen while voiding the erase guarantee), so the honest thing
// on screen is the row saying the option cannot work here. The switch stays
// INTERACTIVE in that state on purpose: turning the option OFF touches no
// keychain, which is exactly what lets it succeed on a device that has none, so
// a disabled control would strand a user whose keychain disappeared after they
// turned it on.

// The types, the error narrowing and the three command wrappers live in
// `src/lib/vault-label.ts`, at the same relative path as their mobile twin, so
// `scripts/check-twin-drift.mjs` can see the pair.

/** The two bound sentences, stacked. Token-valued throughout. */
const DISCLOSURE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

function HideVaultNamesRow() {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(false);
  const [keychain, setKeychain] = useState<KeychainStatus>("unknown");
  const [notice, setNotice] = useState<HideNamesNotice | null>(null);
  const [busy, setBusy] = useState(false);

  // The mount reads and a toggle's write are UNORDERED, and `alive` does not
  // order them: it only says the row is still on screen. A mount read that
  // resolves after a write has landed would call `setHidden` with the value
  // from before the write and flip the switch back on its own, which misreports
  // whether a destructive erase took effect. Once a write has started the mount
  // reads describe a state that no longer exists, so they are dropped.
  const writeStartedRef = useRef(false);

  // Two independent questions, asked independently: whether names are hidden,
  // and whether this device could store one at all. They fail apart: names can
  // be hidden on a device with a keychain and shown on one without.
  useEffect(() => {
    let alive = true;
    const superseded = () => !alive || writeStartedRef.current;
    void readHideVaultNames()
      .then((next) => {
        if (!superseded()) setHidden(next);
      })
      .catch(() => {
        // Do not assert a position we could not read.
        if (!superseded()) setNotice("read");
      });
    // A rejection resolves to "unknown" inside `readKeychainStatus`, never to
    // "unavailable": the unavailable case arrives as a value and never as an
    // error, so a rejection means the question went unanswered.
    void readKeychainStatus().then((next) => {
      if (!superseded()) setKeychain(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = async (next: boolean) => {
    writeStartedRef.current = true;
    setNotice(null);
    setBusy(true);
    try {
      setHidden(await setHideVaultNames(next));
    } catch (e) {
      const kind = hideVaultNamesErrorKind(e);
      setNotice(hideNamesWriteNotice(kind));
      // This one IS authoritative: the backend answered the question, it just
      // answered it through the error channel because the write could not
      // proceed. Nothing here writes a name as a consolation.
      if (kind === "KeychainUnavailable") setKeychain("unavailable");
      // Re-read rather than guess which way the switch should land. The erase
      // runs BEFORE the flag is persisted, so a failed write leaves the flag
      // wherever it already was while the keys may already be gone.
      await readHideVaultNames()
        .then(setHidden)
        .catch(() => {
          /* the notice already says the attempt failed */
        });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow
      anchorId="privacy.hide-vault-names"
      testId="settings.hide-vault-names"
      stateAttrs={{ "data-hidden": String(hidden), "data-keychain": keychain }}
      label={t("settings.privacy.hideVaultNamesLabel")}
      helper={t("settings.privacy.hideVaultNamesHelper")}
      control={(helperId) => (
        <Switch
          checked={hidden}
          onChange={busy ? undefined : (next) => void toggle(next)}
          ariaLabel={t("settings.privacy.hideVaultNamesLabel")}
          ariaDescribedBy={helperId}
          testId="settings.hide-vault-names-toggle"
        />
      )}
    >
      <div style={DISCLOSURE_STYLE} data-testid="settings.hide-vault-names-disclosure">
        <p style={HELPER_STYLE}>{t("settings.privacy.hideVaultNamesErases")}</p>
        <p style={HELPER_STYLE}>{t("settings.privacy.hideVaultNamesResidue")}</p>
      </div>

      {keychain === "unavailable" && (
        <p style={HELPER_STYLE} data-testid="settings.hide-vault-names-unavailable">
          {t("settings.privacy.hideVaultNamesUnavailable")}
        </p>
      )}

      {notice !== null && (
        <p style={HELPER_STYLE} role="status" data-testid="settings.hide-vault-names-notice">
          {notice === "read" && t("settings.privacy.hideVaultNamesErrorRead")}
          {notice === "save" && t("settings.privacy.hideVaultNamesErrorSave")}
          {notice === "erase" && t("settings.privacy.hideVaultNamesErrorErase")}
        </p>
      )}
    </SettingRow>
  );
}

interface PrivacyPanelProps {
  /**
   * Toast surface — invoked when an optimistic write rolled back
   * (PrefsWriteError on the Rust side). Threaded from
   * `SettingsModal.onShowToast` per the existing AccountPanel
   * pattern. When undefined, errors are silent (acceptable for
   * dev / non-Tauri contexts where the modal mounts without a
   * toast surface wired).
   */
  onShowToast?: (message: string) => void;
}

export function PrivacyPanel({ onShowToast }: PrivacyPanelProps = {}) {
  const { t } = useTranslation();
  const {
    prefs,
    toggleScreenCapture,
    setAutoLock,
    setCliEnabled,
    setCliExcludedFolders,
    setCliRateLimitDisabled,
  } = usePrefs(onShowToast);

  // The device-local override (myne-md/myne#482). Owned by the panel rather
  // than by its row, because the per-vault switch above has to know when it is
  // superseded. Two live controls over one native state is how a settings
  // screen comes to disagree with the window beside it. The read, the write and
  // the "no optimistic flip" rule live in the hook, shared with the pre-unlock
  // escape (`src/components/ScreenCaptureEscape.tsx`), because a rule with two
  // homes is a rule that drifts.
  const {
    view: override,
    status: overrideStatus,
    save: saveOverride,
  } = useScreenCaptureOverride();
  // `null` is UNKNOWN, not "no override", and the two must not collapse here.
  // The hook deliberately leaves `view === null` on a failed read rather than
  // asserting a position it could not read. Treating that as `false` rendered
  // this switch LIVE on a device whose override may be on, and its `onChange`
  // writes `vault.prefs`, which is AEAD-sealed and SYNCED, then reports success
  // while the window stays capturable. That is the exact failure the block
  // comment above says this row exists to prevent, and it is the same
  // fail-towards-protection direction `protection_disabled_at_rest` takes on the
  // Rust side, inverted. So an unread override supersedes too.
  //
  // **Gated on the capability, which is what keeps the per-vault switch alive on
  // the web client** (myne-md/myne#482, found by review). The hook returns
  // early on a client with no capture affinity to suppress, so `override` is
  // `null` there PERMANENTLY, not transiently: nothing will ever publish. Read
  // as "unknown" that made `superseded` true forever, so the switch this same
  // diff rosters in `check-web-surfaces.mjs` and indexes in
  // `settingsSearchIndex.ts` was inert on web with a sentence about a control
  // that client does not have.
  //
  // The distinction is between "the override could not be read" (fail towards
  // protection, above) and "no override exists on this client" (not applicable,
  // so it supersedes nothing). Only the first is unknown.
  const overrideApplies = has("screenCaptureProtection");
  const overrideUnknown = overrideApplies && override === null;
  const superseded = overrideApplies ? (override?.effective ?? true) : false;
  // The switch goes inert on `effective`, which is the union, but the SENTENCE
  // cannot: the two ways to be superseded have different ways back. When only
  // the process flag holds, the row below reads OFF, so pointing the user at
  // "turn that off" names a control that is already off and offers no route at
  // all. When the file says so, the row below is the route, and the row's own
  // helper carries the flag caveat if both hold.
  const supersededByFlagOnly =
    !overrideUnknown && superseded && !(override?.disabled ?? false);

  return (
    <div style={PANEL_ROOT_STYLE}>
      {/* Gated on the capability, because a page cannot stop a screenshot
          (myne-md/myne#556). `web/src/platform/capabilities.ts` has listed
          `screenCaptureProtection` in its ABSENT set all along; rendered
          ungated, a web user sees a Privacy toggle, turns it on, and is told
          their screen is protected by something with no way to protect it.

          OMITTED rather than disabled or re-worded, which is what
          `decisions.md` 2026-07-26 makes normative for an absent capability: a
          greyed control is an offer the platform cannot honour.

          The row's own superseded/override states are a DIFFERENT question —
          they say why a capability the client HAS is not governing right now —
          so they do not stand in for this gate, and the override row below
          carrying the same `has()` is not this row's gate either. Reading that
          one as this one is how the gate came to be dropped in a merge. */}
      {has("screenCaptureProtection") && (
        <SettingRow
          label={t("settings.privacy.screenCaptureLabel")}
          helper={
            overrideUnknown
              ? t("settings.privacy.screenCaptureOverrideUnknown")
              : supersededByFlagOnly
                ? t("settings.privacy.screenCaptureSupersededByFlag")
                : superseded
                  ? t("settings.privacy.screenCaptureSuperseded")
                  : screenCaptureHelperText(prefs.screen_capture_protection, t)
          }
          anchorId="privacy.screen-capture"
          testId="settings.screen-capture"
          stateAttrs={{ "data-superseded": String(superseded) }}
          control={(helperId) => (
            <Switch
              checked={prefs.screen_capture_protection}
              // Inert while the device override is on: the per-vault preference
              // still records what the user wants, and it still governs nothing.
              // Disabling it is the honest state; leaving it live would let a
              // click report a change the window does not make.
              onChange={
                superseded
                  ? undefined
                  : (next) => {
                      void toggleScreenCapture(next);
                    }
              }
              ariaLabel={t("settings.privacy.screenCaptureLabel")}
              ariaDescribedBy={helperId}
              testId="settings.screen-capture-toggle"
            />
          )}
        />
      )}
      {has("screenCaptureProtection") && (
        <ScreenCaptureOverrideRow
          view={override}
          status={overrideStatus}
          onSave={(next) => void saveOverride(next)}
        />
      )}
      {/* Beside screen-capture protection rather than beside the lock timers:
          both rows answer "what can somebody looking at this machine see",
          which is the question the user came to Privacy holding.

          Gated on `lockedVaultNames` only, never on `developer_mode` (see the
          block comment above the row). On desktop that gate is always open. */}
      {has("lockedVaultNames") && <HideVaultNamesRow />}
      <AutoLockRow
        seconds={selectedAutoLockSecs(prefs.auto_lock_seconds)}
        onChange={(secs) => {
          void setAutoLock(secs);
        }}
      />
      <QuickUnlockSettings />
      {/* The recovery drill (myne-md/myne#468). In Privacy rather than Account
          because what it protects is the ability to get back IN, which is the
          same family as the auto-lock and quick-unlock rows it sits beside, and
          because Account is where the vault's NAME and number live — a phrase
          field there would read as another identifier to manage.

          Ungated: it needs no capability the web client lacks (the command is
          `myne-core`'s and the web dispatcher routes it), and it is not behind
          Developer mode because a first-time user is exactly who it is for. */}
      <RecoveryDrillRow />
      {/* CLI terminal access (cli-thin-client task 12, MYND-490). Omitted where
          `cliAccess` is absent rather than greyed out: a browser tab cannot host
          a terminal's Unix socket, and the sidecar it would talk to is a file
          inside a desktop bundle (`decisions.md` 2026-07-26 "Web capability
          set" makes omission normative).

          Behind Developer mode as well (#181): the block opens the unlocked
          vault to an EXTERNAL terminal process over the local command socket —
          a separate trust boundary, and Myne does not vouch for what walks
          through it. That is the Developer group's whole membership test, so
          this belongs behind the same deliberate door as AI and Tor even
          though it keeps its home in Privacy. The gate HIDES, it does not
          disable: turning Developer mode back off leaves an enabled socket
          serving, exactly as it leaves `ai_enabled` set — the off switch for
          the feature is its own control. */}
      {prefs.developer_mode && has("cliAccess") && (
        <CliAccessSettings
          enabled={prefs.cli_enabled}
          excludedFolders={prefs.cli_excluded_folders}
          rateLimitDisabled={prefs.cli_rate_limit_disabled}
          onSetEnabled={(next) => {
            void setCliEnabled(next);
          }}
          onSetExcludedFolders={(folders, seededFrom) => {
            // Diffed against what this panel last saw, not against the current
            // cache. Same reasoning as AiPanel: an exclusion a peer added while
            // the user was editing is in the cache and not in the editor's
            // list, and diffing against the cache would call that a removal
            // (myne-md/myne#613). The CLI exclusion list is an egress control,
            // so the fail-open direction is the terminal reading a folder the
            // user marked hidden.
            void setCliExcludedFolders(mutationFrom(seededFrom, folders), folders);
          }}
          onSetRateLimitDisabled={(next) => {
            void setCliRateLimitDisabled(next);
          }}
        />
      )}
    </div>
  );
}
