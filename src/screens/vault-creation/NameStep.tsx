// Step 1 of 4 — what to call this vault (myne-md/myne#468 K10).
//
// Why the flow asks at all, and asks here: the lock screen now names the vault
// it is asking a password for (myne-md/myne#773), and the picker lists vaults by
// name, so a name does real work from the first unlock. Nothing asked for one,
// and a second vault stayed "Vault 2" until the user found Settings → Account.
//
// Why BEFORE the password rather than beside the kit: the kit's header carries
// the vault's name, both on screen and in the file it saves, so the name has to
// exist by then. `prd.md` flags the placement as reasoned rather than measured.
//
// Blank is a legitimate answer. There is no validation beyond the 4096-byte cap
// `MAX_VAULT_LABEL_PLAINTEXT_LEN` already enforces in the backend, and an empty
// name leaves the neutral fallback the picker has always had. So Continue is
// never disabled: a step the user may skip must not look like a gate.

import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Input } from "../../components/primitives/Input";
import { StepCard, StepCounter, StepHeading, StepLayout } from "./step-shell";

interface NameStepProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Leaves vault creation entirely. The first step, so Back is the way out. */
  onBack: () => void;
}

export function NameStep({ value, onChange, onSubmit, onBack }: NameStepProps) {
  const { t } = useTranslation();
  return (
    <StepLayout>
      <StepCounter
        step="name"
        label={t("vaultCreation.name.eyebrowLabel")}
      />
      <StepHeading>{t("vaultCreation.name.heading")}</StepHeading>

      <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}>
        {t("vaultCreation.name.intro")}
      </div>

      {/* A form, so Enter submits. The step has one field and one action, and
          reaching for the mouse to leave a single text input is the kind of
          friction this step is too small to justify. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}
      >
        <StepCard>
          <Input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("vaultCreation.name.placeholder")}
            aria-label={t("vaultCreation.name.heading")}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            data-testid="create.name-input"
          />

          <div style={{ fontSize: "var(--text-sm)", lineHeight: 1.6, color: "var(--fg-3)" }}>
            {t("vaultCreation.name.helper")}
          </div>
        </StepCard>

        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button
            type="button"
            variant="ghost"
            onClick={onBack}
            icon="arrow-left"
            data-testid="create.name-back"
          >
            {t("common.back")}
          </Button>
          <div style={{ flex: 1 }} />
          <Button type="submit" variant="primary" data-testid="create.name-continue">
            {t("common.continue")}
          </Button>
        </div>
      </form>
    </StepLayout>
  );
}
