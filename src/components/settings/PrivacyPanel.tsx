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

import { useEffect, useRef, useState } from "react";

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
import { useScreenCaptureOverride } from "../../hooks/useScreenCaptureOverride";
import { has } from "../../platform/capabilities";
import { SearchableSelect } from "../primitives/SearchableSelect";
import type { SelectOption } from "../primitives/Select";
import { Switch } from "../primitives/Switch";
import { QuickUnlockSettings } from "./QuickUnlockSettings";
import { MemberPasswordSettings } from "./MemberPasswordSettings";
import { SettingRow } from "./SettingRow";
import { SettingsTopicPanel } from "./SettingsTabs";
import { SettingsSection } from "./SettingsSection";
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
      // ONE sentence on the row, and nothing behind a question mark (owner,
      // 2026-11-08). The row used to carry 776 characters across four paragraphs,
      // then (myne-md/myne#885) one sentence plus three behind the `?` beside the
      // label; the owner's report is that the popover itself is the noise, so the
      // `?` is gone too.
      //
      // **The sentence kept is the DESTRUCTIVE one**: since #411 a bound on a
      // destructive switch may not hide behind an interaction, and the warning is
      // the act. The four limits left the screen and stay recorded in
      // `threat-model.md` §7 (`decisions/clients/0799`).
      helper={t("settings.privacy.hideVaultNamesInline")}
      control={(helperId, explanationId) => (
        <Switch
          checked={hidden}
          onChange={busy ? undefined : (next) => void toggle(next)}
          ariaLabel={t("settings.privacy.hideVaultNamesLabel")}
          // The row's one sentence, and only that: the explanation slot this
          // control used to concatenate is gone with the `?`. `explanationId` is
          // still accepted by the row's contract and is now undefined here, which
          // is why the platform is spelled out rather than defaulted.
          ariaDescribedBy={explanationId === undefined ? helperId : `${helperId} ${explanationId}`}
          testId="settings.hide-vault-names-toggle"
        />
      )}
    >
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
  const { prefs, toggleScreenCapture, setAutoLock } = usePrefs(onShowToast);

  // The device half of the setting (myne-md/myne#482). It is a device-local
  // plaintext file rather than a `vault.prefs` field because the preference is
  // AEAD-sealed and therefore unreadable before unlock, and "unreadable before
  // unlock" is the state that puts a black window in front of a screen-magnifier
  // or remote-desktop user with no way past it. The read, the write and the "no
  // optimistic flip" rule live in the hook, shared with the pre-unlock escape
  // (`src/components/ScreenCaptureEscape.tsx`), because a rule with two homes is
  // a rule that drifts.
  //
  // ONE row drives BOTH halves now, so it reads the EFFECTIVE state rather than
  // the preference: a user who took the pre-unlock escape arrives here with the
  // file off and the sealed preference untouched, and a switch reading the
  // preference would claim protection that is not there.
  const {
    view: override,
    status: overrideStatus,
    save: saveOverride,
  } = useScreenCaptureOverride();
  // `null` is UNKNOWN, not "no override", and the two must not collapse here.
  // The hook deliberately leaves `view === null` on a failed read rather than
  // asserting a position it could not read, and a click in that state writes
  // `vault.prefs`, which is AEAD-sealed and SYNCED, then reports success while
  // the window stays capturable. Same fail-towards-protection direction
  // `protection_disabled_at_rest` takes on the Rust side, inverted.
  //
  // **Gated on the capability, because the hook returns early on a client with
  // no capture affinity to suppress** (myne-md/myne#482, found by review): there
  // `override` is `null` PERMANENTLY, not transiently, so reading it as
  // "unknown" would lock a control on a client that has nothing to suppress.
  // "Could not be read" and "no override exists on this client" are different
  // states, and only the first is unknown.
  const overrideApplies = has("screenCaptureProtection");
  const overrideUnknown = overrideApplies && override === null;
  const fileDisabled = override?.disabled ?? false;
  // An argv cannot be un-passed, so a flag-launched run can never be turned back
  // on from here: the control would write, report success, and leave the window
  // exactly as capturable. The helper says so instead.
  const viaFlag = override?.via_flag ?? false;
  // `!== false` rather than a truthiness test: the preference defaults to ON and
  // the backend always writes the field, so a value that is absent (a truncated
  // read, a fixture that stubs `prefs_read` with `{}`) means "not turned off"
  // rather than "off". Failing towards protection is the same direction
  // `protection_disabled_at_rest` takes on the Rust side.
  const protectionOn =
    prefs.screen_capture_protection !== false && !fileDisabled && !viaFlag;
  const toggleLocked = overrideUnknown || viaFlag;

  /**
   * The ONE write path of the user-facing setting: BOTH halves, device file
   * first. The file is what governs the window immediately, and it is the half
   * the pre-unlock surface reads, so a failure there means nothing was written
   * anywhere and the switch does not move. The preference then goes through
   * `usePrefs`, which owns the cache, the optimistic flip and the error toast.
   *
   * `!next` is the file's own polarity: it stores `disabled`, inverted from the
   * switch's "protection is on".
   */
  const applyScreenCapture = async (next: boolean) => {
    if (overrideApplies && !(await saveOverride(!next))) return;
    await toggleScreenCapture(next);
  };

  return (
    <div style={PANEL_ROOT_STYLE}>
      {/* **Access**: who or what can get at the notes. Two rows about a human
          looking at this machine - whether this device may be captured, and
          whether the lock screen names the vault - plus the terminal block
          below.

          The terminal is here rather than in a topic of its own. It is the
          panel's third concern on its own terms, but it is omitted whenever
          Developer mode is off or `cliAccess` is absent, and the strip renders
          the roster rather than the filtered set: a topic of its own would draw
          a tab whose body is empty. `Access` is the question all four blocks
          answer, so it is the topic that can always hold it. That is also why
          the block moved up from the panel's tail, which is the row-order change
          this grouping requires.

          Each topic's body keeps the indentation of the code it replaced, the
          convention the AI panel set, so the diff is about which rows moved
          rather than about whitespace. */}
      <SettingsTopicPanel panelId="privacy" topicId="access">
      {/* Two sections (myne-md/myne#885 visual pass): the rows about a
          human looking at this machine, and the terminal block, which is its own
          trust boundary. The terminal section is gated WITH its block, so on a
          client or a vault where it is hidden the screen section is the topic's
          only one and draws no heading (`SettingsSectionCounter`). */}
      <SettingsSection title={t("settings.privacy.sections.screen")}>
      {/* Gated on the capability, because a page cannot stop a screenshot
          (myne-md/myne#556). `web/src/platform/capabilities.ts` has listed
          `screenCaptureProtection` in its ABSENT set all along; rendered
          ungated, a web user sees a Privacy toggle, turns it on, and is told
          their screen is protected by something with no way to protect it.

          OMITTED rather than disabled or re-worded, which is what
          `decisions.md` 2026-07-26 makes normative for an absent capability: a
          greyed control is an offer the platform cannot honour.

          ONE row, TWO stores, and the change is worth stating. The setting used
          to render as two peer rows here: `vault.prefs`' synced field and the
          device-local file. They are not peers (different storage, different
          scope, different reach before unlock) and the user had to work that out
          from two helper sentences. This control writes both, and reads
          whichever one is suppressing protection right now. */}
      {has("screenCaptureProtection") && (
        <SettingRow
          label={t("settings.privacy.screenCaptureLabel")}
          helper={
            overrideUnknown
              ? t("settings.privacy.screenCaptureOverrideUnknown")
              : viaFlag
                ? t("settings.privacy.screenCaptureSupersededByFlag")
                : screenCaptureHelperText(protectionOn, t)
          }
          // The device write is the one that can fail with nothing written
          // anywhere, so its error goes in the row's own alert slot. The
          // preference half reports through the toast surface `usePrefs` owns.
          error={
            overrideStatus === "failed"
              ? t("screenCaptureEscape.saveFailed")
              : null
          }
          anchorId="privacy.screen-capture"
          testId="settings.screen-capture"
          stateAttrs={{
            "data-protection-on": String(protectionOn),
            "data-locked": String(toggleLocked),
          }}
          control={(helperId) => (
            <Switch
              checked={protectionOn}
              // Locked on an UNREAD override (fail towards protection: a click
              // must not report a change we cannot make) and on the process flag
              // (an argv cannot be un-passed).
              onChange={
                toggleLocked
                  ? undefined
                  : (next) => {
                      void applyScreenCapture(next);
                    }
              }
              ariaLabel={t("settings.privacy.screenCaptureLabel")}
              ariaDescribedBy={helperId}
              testId="settings.screen-capture-toggle"
            />
          )}
        />
      )}
      {/* Beside screen-capture protection rather than beside the lock timers:
          both rows answer "what can somebody looking at this machine see",
          which is the question the user came to Privacy holding.

          Gated on `lockedVaultNames` only, never on `developer_mode` (see the
          block comment above the row). On desktop that gate is always open. */}
      {has("lockedVaultNames") && <HideVaultNamesRow />}
      </SettingsSection>
      {/* The CLI block used to render here, gated inline on
          `prefs.developer_mode && has("cliAccess")`. It is its own
          developer-group panel now (`CliPanel`, `decisions/ui/0678`), which
          carries the same two gates in the rail filter, so the `access` topic is
          the screen section alone. */}
      </SettingsTopicPanel>

      {/* **Locking**: how the vault locks and reopens. The drill that used to sit
          here (and the section that separated it, myne-md/myne#885) is withdrawn
          with it (`decisions/security/0747`, myne-md/myne#935), so this topic is
          a settings section again rather than a settings section plus a check. */}
      <SettingsTopicPanel panelId="privacy" topicId="locking">
      <SettingsSection title={t("settings.privacy.sections.locking")}>
      <AutoLockRow
        seconds={selectedAutoLockSecs(prefs.auto_lock_seconds)}
        onChange={(secs) => {
          void setAutoLock(secs);
        }}
      />
      <QuickUnlockSettings />
      <MemberPasswordSettings />
      </SettingsSection>
      </SettingsTopicPanel>
    </div>
  );
}
