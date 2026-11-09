// `<ViewImportDialog>` — import one `.myneview` manifest (view-manifests task 9).
//
// THE FIRST PLACE THIS TREE ACCEPTS A STRUCTURED ARTEFACT SOMEBODY ELSE WROTE, so
// it owes a consent surface before anything renders, and it owes it in a shape the
// reader can act on:
//
//   - the file is validated by the HOST's strict reader (`read_view_manifest`),
//     never by a JSON.parse here, so the grammar has one authority;
//   - the arrived definition is ordered against the one this vault holds, and the
//     four outcomes are four different sentences, because "refused" is only useful
//     with the reason;
//   - the capability summary is `<ViewConsent>` — the same component the rest of
//     the feature uses, not a second rendering of the same facts;
//   - nothing is stored until the reader chooses to store it, and the definition
//     does NOT approve itself when it lands: this device's approval names the
//     version it was shown, so new bytes are a new decision. The approve action is
//     right there under the summary the decision is about.
//
// A refusal writes nothing at all — not the definition, not the approval map — so
// the four arms are also the four safe arms.
//
// Design canon: `ModalShell` chrome, `Button`/`Icon` primitives, sentence case,
// tokens only. No new primitive, no new token.

import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "./primitives/ModalShell";
import { Button } from "./primitives/Button";
import { ViewConsent } from "./ViewConsent";
import { usePrefs } from "../hooks/usePrefs";
import { open as openFileDialog } from "../platform/dialog";
import { readViewManifest } from "../lib/prefs";
import type { SavedView } from "../lib/prefs";
import {
  approveImportedView,
  compareIncomingManifest,
  storeImportedView,
  type ManifestOrdering,
} from "../notes/importViewManifest";
import {
  isViewManifestReadError,
  type ViewManifestError,
} from "../types/view-manifest-error";

export interface ViewImportDialogProps {
  open: boolean;
  onClose: () => void;
}

type Step =
  | { kind: "idle" }
  | { kind: "reading" }
  /** The host refused the file. `reason` is null when it could not be read. */
  | { kind: "refused"; reason: ViewManifestError | null }
  /** Validated and ordered, nothing written. */
  | { kind: "ready"; ordering: ManifestOrdering }
  /** The definition landed; this device has not approved it yet. */
  | { kind: "stored"; incoming: SavedView }
  | { kind: "approveFailed"; incoming: SavedView };

const BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-5)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  color: "var(--fg-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
};

const PARAGRAPH_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--fg-2)",
};

const HEADING_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--fg-1)",
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
};

const FAILED_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--danger)",
};

const FOOTER_STYLE: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "var(--space-3)",
  padding: "var(--space-4) var(--space-5)",
  borderTop: "1px solid var(--line-1)",
};

/**
 * One sentence per refusal variant. The switch is exhaustive over the Rust
 * enum's mirror, so a new refusal kind is a compile error here rather than a
 * silent generic message.
 */
function reasonSentence(
  reason: ViewManifestError,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  switch (reason.kind) {
    case "UnknownKey":
      return t("notes.views.import.reasonUnknownKey", { key: reason.detail });
    case "ReservedWriteField":
      return t("notes.views.import.reasonReservedField", { field: reason.detail });
    case "VersionRequired":
      return t("notes.views.import.reasonVersionRequired");
    case "TooLarge":
      return t("notes.views.import.reasonTooLarge");
    case "Malformed":
      return t("notes.views.import.reasonMalformed");
    case "MissingField":
      return t("notes.views.import.reasonMissingField");
    case "WrongType":
      return t("notes.views.import.reasonWrongType");
    case "Unrepresentable":
      return t("notes.views.import.reasonUnrepresentable");
  }
}

function displayName(view: SavedView, untitled: string): string {
  return view.name.trim() === "" ? untitled : view.name;
}

export function ViewImportDialog({ open, onClose }: ViewImportDialogProps) {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [storing, setStoring] = useState(false);

  const reset = useCallback(() => {
    setStep({ kind: "idle" });
    setStoring(false);
  }, []);

  const pick = useCallback(async () => {
    setStep({ kind: "reading" });
    const picked = await openFileDialog({
      multiple: false,
      filters: [
        {
          name: t("notes.views.import.filterName"),
          extensions: ["myneview"],
        },
      ],
    });
    if (typeof picked !== "string") {
      // A dismissed dialog is free: nothing read, nothing said.
      setStep({ kind: "idle" });
      return;
    }
    try {
      const incoming = await readViewManifest(picked);
      const stored = prefs.saved_views.find((v) => v.id === incoming.id) ?? null;
      setStep({ kind: "ready", ordering: compareIncomingManifest(incoming, stored) });
    } catch (err) {
      // A named refusal (`Invalid`) carries the reader's reason, which the dialog
      // renders; anything else means the file could not be read at all. The
      // narrowing helper is the mirror's own, so a rejection from somewhere else
      // (a Tauri transport error) reads as "unreadable" rather than as a reason
      // this build invented.
      setStep({
        kind: "refused",
        reason:
          isViewManifestReadError(err) && err.kind === "Invalid"
            ? err.detail.reason
            : null,
      });
    }
  }, [prefs.saved_views, t]);

  const store = useCallback(async (incoming: SavedView) => {
    setStoring(true);
    try {
      await storeImportedView(incoming);
      setStep({ kind: "stored", incoming });
    } catch {
      setStep({ kind: "refused", reason: null });
    } finally {
      setStoring(false);
    }
  }, []);

  const approve = useCallback(async (incoming: SavedView) => {
    setStoring(true);
    try {
      await approveImportedView(incoming);
      setStep({ kind: "stored", incoming });
    } catch {
      setStep({ kind: "approveFailed", incoming });
    } finally {
      setStoring(false);
    }
  }, []);

  const untitled = t("notes.views.untitledView");

  const renderBody = (): ReactNode => {
    switch (step.kind) {
      case "idle":
        return (
          <>
            <p style={PARAGRAPH_STYLE}>{t("notes.views.import.idleBody")}</p>
            <Button
              variant="primary"
              data-testid="view-import.pick"
              onClick={() => void pick()}
            >
              {t("notes.views.import.pick")}
            </Button>
          </>
        );
      case "reading":
        return <p style={PARAGRAPH_STYLE}>{t("notes.views.import.reading")}</p>;
      case "refused":
        return (
          <div data-testid="view-import.refused" style={{ display: "grid", gap: "var(--space-3)" }}>
            <p style={HEADING_STYLE}>{t("notes.views.import.refusedHeading")}</p>
            <p style={PARAGRAPH_STYLE}>
              {step.reason === null
                ? t("notes.views.import.reasonUnreadable")
                : reasonSentence(step.reason, t)}
            </p>
            <p style={PARAGRAPH_STYLE}>{t("notes.views.import.refusedNothingStored")}</p>
          </div>
        );
      case "ready": {
        const ordering = step.ordering;
        if (ordering.kind === "identical") {
          return (
            <div data-testid="view-import.identical" style={{ display: "grid", gap: "var(--space-3)" }}>
              <p style={HEADING_STYLE}>
                {t("notes.views.import.armIdenticalHeading", {
                  name: displayName(ordering.stored, untitled),
                })}
              </p>
              <p style={PARAGRAPH_STYLE}>
                {t("notes.views.import.armIdentical", { version: ordering.incoming.version })}
              </p>
            </div>
          );
        }
        if (ordering.kind === "older" || ordering.kind === "sameVersionDifferentContent") {
          return (
            <div data-testid="view-import.refused" style={{ display: "grid", gap: "var(--space-3)" }}>
              <p style={HEADING_STYLE}>
                {t("notes.views.import.armRefusedHeading", {
                  name: displayName(ordering.stored, untitled),
                })}
              </p>
              <p style={PARAGRAPH_STYLE}>
                {ordering.kind === "older"
                  ? t("notes.views.import.armOlder", {
                      incoming: ordering.incoming.version,
                      stored: ordering.stored.version,
                    })
                  : t("notes.views.import.armSameVersionDifferent", {
                      version: ordering.incoming.version,
                    })}
              </p>
              <p style={PARAGRAPH_STYLE}>{t("notes.views.import.refusedNothingStored")}</p>
            </div>
          );
        }
        return (
          <div data-testid="view-import.ready" style={{ display: "grid", gap: "var(--space-4)" }}>
            <p style={PARAGRAPH_STYLE}>
              {ordering.kind === "new"
                ? t("notes.views.import.armNew", {
                    name: displayName(ordering.incoming, untitled),
                    version: ordering.incoming.version,
                  })
                : t("notes.views.import.armUpdate", {
                    name: displayName(ordering.stored, untitled),
                    incoming: ordering.incoming.version,
                    stored: ordering.stored.version,
                  })}
            </p>
            {/* The capability summary is the SAME component the rest of the
                feature uses: the decision in front of the reader is about these
                exact bytes, and a second rendering of them would be a second
                thing to keep true. */}
            <ViewConsent definition={ordering.incoming} />
          </div>
        );
      }
      case "stored":
        return (
          <div
            data-testid="view-import.stored"
            style={{ display: "grid", gap: "var(--space-4)" }}
          >
            <p style={HEADING_STYLE}>
              {t("notes.views.import.storedHeading", {
                name: displayName(step.incoming, untitled),
              })}
            </p>
            <p style={PARAGRAPH_STYLE}>
              {t("notes.views.import.storedBody", { version: step.incoming.version })}
            </p>
            <ViewConsent definition={step.incoming} />
          </div>
        );
      case "approveFailed":
        return (
          <div data-testid="view-import.approve-failed" style={{ display: "grid", gap: "var(--space-3)" }}>
            <p style={FAILED_STYLE}>{t("notes.views.import.approveFailed")}</p>
            <p style={PARAGRAPH_STYLE}>{t("notes.views.import.approveFailedBody")}</p>
          </div>
        );
    }
  };

  const footer = (): ReactNode => {
    switch (step.kind) {
      case "ready":
        if (
          step.ordering.kind === "new" ||
          step.ordering.kind === "update"
        ) {
          return (
            <Button
              variant="primary"
              data-testid="view-import.store"
              disabled={storing}
              onClick={() => void store(step.ordering.incoming)}
            >
              {step.ordering.kind === "new"
                ? t("notes.views.import.importAction")
                : t("notes.views.import.replaceAction")}
            </Button>
          );
        }
        return null;
      case "stored":
        // The approve action lives here rather than in the manager because the
        // summary that justifies it is on this screen.
        return (
          <Button
            variant="primary"
            data-testid="view-import.approve"
            disabled={storing}
            onClick={() => void approve(step.incoming)}
          >
            {t("notes.views.import.approveAction", { version: step.incoming.version })}
          </Button>
        );
      case "refused":
      case "approveFailed":
        return (
          <Button
            variant="secondary"
            data-testid="view-import.pick-again"
            onClick={() => {
              reset();
              void pick();
            }}
          >
            {t("notes.views.import.pickAgain")}
          </Button>
        );
      default:
        return null;
    }
  };

  return (
    <ModalShell
      open={open}
      title={t("notes.views.import.title")}
      labelId="view-import-title"
      onClose={onClose}
      width={520}
      closeLabel={t("common.close")}
      testId="view-import.modal"
      bodyBleed
    >
      <div data-testid="view-import.body" style={BODY_STYLE}>
        {renderBody()}
      </div>
      <div style={FOOTER_STYLE}>
        <Button variant="ghost" data-testid="view-import.close" onClick={onClose}>
          {t("common.close")}
        </Button>
        {footer()}
      </div>
    </ModalShell>
  );
}
