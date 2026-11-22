// The home surface (myne-md/myne#1074).
//
// **What this is right now: the seam, not the surface.** Task 12 of the plan
// gives home its tab kind, its singleton id and its restore path; the eleven
// cards, the arrangement and the synced layout are task 14 and land in this
// component. Shipping the kind without a body would render an empty pane that
// says nothing, which is indistinguishable from a bug, so this renders the one
// thing that is true today: the surface exists and holds no cards yet.
//
// It reads nothing and writes nothing. That is deliberate: a placeholder that
// touched the prefs member would make task 13's "a vault with no home member
// loads a default layout and writes nothing until the first edit" untestable.

import { useTranslation } from "react-i18next";

export function HomeSurface() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="home.surface"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space-3)",
        height: "100%",
        padding: "var(--space-6)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-lg)",
          color: "var(--fg-1)",
        }}
      >
        {t("notes.home.emptyTitle")}
      </div>
      <div
        style={{
          maxWidth: 420,
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
          lineHeight: 1.55,
          color: "var(--fg-3)",
        }}
      >
        {t("notes.home.emptyBody")}
      </div>
    </div>
  );
}
