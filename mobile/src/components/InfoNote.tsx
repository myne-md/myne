// `InfoNote`: the mobile shape of the desktop's question-mark disclosure
// (`src/components/settings/HelperDisclosure.tsx`, myne-md/myne#885).
//
// ── What it replaces, and why the shape is a sheet ─────────────────────────
//
// Three settings surfaces used to carry their whole explanation as grey
// paragraphs directly under the row: the Privacy hide-vault-names block (three
// of them) and both delete-vault confirmations (the keychain note). On a phone
// that is most of a screen spent on prose the reader scrolls past to reach the
// control, which is the failure `docs/design/` names as a row that is an essay.
// Desktop answered it with a "?" that opens a popover; mobile's idiom for "a
// small amount of text on demand" is the bottom sheet it already uses everywhere
// (`components/misc.tsx`'s `Sheet`), so the same copy opens in one of those.
//
// **The critical sentence stays on the row.** This component is only ever handed
// the copy that is *not* the load-bearing claim: the destructive sentence next to
// the hide-vault-names switch, and the primary "this cannot be undone" paragraph
// in the delete flows, are rendered by their own surfaces and never move behind
// a tap. What is behind the tap is the mechanics and the bounds.
//
// ── The bounds are one tap away, and that is a decision, not an oversight ──
//
// `mobile/tests/hide-vault-names.test.ts` used to assert that both bound
// sentences rendered on a first paint with nothing tapped, on the argument that
// a bound the reader has to tap for is one most readers never see. That argument
// lost to the one above (myne-md/myne#960): the copy is unchanged and reachable,
// the trigger sits on the title line of the row it explains, and desktop has put the
// same two sentences behind a question mark since #885, so the two clients now
// present the same disclosure the same way. The COPY is still byte-identical
// across clients, which is the invariant that matters and the one the test keeps.
//
// ── Assistive tech ─────────────────────────────────────────────────────────
//
// The trigger is a real button with an accessible name and `aria-expanded`, and
// the sheet it opens is a dialog whose first focus lands inside it, so a screen
// reader reads the copy on activation rather than never. Nothing is announced
// twice: the copy exists in exactly one place, inside the sheet, and is not
// duplicated into a visually hidden node (desktop's popover needs that node
// because it is a hover surface; a modal does not).

import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import { Sheet } from "./misc";
import { Button } from "./Button";

const TRIGGER_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  // The touch target, not the glyph: 44px is the floor WCAG 2.2 AA's 2.5.8 asks
  // for, and mobile's own geometry (`styles/tokens.css`) is larger everywhere
  // else. The glyph stays 16px so the control reads as an annotation on the row
  // rather than as a second action beside the switch.
  width: 44,
  height: 44,
  marginInlineStart: "calc(-1 * var(--space-2))",
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--fg-3)",
  cursor: "pointer",
  flex: "none",
};

const SHEET_BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-4) 0",
  color: "var(--fg-2)",
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
};

const SHEET_ACTIONS_STYLE: CSSProperties = {
  padding: "var(--space-4)",
};

export type InfoNoteProps = {
  /** One string per paragraph, already localised (`t()` at the call site). */
  paragraphs: readonly string[];
  /**
   * Accessible name for the trigger. Omitted by default, which uses the same
   * shared `settings.helperDisclosureLabel` the desktop's question mark carries
   * ("More about this setting"), so one phrase names the affordance on both
   * clients and no locale key is invented for the mobile-only shape.
   */
  label?: string;
  /** Base for the two testids: `${testId}-trigger` and `${testId}-sheet`. */
  testId: string;
  /** Overrides the trigger's box where a surface needs a different placement. */
  style?: CSSProperties;
};

export function InfoNote({ paragraphs, label, testId, style }: InfoNoteProps): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const name = label ?? t("settings.helperDisclosureLabel");
  const sheetId = useId();
  return (
    <>
      <button
        type="button"
        aria-label={name}
        aria-expanded={open}
        aria-controls={open ? sheetId : undefined}
        data-testid={`${testId}-trigger`}
        onClick={() => setOpen(true)}
        style={style === undefined ? TRIGGER_STYLE : { ...TRIGGER_STYLE, ...style }}
      >
        <Icon name="info" size={16} />
      </button>
      {open && (
        <Sheet onClose={() => setOpen(false)}>
          <div id={sheetId} data-testid={`${testId}-sheet`} style={SHEET_BODY_STYLE}>
            {paragraphs.map((p) => (
              <p key={p} style={{ margin: 0 }}>
                {p}
              </p>
            ))}
          </div>
          <div style={SHEET_ACTIONS_STYLE}>
            <Button onClick={() => setOpen(false)}>{t("common.close")}</Button>
          </div>
        </Sheet>
      )}
    </>
  );
}
