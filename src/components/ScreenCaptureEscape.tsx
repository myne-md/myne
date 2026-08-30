// The escape hatch from screen-capture protection, for every screen that cannot
// reach the Privacy panel (myne-md/myne#482).
//
// # The lockout
//
// Protection is always ON before unlock (`decisions.md` 0131, 0135;
// `threat-model.md` §6), the toggle that could clear it is a field of the
// AEAD-sealed `vault.prefs`, and the control that writes it is in the
// post-unlock Privacy panel. On Windows 10 build 19041+ the protection genuinely
// works, so a user on remote-control software or a screen magnifier sees a black
// window at the unlock screen with no path to anything. Behind that black
// rectangle are the account number, the 24-word recovery-phrase ceremony and the
// device-join QR. A user who cannot read the phrase cannot finish onboarding
// and cannot recover later, which makes this a data-loss path rather than only
// an accessibility one. Signal shipped the same bug and patched it in a day
// (signalapp/Signal-Desktop#7342 / #7356; #7928, filed against JAWS + ZoomText,
// is still open).
//
// # Why a skip link rather than a visible button
//
// The window being black is what makes this hard, and it does not affect
// everyone the same way. `SetWindowDisplayAffinity` governs what the compositor
// hands to capture; it does not touch the accessibility tree, so a screen reader
// reads this control perfectly well. A magnifier user sees nothing at all.
//
// So the control has to be findable by keyboard without being visible, which is
// the skip-link idiom exactly: first in DOM order, off-screen until it takes
// focus, and rendered normally the moment it does. That costs sighted users
// nothing and puts the escape one Tab (or one Shift+Tab, from the autofocused
// password field) from a cold launch. It is NOT `display: none` or
// `visibility: hidden`, either of which would take it out of the accessibility
// tree and make it unreachable by the reader it is for. See
// `primitives/visuallyHidden.ts`.
//
// # Why it is mounted once, unconditionally
//
// `App.tsx` mounts it above the stage switch with no predicate, and the first
// revision's `stage.name !== "editor"` is why. That predicate reasoned "after
// unlock the Privacy panel is reachable, and the same control lives there",
// which is false on three screens INSIDE the `editor` stage: `Editor.tsx`
// returns `DeviceRevoked`, `StorageLost` and `FailClosedError` before
// `EditorChrome` (and therefore before `SettingsModal`) ever mounts. The third
// renders with the vault LOCKED, which means `apply(app, true, "lock_reset")`
// has forced protection back ON, so on Windows it is a black rectangle whose
// only affordance is one CTA. Recoverable, but it is the same gap this control
// exists to close, inside the one stage the predicate excluded.
//
// A predicate that has to be kept in step with a screen roster nobody
// enumerates is the failure `useRevealAfterIdleLock` was consolidated to fix
// (MYND-628). Unconditional costs exactly one invisible tab stop on the editor,
// where the control is redundant with Settings and harmless.
//
// # Turning it off is consented, never silent
//
// The dialog states the cost before anything is written, in the words
// `threat-model.md` §6 uses about what this layer does and does not do. There is
// no auto-disable and no accessibility-tool detection: a blocklist fails open on
// any renamed binary, and here it would fail open ON PRIVACY, since a process
// pretending to be a screen reader would turn the protection off.

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useScreenCaptureOverride } from "../hooks/useScreenCaptureOverride";
import { has } from "../platform/capabilities";
import { ActionStatus } from "./ActionStatus";
import { Button } from "./primitives/Button";
import { ModalShell } from "./primitives/ModalShell";
import { VISUALLY_HIDDEN } from "./primitives/visuallyHidden";

/** Off-screen but present, in the accessibility tree and in the tab order. */
const HIDDEN_TRIGGER_STYLE: CSSProperties = {
  ...VISUALLY_HIDDEN,
  position: "fixed",
  top: 0,
  left: 0,
  padding: 0,
  border: 0,
  zIndex: 2000,
};

/** What the same control looks like once it has focus: `Button`'s secondary
 *  chrome, pinned to the top-left over whatever screen is behind it. Only the
 *  position and the ground are overridden. The ramp, the hover and the press
 *  come from the primitive.
 *
 *  It sits BELOW the 38px window-drag strip `App.tsx` reserves on every
 *  non-editor stage, rather than at the very top, and unconditionally: this
 *  component renders on the Tauri clients only, all of which have that strip.
 *  The first revision made it a `HAS_NATIVE_TITLE_BAR` ternary reasoning about
 *  the macOS traffic lights, which tests the wrong property twice over. That
 *  constant is a hardcoded `true`, so the other arm was unreachable, and the
 *  constant that names the traffic lights is `HAS_OVERLAY_WINDOW_CONTROLS`,
 *  which `titlebar.ts` records as having been renamed out of `IS_MAC` for
 *  exactly this reason. */
const FOCUSED_TRIGGER_STYLE: CSSProperties = {
  position: "fixed",
  top: 46,
  left: "var(--space-2)",
  zIndex: 2000,
  background: "var(--bg-2)",
};

/** The prose scrolls; the actions do not. `ModalShell`'s body wrapper is
 *  `overflow: hidden` under a `100vh`-derived `maxHeight`, so a body that grows
 *  past it clips whatever is at the bottom, which here is the pair of buttons.
 *  A dialog whose buttons scroll out of view reads as unanswerable, and this
 *  one is the only way out of a window the reader cannot see. Same split, and
 *  the same reason, as the three consent-class siblings (`AiProviderConsent`,
 *  `BetaTermsConsent`, `DeleteAttachmentDialog`). */
const SCROLL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-5)",
};

const TEXT_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
  margin: 0,
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  flex: "0 0 auto",
  padding: "var(--space-4) var(--space-5)",
  borderTop: "1px solid var(--line-1)",
};

/** The failure arm, in `--danger` with the alert role the Privacy row's error
 *  slot already uses. A helper-coloured status line reads as explanatory text,
 *  which is the one reading this dialog cannot afford: its audience is the
 *  person least able to notice an unmarked colour change. */
const FAILED_STYLE: CSSProperties = {
  ...TEXT_STYLE,
  color: "var(--danger)",
};

export function ScreenCaptureEscape() {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  // Set when a restore WROTE but could not take effect this run, because the
  // process flag outranks the file. Reported rather than reported-as-success:
  // the dialog closing is this flow's only success signal, so closing on a
  // write the window did not follow would tell the user protection is back
  // when it is not.
  const [savedForNextLaunch, setSavedForNextLaunch] = useState(false);
  const { view, status, save, clearStatus } = useScreenCaptureOverride();

  // Where there is no protection to escape from there is nothing to offer. Web
  // is the case: a page cannot ask a browser to exclude itself from capture, so
  // the capability is absent and the affordance is omitted rather than rendered
  // against commands that refuse (`decisions.md` 2026-07-26).
  if (!has("screenCaptureProtection")) return null;

  // Driven off `disabled` (what the FILE says, and what the setter writes back),
  // never off `effective` (what the window is doing). On a run launched with the
  // process flag those two disagree: `effective` is true while the file may say
  // anything, and keying the action off it offered only "restore" and then wrote
  // `disabled: false` over a persisted `true`. Silently undoing the override on
  // the next launch, which is the lockout this control exists to open. The flag
  // half reaches the user through the notice below instead.
  const disabled = view?.disabled ?? false;
  const busy = status === "saving";
  const label = disabled
    ? t("screenCaptureEscape.restoreTrigger")
    : t("screenCaptureEscape.disableTrigger");

  const viaFlag = view?.via_flag ?? false;

  const openDialog = () => {
    // A stale failure read as the result of the tap just made is worse than
    // none, which is the rule `ActionStatus` states about its own flash.
    clearStatus();
    setSavedForNextLaunch(false);
    setOpen(true);
  };

  const apply = async (next: boolean) => {
    // Close only on a write that landed. A silent close would leave the user
    // looking at the same black rectangle with no reason given.
    if (!(await save(next))) return;
    // Turning protection OFF always takes effect. Turning it back ON cannot on
    // a run launched with the flag: the write records the intent for the next
    // launch and this window stays capturable. `screen-capture-override.ts`
    // names this as the one case a caller must not report as "protection is
    // back on", and the dialog closing IS this flow's report.
    if (next === false && viaFlag) {
      setSavedForNextLaunch(true);
      return;
    }
    setOpen(false);
  };

  return (
    <>
      <Button
        variant="secondary"
        type="button"
        data-testid="screen-capture-escape.trigger"
        // SYNC-7 pre-unlock leak budget: two literal values about a
        // device-local setting the user themselves set, already spoken by this
        // button's own label. Nothing vault-derived, nothing account-derived,
        // and nothing an observer of the DOM learns that an observer of the
        // screen does not.
        data-override={disabled ? "true" : "false"}
        style={focused ? FOCUSED_TRIGGER_STYLE : HIDDEN_TRIGGER_STYLE}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={openDialog}
      >
        {label}
      </Button>

      <ModalShell
        open={open}
        // Frozen once the write has landed. `savedForNextLaunch` is reachable
        // from ONE action, restoring protection on a flag-launched run, and
        // that write flips `view.disabled` to false, so every control below
        // re-rendered INVERTED under a success message, offering "Turn
        // protection off" to the person who had just turned it on, one Enter
        // press from undoing it. The confirmation state is terminal: it states
        // what happened and offers a way out of the dialog, nothing else.
        title={
          disabled || savedForNextLaunch
            ? t("screenCaptureEscape.restoreTitle")
            : t("screenCaptureEscape.disableTitle")
        }
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        closeLabel={t("common.close")}
        labelId="screen-capture-escape-title"
        testId="screen-capture-escape.dialog"
        width={520}
      >
        <div style={SCROLL_STYLE}>
          {!savedForNextLaunch &&
            (disabled ? (
              <p style={TEXT_STYLE}>{t("screenCaptureEscape.restoreBody")}</p>
            ) : (
              <>
                <p style={TEXT_STYLE}>{t("screenCaptureEscape.disableBody")}</p>
                <p style={TEXT_STYLE}>{t("screenCaptureEscape.disableCost")}</p>
              </>
            ))}

          {/* Dropped in the confirmation state rather than kept: the
              `savedForNextLaunch` line below already says the session was
              started with the flag and when protection returns, so leaving this
              here says it twice to the one reader who is hearing it read out. */}
          {viaFlag && !savedForNextLaunch && (
            <p style={TEXT_STYLE} data-testid="screen-capture-escape.flag-notice">
              {t("screenCaptureEscape.flagNotice")}
            </p>
          )}

          {/* Persistently mounted and content-driven, per `docs/design/README.md`
              on inline status marks. A `role="status"` region inserted together
              with its text is announced unreliably, and this component's whole
              audience is someone who cannot read the window, for whom this line
              is the only report there is. */}
          <ActionStatus
            testId="screen-capture-escape.status"
            style={status === "failed" ? FAILED_STYLE : TEXT_STYLE}
            message={
              status === "failed"
                ? t("screenCaptureEscape.saveFailed")
                : savedForNextLaunch
                  ? t("screenCaptureEscape.savedForNextLaunch")
                  : null
            }
          />

          <div style={ACTIONS_STYLE}>
            {savedForNextLaunch ? (
              // One control, and it is the cancel testid rather than a third
              // one: E2E and the component spec both close this dialog through
              // that name, and the button does the same thing it always did.
              <Button
                variant="primary"
                onClick={() => setOpen(false)}
                data-testid="screen-capture-escape.cancel"
              >
                {t("common.close")}
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  disabled={busy}
                  data-testid="screen-capture-escape.cancel"
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  variant={disabled ? "primary" : "danger"}
                  onClick={() => void apply(!disabled)}
                  disabled={busy}
                  data-testid="screen-capture-escape.confirm"
                >
                  {disabled
                    ? t("screenCaptureEscape.restoreConfirm")
                    : t("screenCaptureEscape.disableConfirm")}
                </Button>
              </>
            )}
          </div>
        </div>
      </ModalShell>
    </>
  );
}
