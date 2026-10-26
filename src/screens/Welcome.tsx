// SPDX-License-Identifier: AGPL-3.0
// The zero-vault entry screen (MYND-80).
//
// # One create door (myne-md/myne#911 task 6)
//
// This screen used to draw a fork: create an identity, or create a local vault
// with no identity, each with its own row and its own button, plus a skip that
// was implied by which one you pressed. That is gone. "Create" means one thing
// now: the identity first (one phrase, saved and proven), then the vault. The
// first run itself lives on its own stage (`FirstRun`), because it replaces the
// fork rather than sitting on top of this screen.
//
// The three secondary doors stay, and they are secondary by the COLOUR of one
// button rather than by position or by being hidden: create's action is the only
// accent-filled one on the screen. RESTORE is for a device whose vault exists
// somewhere else, and JOIN is for a device that already belongs to an account.
// Neither creates anything, so neither is a variant of "create".
import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { MyneMark } from "../components/primitives/MyneMark";
import { CHOICE_ACTION_STYLE, ChoiceCard, ChoiceRow } from "../components/ChoiceList";
import { RepairResidueBanner } from "../components/RepairResidueBanner";
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
  /** The one create door: the first run, identity then vault. */
  onStart: () => void;
  /** Fresh-install restore door (MYND-56; the user-guide UX contract). */
  onRestoreBackup: () => void;
  /**
   * The invited door: someone else's vault, addressed to this person's identity.
   * Runs the identity ceremony and lands on the identity home rather than on
   * vault creation, because an invited person needs an identity and not a vault
   * of their own to accept it.
   */
  onInvited: () => void;
  /**
   * Open the device-join modal (MYND-424). The modal itself is mounted by
   * App.tsx over every stage since myne#221 — this screen was its only host,
   * and `welcome` is produced only at ZERO vaults, so the first vault a user
   * created made the join door unreachable.
   */
  onJoinDevice: () => void;
}

// The endonyms are not translated (same as Settings → Appearance), so the
// options come straight from the config.
const LANGUAGE_OPTIONS = SUPPORTED_LANGUAGES.map((l) => ({ value: l.code, label: l.label }));

export function Welcome({ onStart, onRestoreBackup, onJoinDevice, onInvited }: WelcomeProps) {
  const { t, i18n } = useTranslation();
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

        {/* The four doors are ONE list (2026-10-24, the owner's read), not a
            banner above a card. Creating an identity and vault is the flow most
            people should follow, so it is the FIRST row and it is marked by the
            colour of its button rather than by a full-width accent block: that
            block read as the name of the screen, not as one of four doors, and the
            hint sentence under it has gone with it. All four rows say what they
            are for in one sentence, because "restore", "invite" and "join" are
            only distinguishable to someone who already knows which situation they
            are in. */}
        <div style={{ width: "100%", marginTop: "var(--space-5)" }}>
          <ChoiceCard>
            <ChoiceRow
              title={t("welcome.startAction")}
              body={t("welcome.startBody")}
              action={
                <Button
                  variant="primary"
                  onClick={onStart}
                  data-testid="welcome.create-cta"
                  style={CHOICE_ACTION_STYLE}
                >
                  {t("welcome.createAction")}
                </Button>
              }
            />
            {/* SECOND, though it used to be first: a person who has never used
                Myne often arrives already invited, and the row is kept for exactly
                that reason. It is still not the default arm, because it runs the
                same identity ceremony and creates no vault (myne-md/myne#911
                follow-up). */}
            <ChoiceRow
              title={t("welcome.invitedTitle")}
              body={t("welcome.invitedBody")}
              action={
                <Button
                  variant="secondary"
                  onClick={onInvited}
                  data-testid="welcome.invited-cta"
                  style={CHOICE_ACTION_STYLE}
                >
                  {t("welcome.invitedAction")}
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
    </div>
  );
}
