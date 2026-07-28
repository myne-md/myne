// The web build's stand-in for the first-run Welcome screen
// (phase3-web-client task 70).
//
// # Unreachable, and therefore not shipped
//
// `initialStageFromProbe` routes an empty client to `welcome` only where vault
// CREATION exists; on web the capability is absent, so the empty state is
// `account-entry` — "this browser has not been told which account to pull"
// rather than "make a new vault" (task 85). Every other door into this screen
// is a create-flow door, and those are gated by the same capability.
//
// So the screen is unreachable here. This file is what makes it ABSENT as well,
// which is the bar the rest of this feature holds: unreachable is a claim about
// routing, absent is a property of the artefact. It also keeps the create CTA,
// the join-device modal and the fresh-install restore door out of a bundle
// where none of the three can be honoured.
//
// It renders a sentence rather than nothing for the same reason its siblings do:
// a blank render would make a routing bug look like a broken build.

import { useTranslation } from "react-i18next";
import { CenteredCard } from "../../../src/components/primitives/CenteredCard";

export interface WelcomeProps {
  [key: string]: unknown;
}

export function Welcome(_props: WelcomeProps) {
  const { t } = useTranslation();
  return (
    // The container anchor (phase3-web-client task 100). A scenario asserts
    // "absent, not disabled" POSITIVELY — it finds this surface and reads its
    // `data-surface` — rather than by the absence of a selector, which is
    // indistinguishable from a selector somebody renamed.
    <CenteredCard>
      <h1
        style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xl)" }}
        data-testid="web.unavailable"
        data-surface="welcome"
      >
        {t("web.unavailableHere.title")}
      </h1>
      <p style={{ color: "var(--fg-3)" }} data-testid="web.welcome-absent">
        {t("web.unavailableHere.creation")}
      </p>
    </CenteredCard>
  );
}
