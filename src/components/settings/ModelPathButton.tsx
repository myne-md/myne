// `ModelPathButton`: the location control for a model file, plus the two
// helpers only it and the model rows need (myne-md/myne#848, moved here by
// myne-md/myne#867).
//
// ── Why it is its own module ────────────────────────────────────────────────
// Three model surfaces render this control: the AI panel's per-role assignment
// rows, and the downloaded-artefact rows now that those live in the catalogue
// modal. It used to sit inside `AiPanel.tsx` with the role rows, which was fine
// while it had one home; a second home would have meant either a circular import
// between the panel and the catalogue or a second copy of a control this
// repository has already paid to de-duplicate once.
//
// ── Why the location is a button rather than a printed path ─────────────────
// **A model file's location is a folder, not a paragraph.** Both kinds of row
// used to print the full path inline. On a real machine that is
// `/Users/<name>/Library/Application Support/md.myne.desktop/models/...`, longer
// than the panel, so it either ran past the edge or squeezed the label beside it
// into one word per line, and the panel read as broken. A path is also the least
// useful thing to print: the part a user recognises is the file name, and the
// part they need when they act on it is the folder.
//
// So the location is a button. It is DISABLED when there is no file (nothing to
// reveal), its accessible name and tooltip carry the file name, short, which is
// what a tooltip is for, and pressing it opens the full path with the one
// action that path enables: show it in the folder.

import { useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { revealItemInDir } from "../../platform/opener";
import { AnchoredPanel } from "../primitives/AnchoredPanel";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";

/** The last segment of a path, for a control that has room for one word rather
 *  than a full location. Both separators: a stored path is whatever the host
 *  returned, and the Windows shape reaches this panel on Windows. */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The path disclosure's own box: monospace, wrapping, selectable. A path is
 *  text to copy as often as it is a thing to click. */
export const PATH_PANEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-2)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
};

export const PATH_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-2)",
  overflowWrap: "anywhere",
  userSelect: "text",
};

export function ModelPathButton(props: {
  path: string | null;
  /** The row's role, for the accessible name: "Show the location of ...". */
  label: string;
  revealLabel: string;
  testId: string;
  panelTestId: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const path = props.path;
  const name = path === null ? props.label : fileNameOf(path);
  return (
    <>
      <span ref={anchorRef} style={{ display: "inline-flex" }}>
        <IconButton
          icon="folder"
          iconSize={14}
          label={t("settings.ai.modelShowLocation", { name })}
          tooltip
          disabled={path === null}
          expanded={open}
          testId={props.testId}
          onClick={() => setOpen((o) => !o)}
        />
      </span>
      <AnchoredPanel
        open={open && path !== null}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        minWidth={300}
        align="end"
        style={PATH_PANEL_STYLE}
        testId={props.panelTestId}
      >
        <span data-testid={`${props.panelTestId}-path`} style={PATH_TEXT_STYLE}>
          {path}
        </span>
        <Button
          variant="secondary"
          data-testid={`${props.testId}-reveal`}
          onClick={() => {
            // Reveal failure is swallowed: the path is on screen and the user
            // can copy it, which is the fallback the action was offering.
            void revealItemInDir(path ?? "").catch(() => {});
            setOpen(false);
          }}
        >
          {props.revealLabel}
        </Button>
      </AnchoredPanel>
    </>
  );
}
