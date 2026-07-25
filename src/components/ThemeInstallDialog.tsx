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

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "./primitives/ModalShell";
import { Button } from "./primitives/Button";
import {
  THEME_INSTALL_EVENT,
  consumePendingThemeInstall,
  type ThemeDeepLinkRejection,
  type ThemeInstallRequest,
  type ThemeInstallSignal,
} from "../lib/themeDeepLink";
import { importCustomTheme, listCustomThemes, themePreview } from "../lib/themes";
import { setCustomTheme } from "../lib/prefs";
import { applyCustomTheme } from "../lib/theme";
import i18n from "../i18n";
import type { ThemeError, ThemesError } from "../lib/themes";

const BODY_STYLE: CSSProperties = {
  padding: "var(--space-5)",
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

const SWATCHES_STYLE: CSSProperties = {
  display: "flex",
  height: 44,
  borderRadius: "var(--radius-2)",
  overflow: "hidden",
  border: "1px solid var(--line-2)",
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

/**
 * First free `"<name> (n)"` for `n ≥ 2`. Used by the keep-both branch so an
 * install never silently clobbers a theme the user already has, and never
 * fails just because the obvious suffix is taken too.
 */
export function nextAvailableThemeName(name: string, taken: readonly string[]): string {
  const existing = new Set(taken);
  if (!existing.has(name)) return name;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${name} (${n})`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${name} (${Date.now()})`;
}

/** i18n key for a parse/rejection reason raised before the host ever saw it. */
function rejectionKey(reason: Exclude<ThemeDeepLinkRejection, "not-a-theme-link">): string {
  switch (reason) {
    case "unsupported-version":
      return "themeInstall.error.unsupportedVersion";
    case "invalid-name":
      return "themeInstall.error.invalidName";
    case "missing-payload":
    case "malformed-payload":
      return "themeInstall.error.malformedPayload";
    case "payload-too-large":
      return "themeInstall.error.payloadTooLarge";
  }
}

/**
 * Point at the offending token when the host validator rejected the palette.
 * Reuses the Settings picker's message catalog — a deep-linked theme and a
 * hand-imported one fail for the same reasons and should say the same thing.
 */
function describeValidationError(error: ThemeError): string {
  switch (error.kind) {
    case "MissingKey":
      return i18n.t("settings.customThemes.error.missingKey", { key: error.key ?? "" }).trim();
    case "InvalidValue": {
      const key = error.key ?? i18n.t("settings.customThemes.error.aColorFallback");
      return error.line != null
        ? i18n.t("settings.customThemes.error.invalidValueWithLine", { key, line: error.line })
        : i18n.t("settings.customThemes.error.invalidValue", { key });
    }
    case "ParseError":
      return error.line != null
        ? i18n.t("settings.customThemes.error.parseErrorWithLine", { line: error.line })
        : i18n.t("settings.customThemes.error.parseError");
    case "InvalidName":
      return i18n.t("settings.customThemes.error.invalidName");
    default:
      return i18n.t("settings.customThemes.error.invalidFile");
  }
}

interface ThemeInstallDialogProps {
  /**
   * Hold the dialog closed while another focus-trapping modal owns the screen
   * (today: the first-run importer onboarding offer). Purely a deferral — the
   * request stays in state and renders the moment this goes false. Without it,
   * two `useFocusTrap` modals at the same z-index fight over focus.
   */
  deferred?: boolean;
}

export function ThemeInstallDialog({ deferred = false }: ThemeInstallDialogProps) {
  const { t } = useTranslation();
  const [signal, setSignal] = useState<ThemeInstallSignal | null>(null);
  const [existingNames, setExistingNames] = useState<readonly string[]>([]);
  const [choice, setChoice] = useState<CollisionChoice>("keep-both");
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const present = useCallback((next: ThemeInstallSignal) => {
    setSignal(next);
    setChoice("keep-both");
    setApplying(false);
    setFailure(null);
  }, []);

  // Two arrival paths, one dialog. The latch covers a link that landed before
  // this component existed (cold launch, or while the vault was locked); the
  // event covers a link that arrives with the editor already open. Draining the
  // latch on mount is also what makes the warm path idempotent — the event
  // handler re-reads it, so a single link cannot open two dialogs.
  useEffect(() => {
    const latched = consumePendingThemeInstall();
    if (latched) present(latched);
    const onEvent = () => {
      const next = consumePendingThemeInstall();
      if (next) present(next);
    };
    window.addEventListener(THEME_INSTALL_EVENT, onEvent);
    return () => window.removeEventListener(THEME_INSTALL_EVENT, onEvent);
  }, [present]);

  // Read the installed names so a collision can be surfaced BEFORE Apply — the
  // user chooses replace-vs-keep-both up front rather than discovering after
  // the fact that something was overwritten. A read failure is not fatal: it
  // just means no collision is offered, and the import still succeeds.
  const request = signal?.ok ? signal.request : null;
  useEffect(() => {
    if (request === null) return;
    let cancelled = false;
    void listCustomThemes()
      .then((entries) => {
        if (!cancelled) setExistingNames(entries.map((e) => e.name));
      })
      .catch(() => {
        if (!cancelled) setExistingNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  const close = useCallback(() => {
    setSignal(null);
    setFailure(null);
    setApplying(false);
  }, []);

  if (signal === null || deferred) return null;

  // ---- Failure surface: a link that never became a request -----------------
  if (!signal.ok) {
    return (
      <ModalShell
        open
        title={t("themeInstall.errorTitle")}
        onClose={close}
        labelId="theme-install-title"
        closeLabel={t("themeInstall.close")}
      >
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
      </ModalShell>
    );
  }

  const req: ThemeInstallRequest = signal.request;
  const collides = existingNames.includes(req.name);
  const targetName =
    collides && choice === "keep-both"
      ? nextAvailableThemeName(req.name, existingNames)
      : req.name;
  const preview = themePreview(req.palette);

  async function apply() {
    setApplying(true);
    setFailure(null);
    try {
      // The ordinary import path — the host re-validates the palette through
      // the value-shape allowlist and rejects before writing anything.
      await importCustomTheme(targetName, req.paletteJson);
      // Disk-first, mirroring the Settings picker: persist the selection, then
      // flip the live palette, so a crash between the two leaves the vault
      // consistent rather than the screen.
      await setCustomTheme(targetName);
      applyCustomTheme(req.palette);
      close();
    } catch (caught) {
      const err = caught as ThemesError | null;
      setFailure(
        err && err.kind === "Invalid" && err.detail?.error
          ? describeValidationError(err.detail.error)
          : t("themeInstall.error.importFailed"),
      );
      setApplying(false);
    }
  }

  return (
    <ModalShell
      open
      title={t("themeInstall.title")}
      onClose={close}
      labelId="theme-install-title"
      closeLabel={t("themeInstall.close")}
    >
      <div style={BODY_STYLE} data-testid="theme-install.dialog">
        <div>
          <p style={NAME_STYLE} data-testid="theme-install.name">
            {req.name}
          </p>
          {req.author !== null && (
            <p style={META_STYLE} data-testid="theme-install.author">
              {t("themeInstall.byAuthor", { author: req.author })}
            </p>
          )}
          {req.source !== null && (
            <p style={SOURCE_STYLE} data-testid="theme-install.source">
              {req.source}
            </p>
          )}
        </div>

        <div style={SWATCHES_STYLE} aria-hidden="true" data-testid="theme-install.preview">
          {[
            preview.background,
            preview.surface,
            preview.foreground,
            preview.accent,
            preview.line,
          ].map((color, i) => (
            <span key={i} style={{ flex: 1, background: color }} />
          ))}
        </div>

        {collides && (
          <div style={COLLISION_STYLE} data-testid="theme-install.collision">
            <p style={QUESTION_STYLE}>{t("themeInstall.collision.question", { name: req.name })}</p>
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
              {t("themeInstall.collision.replace", { name: req.name })}
            </label>
          </div>
        )}

        <p style={QUESTION_STYLE} data-testid="theme-install.question">
          {t("themeInstall.question")}
        </p>
        <p style={HELPER_STYLE}>{t("themeInstall.helper")}</p>

        {failure !== null && (
          <p style={ERROR_STYLE} data-testid="theme-install.error">
            {failure}
          </p>
        )}

        <div style={ACTIONS_STYLE}>
          <Button
            variant="secondary"
            onClick={close}
            disabled={applying}
            data-testid="theme-install.cancel"
          >
            {t("themeInstall.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void apply()}
            disabled={applying}
            data-testid="theme-install.apply"
          >
            {applying ? t("themeInstall.applying") : t("themeInstall.apply")}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
