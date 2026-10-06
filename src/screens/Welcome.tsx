import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { MyneMark } from "../components/primitives/MyneMark";
import { CHOICE_ACTION_STYLE, ChoiceCard, ChoiceRow } from "../components/ChoiceList";
import { RepairResidueBanner } from "../components/RepairResidueBanner";
import { IdentitySetupDialog } from "../components/IdentitySetupDialog";
import { stageRootStyle } from "../components/primitives/stageRoot";
import { SearchableSelect } from "../components/primitives/SearchableSelect";
import { setLanguage } from "../i18n";
import { SUPPORTED_CODES, SUPPORTED_LANGUAGES, type LanguageCode } from "../i18n/config";

// There is deliberately NO plain-file gate toggle on this screen
// (myne-md/myne#788, amended 2026-10-01). The gate is ON by default and the
// surface is reachable from the app menu's File → Open File…, so a vault-less
// device needs no control here to use it. The only switch now lives in
// Settings → Editor, where a user with a vault can turn the surface back off;
// a device with no vault has no Settings to host it.

interface WelcomeProps {
  onCreateVault: () => void;
  /** Fresh-install restore door (MYND-56; the user-guide UX contract). */
  onRestoreBackup: () => void;
  /**
   * Open the device-join modal (MYND-424). The modal itself is mounted by
   * App.tsx over every stage since myne#221 — this screen was its only host,
   * and `welcome` is produced only at ZERO vaults, so the first vault a user
   * created made the join door unreachable.
   */
  onJoinDevice: () => void;
  /** Fired after identity-only setup succeeds, so App re-probes and lands on
   *  the identity home (`myne-md/myne#711`). */
  onIdentityCreated?: () => void;
}

// The endonyms are not translated (same as Settings → Appearance), so the
// options come straight from the config.
const LANGUAGE_OPTIONS = SUPPORTED_LANGUAGES.map((l) => ({ value: l.code, label: l.label }));

export function Welcome({ onCreateVault, onRestoreBackup, onJoinDevice, onIdentityCreated }: WelcomeProps) {
  const { t, i18n } = useTranslation();
  // Identity-only setup (myne-md/myne#711): a vault-less person can create an
  // identity and be invite-addressed before owning any vault. The dialog is
  // local to this screen, like the other modal carve-outs; it creates no vault.
  const [identityOpen, setIdentityOpen] = useState(false);
  const active = i18n.resolvedLanguage ?? i18n.language;
  const language = SUPPORTED_CODES.includes(active) ? active : "en";
  return (
    <div
      data-testid="welcome.root"
      style={{
        ...stageRootStyle,
        background: "var(--bg-1)",
        padding: "var(--space-5)",
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <MyneMark size={72} />
        <div
          style={{
            marginTop: "var(--space-4)",
            fontFamily: "var(--font-display)",
            fontSize: "var(--text-3xl)",
            fontWeight: "var(--weight-semibold)",
            letterSpacing: "-0.02em",
            color: "var(--fg-display)",
          }}
        >
          Myne
        </div>
        <div
          style={{
            marginTop: "var(--space-2)",
            fontSize: "var(--text-base)",
            color: "var(--fg-2)",
            textAlign: "center",
          }}
        >
          {t("welcome.tagline")}
        </div>

        {/* Orphan-residue cleanup (MYND-159). Renders nothing unless a
            partial-fail vault_delete left artefacts behind — surfaced here,
            on Welcome, because that is exactly where the user lands when
            vault.meta is gone (Settings is unreachable without a vault). */}
        <div style={{ width: "100%", marginTop: "var(--space-5)" }}>
          <RepairResidueBanner />
        </div>

        <div style={{ width: "100%", marginTop: "var(--space-5)" }}>
        <ChoiceCard>
          {/* The fork (myne-md/myne#768, decisions/ui/0615). Identity comes
              first, because Myne is organised around it: an identity is what
              makes a person addressable for invites, and one identity spans
              many vaults. The local vault sits directly under it rather than
              behind a link, since an offline vault with no identity is a
              legitimate choice and the identity can be added later. */}
          <ChoiceRow
            title={t("welcome.identityTitle")}
            body={t("welcome.identityBody")}
            action={
              <Button
                variant="primary"
                onClick={() => setIdentityOpen(true)}
                data-testid="welcome.identity-cta"
                style={CHOICE_ACTION_STYLE}
              >
                {t("welcome.createAction")}
              </Button>
            }
          />
          <ChoiceRow
            title={t("welcome.localTitle")}
            body={t("welcome.localBody")}
            action={
              <Button
                variant="secondary"
                onClick={onCreateVault}
                data-testid="welcome.create-cta"
                style={CHOICE_ACTION_STYLE}
              >
                {t("welcome.createAction")}
              </Button>
            }
          />
          <ChoiceRow
            title={t("welcome.restoreTitle")}
            body={t("welcome.restoreBody")}
            action={
              <Button
                variant="secondary"
                onClick={onRestoreBackup}
                data-testid="welcome.restore-cta"
                style={CHOICE_ACTION_STYLE}
              >
                {t("welcome.restoreAction")}
              </Button>
            }
          />
          <ChoiceRow
            title={t("welcome.joinTitle")}
            body={t("welcome.joinBody")}
            action={
              <Button
                variant="secondary"
                onClick={onJoinDevice}
                data-testid="welcome.join-cta"
                style={CHOICE_ACTION_STYLE}
              >
                {t("welcome.joinAction")}
              </Button>
            }
            last
          />
        </ChoiceCard>
        </div>

        <div
          style={{
            width: "100%",
            marginTop: "var(--space-4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--space-3)",
          }}
        >
          <div style={{ width: 200 }}>
            {/* Language is device-local and works before any vault exists
                (src/i18n/config.ts), so the first screen is where a person
                who does not read English can change it. */}
            <SearchableSelect
              options={LANGUAGE_OPTIONS}
              selected={[language as LanguageCode]}
              onChange={(next) => {
                const chosen = next[0];
                if (chosen !== undefined) void setLanguage(chosen);
              }}
              aria-label={t("settings.language.label")}
              testId="welcome.language-select"
            />
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
            {t("welcome.version", { version: __APP_VERSION__ })}
          </div>
        </div>
      </div>

      <IdentitySetupDialog
        open={identityOpen}
        onClose={() => setIdentityOpen(false)}
        onCreated={onIdentityCreated}
      />
    </div>
  );
}
