// `<FolderRow>` — a single folder row in the sidebar tree (folder icon + name,
// with the disclosure chevron right-aligned at the row's trailing edge),
// indented by depth. Supports: click-to-collapse,
// right-click context menu, inline rename, and being a drag-drop target.
// Empty deliberate folders render dimmed with an "empty" hint and no
// disclosure. Token-bound per `colors_and_type.css`; matched to the MYND-144
// Penpot frames.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { FolderNode } from "../folderTree";
import { ColorDot } from "./ColorDot";
import { FolderGlyph } from "./FolderGlyph";
import { Icon } from "../../components/primitives/Icon";
import { dragEdge, dragZone, insertionLineStyle } from "./reorderDnd";
import { TreeRails } from "./TreeRails";

const INDENT_PER_LEVEL = 18;
// Left inset of a top-level folder icon. Kept small so the folder glyph sits
// close to the sidebar edge (just past the section eyebrow) rather than looking
// indented, and so its center (BASE_PADDING_LEFT + iconSize/2 = 8 + 8.5 = 16.5)
// lines up with the descending indent rail (`TreeRails.RAIL_X0`).
const BASE_PADDING_LEFT = 8;

const rowBaseStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 30,
  paddingRight: 12,
  cursor: "pointer",
  borderRadius: 6,
  marginLeft: 4,
  marginRight: 4,
  // Matches NoteRow: a 3px bottom gap so an active/hover folder row never butts
  // its background against an adjacent row's, keeping the interleaved tree of
  // folder + note pills uniform.
  marginBottom: 3,
  userSelect: "none",
  fontFamily: "var(--font-sans)",
  boxSizing: "border-box",
};

const nameStyle: CSSProperties = {
  fontSize: 13,
  // Matched to the note-row title weight (`NoteRow.titleStyle`, 500) so a
  // folder heading and a note heading read at the same size — the folder icon
  // (enlarged below) carries the container's visual weight instead of bolder
  // text.
  fontWeight: 500,
  color: "var(--fg-2)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

// A non-empty folder's name GROWS to fill the row so the trailing cluster
// (folder-note affordance + the disclosure chevron) is pushed to the right edge
// — the chevron sits right-most. Kept off `emptyNameStyle` so an empty folder's
// dimmed name + "empty" hint stay packed next to each other on the left.
const nameGrowStyle: CSSProperties = {
  ...nameStyle,
  flex: 1,
  minWidth: 0,
};

const emptyNameStyle: CSSProperties = {
  ...nameStyle,
  fontWeight: 500,
  fontStyle: "italic",
  color: "var(--fg-3)",
};

const emptyHintStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--line-3)",
  marginLeft: 4,
};

const renameInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg-1)",
  background: "var(--paper-1)",
  border: "1px solid var(--accent)",
  borderRadius: 3,
  padding: "1px 4px",
  outline: "none",
};

/** Trailing folder-note affordance (MYND-370). When the folder HAS an index
 *  note it's an icon-only "open the folder note" button; with NO index it reads
 *  "+ folder note" (revealed on hover) to create one. Subtle `fg-3` ink; both
 *  stop click-propagation so they never toggle collapse. */
const indexAffordanceBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  marginLeft: "auto",
  flexShrink: 0,
  padding: "1px 5px",
  border: 0,
  borderRadius: "var(--radius-1)",
  background: "transparent",
  color: "var(--fg-3)",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  fontWeight: 500,
  cursor: "pointer",
};

// Single right-pointing chevron that rotates 90° to point down when the folder
// is expanded — the disclosure motion. The rotation lives on an HTML <span>
// wrapper (not the <svg>) so transform-origin is a reliable 50% 50% — applying
// `transform` directly to an SVG element makes the rotation pivot ambiguous
// across engines. Token-bound transition; reduced-motion is honored globally
// (tokens.css zeroes transition-duration).
function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        flexShrink: 0,
        transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
        transformOrigin: "50% 50%",
        transition: "transform var(--duration-base) var(--ease-standard)",
      }}
    >
      <svg
        width={12}
        height={12}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ color: "var(--fg-3)", display: "block" }}
        aria-hidden="true"
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </span>
  );
}

const folderGlyphSvgStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  color: "var(--fg-3)",
  transition: "opacity var(--duration-base) var(--ease-standard)",
};

function FolderIconGlyph({
  open,
  style,
}: {
  open: boolean;
  style: CSSProperties;
}) {
  return (
    <svg
      width={17}
      height={17}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {open ? (
        <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H21a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
      ) : (
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      )}
    </svg>
  );
}

// Open/closed folder glyphs stacked and cross-faded on `open` so the icon
// transitions smoothly rather than snapping (an SVG path swap can't tween).
function FolderIcon({ open }: { open: boolean }) {
  return (
    <span
      style={{ position: "relative", width: 17, height: 17, flexShrink: 0 }}
      aria-hidden="true"
    >
      <FolderIconGlyph
        open={false}
        style={{ ...folderGlyphSvgStyle, opacity: open ? 0 : 1 }}
      />
      <FolderIconGlyph
        open={true}
        style={{ ...folderGlyphSvgStyle, opacity: open ? 1 : 0 }}
      />
    </span>
  );
}

export type FolderRowProps = {
  node: FolderNode;
  depth: number;
  collapsed: boolean;
  empty: boolean;
  /** Active drag-drop target highlight (a note is being dragged onto it). */
  dropTarget?: boolean;
  /** Inline-rename mode (edit the last path segment). */
  renaming?: boolean;
  /** What is currently being dragged — gates note-move vs folder-reorder. */
  dragKind?: "note" | "folder" | null;
  /** Folder-reorder insertion edge when this row is the reorder target. */
  reorderPlace?: "above" | "below" | null;
  onToggle: (key: string) => void;
  onContextMenu?: (
    node: FolderNode,
    position: { x: number; y: number },
  ) => void;
  /** Drag entered/left this folder row (key, or null on leave). */
  onDragTarget?: (key: string | null) => void;
  /** A note (or notes) dropped onto this folder. */
  onDropNote?: (folderPath: string) => void;
  /** This folder row started being dragged (folder reorder). */
  onDragStartFolder?: (e: ReactDragEvent, node: FolderNode) => void;
  /** A folder is hovering over this row at `place` (reorder indicator). */
  onFolderReorderOver?: (node: FolderNode, place: "above" | "below") => void;
  /** A folder drag left this row. */
  onFolderReorderLeave?: (key: string) => void;
  /** A dragged folder was dropped relative to this row (reorder). */
  onFolderReorderDrop?: (node: FolderNode, place: "above" | "below") => void;
  /** Any drag originating from this row ended (cleanup transient UI). */
  onDragEnd?: () => void;
  /** Commit an inline rename to `newName` (last-segment name). */
  onCommitRename?: (node: FolderNode, newName: string) => void;
  onCancelRename?: () => void;
  /** Color-label slot (MYND-184) — renders a small dot after the folder icon.
   *  Undefined when the folder has no color. */
  colorSlot?: string;
  /** Custom folder-icon glyph name (MYND-185) — replaces the default folder
   *  icon. Undefined when the folder uses the default glyph. */
  iconName?: string;
  /** Open this folder's index note (MYND-370) — wired only when the folder HAS
   *  an index (`node.indexNoteId !== null`). Same open path as a note-row click. */
  onOpenIndexNote?: (noteId: string) => void;
  /** Create a new index note for this folder (MYND-370) — wired only when the
   *  folder has NO index note. Mints + opens the note. */
  onCreateFolderNote?: (folderPath: string) => void;
  /** Double-click activation (MYND-370): open this folder's index note, or create
   *  one if the folder has none. The folder note is hidden from the tree, so the
   *  double-click on the folder row is its primary open gesture. */
  onActivate?: (node: FolderNode) => void;
};

export function FolderRow({
  node,
  depth,
  collapsed,
  empty,
  dropTarget = false,
  renaming = false,
  dragKind = null,
  reorderPlace = null,
  onToggle,
  onContextMenu,
  onDragTarget,
  onDropNote,
  onDragStartFolder,
  onFolderReorderOver,
  onFolderReorderLeave,
  onFolderReorderDrop,
  onDragEnd,
  onCommitRename,
  onCancelRename,
  colorSlot,
  iconName,
  onOpenIndexNote,
  onCreateFolderNote,
  onActivate,
}: FolderRowProps) {
  const { t } = useTranslation();
  const [hovering, setHovering] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const paddingLeft = BASE_PADDING_LEFT + depth * INDENT_PER_LEVEL;
  const expanded = !collapsed && !empty;

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = inputRef.current?.value.trim() ?? "";
      if (v.length > 0 && v !== node.name) onCommitRename?.(node, v);
      else onCancelRename?.();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancelRename?.();
    }
  };

  const background = dropTarget
    ? "var(--accent-soft)"
    : hovering
      ? "var(--paper-1)"
      : "transparent";

  return (
    <div
      style={{
        ...rowBaseStyle,
        position: "relative",
        paddingLeft,
        background,
        boxShadow: dropTarget ? "inset 0 0 0 1px var(--accent)" : undefined,
      }}
      draggable={!renaming}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={() => {
        if (!empty && !renaming) onToggle(node.key);
      }}
      onDoubleClick={() => {
        // Double-click opens (or creates) the folder note — its primary gesture
        // now that the note is hidden from the tree (MYND-370). Single-click still
        // toggles disclosure; the two clicks of a double-click net to no fold
        // change.
        if (!renaming) onActivate?.(node);
      }}
      onContextMenu={(e) => {
        if (renaming) return;
        e.preventDefault();
        onContextMenu?.(node, { x: e.clientX, y: e.clientY });
      }}
      onDragStart={(e) => onDragStartFolder?.(e, node)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (dragKind === "folder") {
          // Folder drag → reorder among sibling folders (2-edge).
          if (!onFolderReorderOver) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onFolderReorderOver(node, dragEdge(e));
        } else if (onDropNote) {
          // Note drag → 3-zone: top/bottom quarter reorders the note as a
          // sibling of this folder (insertion line); the middle half moves it
          // INTO the folder (row highlight). MYND-183 Task 6b.
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const zone = dragZone(e);
          if (zone === "into") {
            onDragTarget?.(node.key);
            onFolderReorderLeave?.(node.key);
          } else {
            onFolderReorderOver?.(node, zone);
            onDragTarget?.(null);
          }
        }
      }}
      onDragLeave={() => {
        onFolderReorderLeave?.(node.key);
        onDragTarget?.(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (dragKind === "folder") {
          onFolderReorderDrop?.(node, dragEdge(e));
          return;
        }
        const zone = dragZone(e);
        onDragTarget?.(null);
        if (zone === "into") onDropNote?.(node.path);
        else onFolderReorderDrop?.(node, zone);
      }}
      role="treeitem"
      aria-expanded={empty ? undefined : expanded}
      data-testid="notes.folder-row"
      data-folder-path={node.path}
      title={node.path}
    >
      <TreeRails depth={depth} />
      {reorderPlace && (
        <div style={insertionLineStyle(reorderPlace)} aria-hidden="true" />
      )}
      {iconName ? (
        <FolderGlyph name={iconName} size={17} style={{ color: "var(--fg-3)" }} />
      ) : (
        <FolderIcon open={expanded} />
      )}
      <ColorDot slot={colorSlot} style={{ marginRight: 1 }} />
      {renaming ? (
        <input
          ref={inputRef}
          type="text"
          defaultValue={node.name}
          style={renameInputStyle}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => {
            const v = inputRef.current?.value.trim() ?? "";
            if (v.length > 0 && v !== node.name) onCommitRename?.(node, v);
            else onCancelRename?.();
          }}
        />
      ) : (
        <>
          <span style={empty ? emptyNameStyle : nameGrowStyle}>{node.name}</span>
          {empty && (
            <span style={emptyHintStyle}>{t("notes.folderRow.empty")}</span>
          )}
          {node.indexNoteId !== null ? (
            onOpenIndexNote && (
              <button
                type="button"
                style={indexAffordanceBaseStyle}
                data-testid="notes.folder-index-affordance"
                data-folder-path={node.path}
                title={t("notes.folderRow.openFolderNote")}
                aria-label={t("notes.folderRow.openFolderNote")}
                onClick={(e) => {
                  // Never toggle collapse — opening the index note is its own
                  // action (MYND-370).
                  e.stopPropagation();
                  onOpenIndexNote(node.indexNoteId as string);
                }}
              >
                <Icon name="book-open" size={13} />
              </button>
            )
          ) : (
            onCreateFolderNote &&
            hovering && (
              <button
                type="button"
                style={indexAffordanceBaseStyle}
                data-testid="notes.folder-index-affordance"
                data-folder-path={node.path}
                title={t("notes.folderRow.createFolderNote")}
                aria-label={t("notes.folderRow.createFolderNote")}
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateFolderNote(node.path);
                }}
              >
                <Icon name="book-open" size={13} />
                <span>{t("notes.folderRow.folderNote")}</span>
              </button>
            )
          )}
        </>
      )}
      {/* Disclosure chevron, right-most: the grown name (or the rename input's
          own `flex:1`) pushes it — and the folder-note affordance — to the far
          right. Empty folders don't disclose, so they show none. */}
      {!empty && <Chevron collapsed={collapsed} />}
    </div>
  );
}
