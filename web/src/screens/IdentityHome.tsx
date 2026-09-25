import { useTranslation } from "react-i18next";
import { CenteredCard } from "../../../src/components/primitives/CenteredCard";

export interface IdentityHomeProps {
  [key: string]: unknown;
}

export function IdentityHome(_props: IdentityHomeProps) {
  const { t } = useTranslation();
  return (
    <CenteredCard>
      <h1
        style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xl)" }}
        data-testid="web.unavailable"
        data-surface="identity-home"
      >
        {t("web.unavailableHere.title")}
      </h1>
    </CenteredCard>
  );
}
