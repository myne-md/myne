// Theme-install confirmation dialog (MYND-567) — the gate between a
// `myne://theme/install` link and the user's vault.
//
// A theme-install link can be served by ANY website, so this dialog is the
// security control, not a courtesy: a deep-linked theme is never applied
// without the user seeing what it claims to be and pressing Apply. Cancel (and
// Esc, and the backdrop, and the close button) writes nothing at all.
//
// ## Honest presentation
//
// `name` / `author` / `source` are strings the link author chose. The dialog
// therefore attributes them ("This link says…") instead of stating them as
// fact, and shows the palette the theme would actually paint — the one part of
// the link that cannot lie, because it IS what gets applied. Same copy
// discipline as the Settings picker: themes are "validated on this device",
// never "safe" (they are not sandboxed).
//
// ## Where the real validation happens
//
// Apply calls the ordinary `themes_import`, so a deep-linked palette walks the
// exact same path as a hand-imported file: the shared `theme_validator`
// value-shape allowlist runs host-side and rejects before anything is written
// to `vault.themes`. This component adds a confirmation step; it does not add
// (or weaken) a validation step.
//
// Mounted unconditionally by `Editor` — i.e. only on the post-unlock stage.
// That is what implements the locked-vault rule: a link arriving while locked
// stays in the `themeDeepLink` latch until this component mounts and drains it,
// and is discarded with the process if the user never unlocks.
//
// ## Shape
//
// The outer component owns exactly one piece of state — the current signal —
// and hands each request to a `key`-ed child. Per-request state (collision
// choice, in-flight, failure) lives in that child, so React's remount is what
// resets it; there is no hand-written reset to keep in sync across the
// present / close / retry paths.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell, UNSOLICITED_MODAL_Z } from "./primitives/ModalShell";
import { Button } from "./primitives/Button";
import { ThemeChiplet } from "./primitives/ThemeChiplet";
import {
  THEME_INSTALL_EVENT,
  consumePendingThemeInstall,
  type ThemeDeepLinkRejection,
  type ThemeDeepLinkResult,
  type ThemeInstallRequest,
} from "../lib/themeDeepLink";
import {
  importCustomTheme,
  listCustomThemes,
  nextAvailableThemeName,
  themePreview,
} from "../lib/themes";
import { activateCustomTheme } from "../lib/theme";
import { describeImportError } from "../lib/theme-errors";

const BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const NAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
  margin: 0,
  overflowWrap: "anywhere",
};

const META_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  margin: 0,
  overflowWrap: "anywhere",
};

const SOURCE_STYLE: CSSProperties = {
  ...META_STYLE,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

/** The chiplet, stretched into a full-width band for the confirm surface. */
const SWATCHES_STYLE: CSSProperties = {
  width: "100%",
  height: 44,
  borderRadius: "var(--radius-2)",
};

const QUESTION_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  margin: 0,
};

const HELPER_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  margin: 0,
};

const ERROR_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
  margin: 0,
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  marginTop: "var(--space-1)",
};

const COLLISION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  background: "var(--bg-2)",
};

const CHOICE_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  cursor: "pointer",
};

/** How a name that already exists in the vault gets resolved. */
type CollisionChoice = "replace" | "keep-both";

/** i18n key for a link that never became a request. */
function rejectionKey(reason: ThemeDeepLinkRejection): string {
  switch (reason) {
    case "unsupported-version":
      return "themeInstall.error.unsupportedVersion";
    case "invalid-name":
      return "themeInstall.error.invalidName";
    case "payload-too-large":
      return "themeInstall.error.payloadTooLarge";
    // `not-a-theme-link` is filtered out before it can reach a dialog; it shares
    // the damaged-data copy so this stays total without a throw.
    case "not-a-theme-link":
    case "missing-payload":
    case "malformed-payload":
      return "themeInstall.error.malformedPayload";
  }
}

/** The confirm surface for one parsed request. Remounted per link via `key`. */
function ConfirmInstall({
  request,
  onDone,
}: {
  request: ThemeInstallRequest;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  // `null` = the vault's theme list has not come back yet. Apply stays disabled
  // until it does: `themes_import` is an UPSERT, so applying against an unknown
  // name set is exactly the silent clobber this dialog exists to prevent.
  const [existingNames, setExistingNames] = useState<readonly string[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [choice, setChoice] = useState<CollisionChoice>("keep-both");
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Read the installed names so a collision is surfaced BEFORE Apply — the user
  // chooses replace-vs-keep-both up front rather than discovering after the fact
  // that something was overwritten. One decrypt.
  useEffect(() => {
    let cancelled = false;
    void listCustomThemes()
      .then((entries) => {
        if (!cancelled) setExistingNames(entries.map((e) => e.name));
      })
      .catch(() => {
        // Fail CLOSED. Treating an unreadable list as "no themes installed"
        // would turn every read failure into a deterministic overwrite of
        // whatever shares this name.
        if (!cancelled) setListFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const settled = existingNames !== null;
  const collides = settled && existingNames.includes(request.name);
  const targetName =
    collides && choice === "keep-both"
      ? nextAvailableThemeName(request.name, existingNames ?? [])
      : request.name;
  const preview = themePreview(request.palette);

  async function apply() {
    setApplying(true);
    setFailure(null);
    try {
      // The ordinary import path — the host re-validates the palette through
      // the value-shape allowlist and rejects before writing anything.
      await importCustomTheme(targetName, request.paletteJson);
    } catch (caught) {
      // Nothing was written: the host rejected before touching vault.themes.
      setFailure(describeImportError(caught, "themeInstall.error.importFailed"));
      setApplying(false);
      return;
    }
    try {
      await activateCustomTheme(targetName, request.palette);
    } catch {
      // Separate arm, separate copy: the theme IS installed at this point, so
      // saying "nothing was changed" here would be a lie. Only activation failed.
      setFailure(t("themeInstall.error.installedNotActivated", { name: targetName }));
      setApplying(false);
      return;
    }
    onDone();
  }

  return (
    <div style={BODY_STYLE} data-testid="theme-install.dialog">
      <div>
        <p style={NAME_STYLE} data-testid="theme-install.name">
          {request.name}
        </p>
        {request.author !== null && (
          <p style={META_STYLE} data-testid="theme-install.author">
            {t("themeInstall.byAuthor", { author: request.author })}
          </p>
        )}
        {request.source !== null && (
          <p style={SOURCE_STYLE} data-testid="theme-install.source">
            {request.source}
          </p>
        )}
      </div>

      <ThemeChiplet preview={preview} style={SWATCHES_STYLE} data-testid="theme-install.preview" />

      {collides && (
        <div style={COLLISION_STYLE} data-testid="theme-install.collision">
          <p style={QUESTION_STYLE}>
            {t("themeInstall.collision.question", { name: request.name })}
          </p>
          <label style={CHOICE_ROW_STYLE}>
            <input
              type="radio"
              name="theme-install-collision"
              checked={choice === "keep-both"}
              onChange={() => setChoice("keep-both")}
              data-testid="theme-install.keep-both"
            />
            {t("themeInstall.collision.keepBoth", { name: targetName })}
          </label>
          <label style={CHOICE_ROW_STYLE}>
            <input
              type="radio"
              name="theme-install-collision"
              checked={choice === "replace"}
              onChange={() => setChoice("replace")}
              data-testid="theme-install.replace"
            />
            {t("themeInstall.collision.replace", { name: request.name })}
          </label>
        </div>
      )}

      <p style={QUESTION_STYLE}>{t("themeInstall.question")}</p>
      <p style={HELPER_STYLE}>{t("themeInstall.helper")}</p>

      {listFailed && (
        <p style={ERROR_STYLE} data-testid="theme-install.list-failed">
          {t("themeInstall.error.listUnavailable")}
        </p>
      )}

      {failure !== null && (
        <p style={ERROR_STYLE} data-testid="theme-install.error">
          {failure}
        </p>
      )}

      <div style={ACTIONS_STYLE}>
        <Button
          variant="secondary"
          onClick={onDone}
          disabled={applying}
          data-testid="theme-install.cancel"
        >
          {t("themeInstall.cancel")}
        </Button>
        <Button
          variant="primary"
          onClick={() => void apply()}
          disabled={applying || !settled}
          data-testid="theme-install.apply"
        >
          {applying ? t("themeInstall.applying") : t("themeInstall.apply")}
        </Button>
      </div>
    </div>
  );
}

interface ThemeInstallDialogProps {
  /**
   * Hold the dialog closed while the first-run importer onboarding offer owns
   * the screen. A PRODUCT call, not a technical one — a first-run user should
   * finish onboarding before a theme install interrupts, and the request simply
   * waits (it stays in state and renders the moment this goes false). The
   * focus-trap primitive stacks correctly on its own (MYND-567 hardened
   * `trapFocus` so only the innermost trap enforces containment), so this is
   * NOT what keeps the two dialogs from fighting over focus.
   */
  deferred?: boolean;
}

export function ThemeInstallDialog({ deferred = false }: ThemeInstallDialogProps) {
  const { t } = useTranslation();
  const [signal, setSignal] = useState<ThemeDeepLinkResult | null>(null);

  // Two arrival paths, one dialog. The latch covers a link that landed before
  // this component existed (cold launch, or while the vault was locked); the
  // event covers a link that arrives with the editor already open. Both drain
  // the same latch, so a single link cannot open two dialogs.
  useEffect(() => {
    const drain = () => {
      const next = consumePendingThemeInstall();
      if (next) setSignal(next);
    };
    drain();
    window.addEventListener(THEME_INSTALL_EVENT, drain);
    return () => window.removeEventListener(THEME_INSTALL_EVENT, drain);
  }, []);

  const close = useCallback(() => setSignal(null), []);

  if (signal === null || deferred) return null;

  return (
    <ModalShell
      open
      title={signal.ok ? t("themeInstall.title") : t("themeInstall.errorTitle")}
      onClose={close}
      labelId="theme-install-title"
      closeLabel={t("themeInstall.close")}
      // Unlike every other modal, this one is opened by an OS event rather than
      // by the user, so it can land over an already-open surface. At the shared
      // level it would paint UNDER the command palette while the focus trap
      // still gave it the keyboard — a security gate you cannot see.
      zIndex={UNSOLICITED_MODAL_Z}
    >
      {signal.ok ? (
        // Keyed by the payload: a second link replaces the surface outright
        // rather than leaving the previous one's collision choice behind.
        <ConfirmInstall key={signal.request.paletteJson} request={signal.request} onDone={close} />
      ) : (
        <div style={BODY_STYLE} data-testid="theme-install.rejected">
          <p style={ERROR_STYLE} data-testid="theme-install.error">
            {t(rejectionKey(signal.reason))}
          </p>
          <p style={HELPER_STYLE}>{t("themeInstall.error.nothingWritten")}</p>
          <div style={ACTIONS_STYLE}>
            <Button variant="secondary" onClick={close} data-testid="theme-install.dismiss">
              {t("themeInstall.close")}
            </Button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
