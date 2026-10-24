// `<ViewConsent>` — the capability summary a reader is shown before they approve
// a view definition they did not write (view-manifests, myne-md/myne#922 task 6).
//
// THIS COMPONENT IS THE MITIGATION, so it states what is true of THIS definition
// rather than describing the feature. The residual risk the PRD names is
// deception: a manifest is data, it adds no trust boundary, and the only thing
// standing between an author and a reader is that the reader can see what the
// definition selects and reads before it renders anything.
//
// Three consequences, and each is a rule rather than a preference:
//
// - The summary is DERIVED from the definition by `viewCapabilitySummary`, and
//   this component takes the definition rather than a summary prop, so no caller
//   can hand it a description that disagrees with the view it is asking about.
// - It never summarises the read set. There is no "everything" case to collapse
//   to, because the derivation enumerates property keys, and a sentence that
//   rounded them up would be the one lie the surface exists to prevent.
// - An empty section is OMITTED, never rendered as "none": a view that writes
//   nothing has no write authority to describe, and a greyed "can write: none"
//   row reads as a field the reader failed to fill in.
//
// Design canon: sentence case, paper-and-ink, one accent (unused here: this is a
// statement, not an action), no colour as the sole channel. No new primitive and
// no new icon: the section heading is the whole mark, because the glyph a filter
// would want is not in the Lucide set this tree ships and inventing one is a
// design-system change rather than a consent-surface one. Tokens only, no
// literals: the surface is inside a modal a custom theme must repaint end to end.
//
// Observability (src/AGENTS.md "Test observability"): every section carries a
// `view-consent.*` testid so the import scenario can read the summary it approved.

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PropertyOp, SavedView } from "../lib/prefs";
import {
  viewCapabilitySummary,
  type ViewSelection,
} from "../notes/views/capabilitySummary";

export interface ViewConsentProps {
  /** The definition being offered for approval. The summary is computed from it
   *  here rather than passed in, which is what makes a lying caller impossible. */
  definition: SavedView;
}

const ROOT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  color: "var(--fg-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
};

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const HEADING_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  margin: 0,
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
};

const BODY_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--fg-2)",
};

const LEAD_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--fg-2)",
};

const LIST_STYLE: CSSProperties = {
  margin: 0,
  paddingInlineStart: "var(--space-5)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

const CHIP_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-2)",
};

/**
 * A property key is a literal the vault's author typed and the reader has to
 * compare against their own notes, so it is drawn in the mono face for the same
 * reason a cryptographic identifier is: slashed zero and unambiguous glyphs. The
 * chip is `--bg-2` on the modal's `--paper` with a `--line-1` hairline, which is
 * the design system's card treatment (fill + hairline, never a shadow).
 */
const CHIP_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-1)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "0 var(--space-2)",
};

const NOTE_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
};

/** The closed property-operator vocabulary, rendered as words. `contains` is
 *  list membership or a substring, so its sentence says "contains" and does not
 *  promise an equality. */
function operatorKey(op: PropertyOp): string {
  switch (op) {
    case "==":
      return "notes.viewConsent.opIs";
    case "!=":
      return "notes.viewConsent.opIsNot";
    case ">":
      return "notes.viewConsent.opMoreThan";
    case "<":
      return "notes.viewConsent.opLessThan";
    case ">=":
      return "notes.viewConsent.opAtLeast";
    case "<=":
      return "notes.viewConsent.opAtMost";
    case "contains":
      return "notes.viewConsent.opContains";
  }
}

function selectionIsEmpty(node: ViewSelection): boolean {
  switch (node.kind) {
    case "and":
    case "or":
      return node.children.length === 0;
    default:
      return false;
  }
}

export function ViewConsent({ definition }: ViewConsentProps) {
  const { t } = useTranslation();
  // `definition` is a fresh object on every import preview pass less often than
  // not, but the memo keeps a long consent body from re-deriving while the
  // dialog re-renders for something else (a hover, a focus move).
  const summary = useMemo(() => viewCapabilitySummary(definition), [definition]);

  const renderSelection = (node: ViewSelection): ReactNode => {
    switch (node.kind) {
      case "everyNote":
        return <p style={BODY_STYLE}>{t("notes.viewConsent.everyNote")}</p>;
      case "condition": {
        const condition = node.condition;
        if (condition.kind === "tag") {
          return (
            <p style={BODY_STYLE}>
              {t("notes.viewConsent.tagged", { tag: condition.value })}
            </p>
          );
        }
        if (condition.kind === "folder") {
          return (
            <p style={BODY_STYLE}>
              {t("notes.viewConsent.inFolder", { folder: condition.value })}
            </p>
          );
        }
        if (condition.kind === "search") {
          return (
            <p style={BODY_STYLE}>
              {t("notes.viewConsent.matching", { query: condition.value })}
            </p>
          );
        }
        return (
          <p style={BODY_STYLE}>
            {t("notes.viewConsent.propertyCondition", {
              key: condition.key,
              operator: t(operatorKey(condition.op)),
              value: condition.value,
            })}
          </p>
        );
      }
      case "and":
      case "or": {
        // An empty combinator matches everything (it has nothing to exclude), so
        // it renders as the every-note sentence rather than as an empty list.
        if (selectionIsEmpty(node)) {
          return <p style={BODY_STYLE}>{t("notes.viewConsent.everyNote")}</p>;
        }
        return (
          <div style={SECTION_STYLE}>
            <p style={LEAD_STYLE}>
              {node.kind === "and"
                ? t("notes.viewConsent.allOf")
                : t("notes.viewConsent.anyOf")}
            </p>
            <ul style={LIST_STYLE}>
              {node.children.map((child, index) => (
                <li key={index}>{renderSelection(child)}</li>
              ))}
            </ul>
          </div>
        );
      }
      case "not":
        return (
          <div style={SECTION_STYLE}>
            <p style={LEAD_STYLE}>{t("notes.viewConsent.noneOf")}</p>
            <ul style={LIST_STYLE}>
              <li>{renderSelection(node.child)}</li>
            </ul>
          </div>
        );
    }
  };

  return (
    <div data-testid="view-consent.root" style={ROOT_STYLE}>
      <section style={SECTION_STYLE} data-testid="view-consent.selection">
        <h3 style={HEADING_STYLE}>{t("notes.viewConsent.selectionHeading")}</h3>
        {renderSelection(summary.selection)}
      </section>

      {summary.readsProperties.length > 0 && (
        <section style={SECTION_STYLE} data-testid="view-consent.reads">
          <h3 style={HEADING_STYLE}>{t("notes.viewConsent.readsHeading")}</h3>
          <div style={CHIP_ROW_STYLE}>
            {summary.readsProperties.map((key) => (
              <span key={key} style={CHIP_STYLE} data-property={key}>
                {key}
              </span>
            ))}
          </div>
        </section>
      )}

      {summary.writesProperties.length > 0 && (
        <section style={SECTION_STYLE} data-testid="view-consent.writes">
          <h3 style={HEADING_STYLE}>{t("notes.viewConsent.writesHeading")}</h3>
          <div style={CHIP_ROW_STYLE}>
            {summary.writesProperties.map((key) => (
              <span key={key} style={CHIP_STYLE} data-property={key}>
                {key}
              </span>
            ))}
          </div>
          <p style={NOTE_STYLE}>{t("notes.viewConsent.writesNote")}</p>
        </section>
      )}

      {summary.template !== null && (
        <section style={SECTION_STYLE} data-testid="view-consent.template">
          <h3 style={HEADING_STYLE}>{t("notes.viewConsent.templateHeading")}</h3>
          <p style={BODY_STYLE}>
            {t("notes.viewConsent.templateLine", { template: summary.template })}
          </p>
        </section>
      )}

      <p style={NOTE_STYLE} data-testid="view-consent.data-not-code">
        {t("notes.viewConsent.dataNotCode")}
      </p>
    </div>
  );
}
