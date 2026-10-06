// Obsidian importer — the one-time post-first-unlock offer (MYND-53, task 8).
//
// The migration wedge (story 1): shown when the user reaches an unlocked editor
// (post-unlock, onboarding) and on each subsequent entry until they dismiss it
// once — then it never returns. Dismiss-default: "Not now" closes it, "Choose
// folder…" routes into the import flow (both persist the dismissal). A
// self-contained centered card over a dimmed backdrop (the four-condition
// desktop modal carve-out). The dismissal flag is owned by the parent (Editor),
// which persists it; this component is pure presentation.
//
// Design canon: Penpot "4 — Desktop UI Kit",
// `screen------importer — onboarding-offer (MYND-53)`.

import { useEffect, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useOverlayInert } from "../../hooks/useOverlayInert";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";

interface ImporterOnboardingOfferProps {
  open: boolean;
  /** Accept → route into the import flow (also dismisses for good). */
  onChoose: () => void;
  /** "Not now" / Esc / backdrop → dismiss for good. */
  onDismiss: () => void;
}

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--scrim)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

export function ImporterOnboardingOffer({
  open,
  onChoose,
  onDismiss,
}: ImporterOnboardingOfferProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  // The rest of the page goes INERT while this is open (myne-md/myne#728).
  // The focus trap above contains Tab; it does not stop a screen reader's
  // virtual cursor reading the page behind, and `aria-modal` is an assertion
  // some assistive technology ignores. Registered on the BACKDROP, which is
  // the whole overlay: registering the card would inert the backdrop it is in.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, open);
  // Trap + restore focus while open (MYND-93).
  useFocusTrap(dialogRef, { enabled: open });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="importer-offer-title"
      data-testid="importer.offer-root"
      style={BACKDROP_STYLE}
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: "calc(100vw - var(--space-7))",
          background: "var(--bg-2)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-3)",
          boxShadow: "var(--shadow-3)",
          padding: "var(--space-6)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
          fontFamily: "var(--font-sans)",
          color: "var(--fg-1)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <span
            aria-hidden
            style={{
              width: 40,
              height: 40,
              borderRadius: "var(--radius-2)",
              background: "var(--accent-soft)",
              color: "var(--accent)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "0 0 auto",
            }}
          >
            <Icon name="folder" size={20} />
          </span>
          <h2
            id="importer-offer-title"
            style={{
              margin: 0,
              fontSize: "var(--text-xl)",
              fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
              letterSpacing: "var(--tracking-tight)",
              color: "var(--fg-display)",
            }}
          >
            {t("notes.import.offer.title")}
          </h2>
        </div>

        <p
          style={{
            margin: 0,
            fontSize: "var(--text-sm)",
            lineHeight: "var(--leading-relaxed)",
            color: "var(--fg-2)",
          }}
        >
          {t("notes.import.offer.body")}
        </p>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <Button variant="ghost" onClick={onDismiss} data-testid="importer.offer-dismiss">
            {t("notes.import.offer.notNow")}
          </Button>
          <Button variant="primary" icon="folder" onClick={onChoose} data-testid="importer.offer-choose">
            {t("notes.import.offer.chooseFolder")}
          </Button>
        </div>

        <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
          {t("notes.import.offer.laterHint")}
        </p>
      </div>
    </div>
  );
}
