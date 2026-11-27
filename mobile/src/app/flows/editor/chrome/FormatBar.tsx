import { ornamentRole } from "@myne/ornaments";
import { type CSSProperties, type ReactNode, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { editorCommands } from "@myne/editor/toolbar/commands";
import { undo, redo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { Sheet, Spinner } from "../../../../components";
import type { PressEvt } from "../types";
import { formatBarLabelKey, visibleFormatBarIds } from "../../../../lib/formatBarItems";

/** The editor's accessory bar, above the keyboard.
 *
 *  **Round 2 (owner, 2026-11-27): "editörün içindeyken görünen toolbardan hiç
 *  memnun değilim".** The old bar was a horizontally scrolling strip of twelve
 *  40px glyphs followed by four pinned insert buttons, a raw toggle and a
 *  keyboard button — twenty targets in a 52pt band, most of them one character
 *  wide, which reads as a developer tool sitting under a document. It is now a
 *  THIN docked band with six standing actions that are actually pressed while
 *  writing (undo, redo, bold, italic, checklist, attach) and one ⋯ that opens
 *  everything else in a sheet, where each action gets a glyph AND its name.
 *
 *  The behaviour is unchanged: every action still runs a shared `@myne/editor`
 *  command against the live CMEditor view, and the user's `editor_toolbar_order`
 *  / `editor_toolbar_hidden` preferences still decide what the sheet offers
 *  (the standing six are the pinned subset — a preference that could empty the
 *  bar would leave the sheet as the only way to undo a keystroke). */
export function FormatBar({
  view,
  attaching,
  rawMode,
  onToggleRaw,
  onAttach,
  onPhotoToNote,
  onLibrary,
  onRecord,
  order = [],
  hidden = [],
}: {
  view: EditorView | null;
  attaching: boolean;
  rawMode: boolean;
  onToggleRaw: () => void;
  onAttach: () => void;
  onPhotoToNote: () => void;
  onLibrary: () => void;
  onRecord: () => void;
  order?: readonly string[];
  hidden?: readonly string[];
}) {
  const { t } = useTranslation();
  const [more, setMore] = useState(false);

  // Fire on a genuine TAP only — never while the row is being scrolled. On
  // pointerdown we preventDefault (keeps the editor's focus + selection, so
  // formatting applies to the current selection) and record the start; the action
  // runs on pointerup ONLY if the pointer barely moved since.
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const onPress = (e: PressEvt) => {
    e.preventDefault();
    pressRef.current = { x: e.clientX, y: e.clientY };
  };
  const isTap = (e: PressEvt): boolean => {
    const d = pressRef.current;
    pressRef.current = null;
    return d != null && Math.abs(e.clientX - d.x) <= 10 && Math.abs(e.clientY - d.y) <= 10;
  };
  const cancel = () => {
    pressRef.current = null;
  };
  const run = (fn: (v: EditorView) => void) => ({
    onPointerDown: onPress,
    onPointerUp: (e: PressEvt) => {
      if (isTap(e) && view) fn(view);
    },
    onPointerLeave: cancel,
    onPointerCancel: cancel,
  });
  const tap = (cb: () => void) => ({
    onPointerDown: onPress,
    onPointerUp: (e: PressEvt) => {
      if (isTap(e)) cb();
    },
    onPointerLeave: cancel,
    onPointerCancel: cancel,
  });

  const fbtn: CSSProperties = {
    minWidth: 42,
    height: 42,
    padding: "0 6px",
    borderRadius: 10,
    border: "none",
    background: "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flex: "none",
    color: "var(--fg-2)",
    fontSize: 16,
  };
  const st = {
    stroke: "var(--fg-2)",
    strokeWidth: 1.7,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const labelOf = (id: string): string => {
    const key = formatBarLabelKey(id);
    return key ? t(key) : id;
  };

  /** One renderer per vocabulary id. Keyed by the SAME ids
   *  `lib/formatBarItems.ts` freezes — a vocabulary entry with no entry here
   *  renders nothing, which the unit test forbids. */
  const RENDERERS: Record<string, (tile?: boolean) => ReactNode> = {
    undo: () => (
      <button key="undo" {...run((v) => { undo(v); v.focus(); })} aria-label={labelOf("undo")} data-format-item="undo" style={fbtn}>
        <svg width="20" height="20" viewBox="0 0 24 24"><path d="M7 7L3 11l4 4" {...st} /><path d="M3 11h11a6 6 0 0 1 0 12h-2" {...st} /></svg>
      </button>
    ),
    redo: () => (
      <button key="redo" {...run((v) => { redo(v); v.focus(); })} aria-label={labelOf("redo")} data-format-item="redo" style={fbtn}>
        <svg width="20" height="20" viewBox="0 0 24 24"><path d="M17 7l4 4-4 4" {...st} /><path d="M21 11H10a6 6 0 0 0 0 12h2" {...st} /></svg>
      </button>
    ),
    heading1: () => (
      <button key="heading1" {...run(editorCommands.heading1)} aria-label={labelOf("heading1")} data-format-item="heading1" style={{ ...fbtn, fontWeight: 700 }}>H1</button>
    ),
    heading2: () => (
      <button key="heading2" {...run(editorCommands.heading2)} aria-label={labelOf("heading2")} data-format-item="heading2" style={{ ...fbtn, fontWeight: 700, fontSize: 14 }}>H2</button>
    ),
    bold: () => (
      <button key="bold" {...run(editorCommands.bold)} aria-label={labelOf("bold")} data-format-item="bold" style={{ ...fbtn, fontWeight: 800 }}>B</button>
    ),
    italic: () => (
      <button key="italic" {...run(editorCommands.italic)} aria-label={labelOf("italic")} data-format-item="italic" style={{ ...fbtn, fontStyle: "italic", fontWeight: 600 }}>I</button>
    ),
    bulletList: () => (
      <button key="bulletList" {...run(editorCommands.bulletList)} aria-label={labelOf("bulletList")} data-format-item="bulletList" style={fbtn}>
        <svg width="20" height="20" viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11" {...st} /><circle cx="4.5" cy="6" r="1.3" fill="var(--fg-2)" /><circle cx="4.5" cy="12" r="1.3" fill="var(--fg-2)" /><circle cx="4.5" cy="18" r="1.3" fill="var(--fg-2)" /></svg>
      </button>
    ),
    checklist: () => (
      <button key="checklist" {...run(editorCommands.checklist)} aria-label={labelOf("checklist")} data-format-item="checklist" style={fbtn}>
        <svg width="20" height="20" viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="3" {...st} /><path d="M7.6 12l2.4 2.4 4.6-5" {...st} /></svg>
      </button>
    ),
    quote: () => (
      <button key="quote" {...run(editorCommands.quote)} aria-label={labelOf("quote")} data-format-item="quote" style={fbtn}>
        <svg width="20" height="20" viewBox="0 0 24 24"><path d="M5 5v14M9 8h11M9 12h11M9 16h7" {...st} /></svg>
      </button>
    ),
    code: () => (
      <button key="code" {...run(editorCommands.code)} aria-label={labelOf("code")} data-format-item="code" style={fbtn}>
        <svg width="20" height="20" viewBox="0 0 24 24"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4" {...st} /></svg>
      </button>
    ),
    wikilink: () => (
      <button key="wikilink" {...run(editorCommands.wikilink)} aria-label={labelOf("wikilink")} data-format-item="wikilink" style={{ ...fbtn, fontWeight: 700, fontSize: 15 }}>[[</button>
    ),
    link: () => (
      <button key="link" {...run(editorCommands.link)} aria-label={labelOf("link")} data-format-item="link" style={fbtn}>
        <svg width="20" height="20" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6L11 7" {...st} /><path d="M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6L13 17" {...st} /></svg>
      </button>
    ),
  };

  // `order` / `hidden` come from `usePrefs`, whose value changes only on a prefs
  // nonce bump — but this component re-renders on every keystroke (EditorFlow
  // owns the doc state), so without the memo the whole resolve+filter would run
  // per character typed.
  const visible = useMemo(() => visibleFormatBarIds(order, hidden), [order, hidden]);

  /** The five that stand in the bar. Everything else lives in ⋯.
   *
   *  Both halves are derived from `visible` (the user's resolved order) rather
   *  than from this constant's own order: pinning a SET must not pin its
   *  sequence, or a reorder in Settings → Toolbar buttons would move items inside
   *  the sheet while the bar stayed put. */
  const STANDING = ["undo", "redo", "bold", "italic", "checklist"] as const;
  const standing = visible.filter((id) => (STANDING as readonly string[]).includes(id));
  const rest = visible.filter((id) => !(STANDING as readonly string[]).includes(id));

  /** Sheet tiles: a 4-column grid of glyph + name. An unlabelled row of marks was
   *  the complaint about the old bar, so the sheet names every action. */
  const tile = (id: string, onClick: () => void, glyph: ReactNode, label: string, pinned = false) => (
    <button
      key={id}
      type="button"
      onClick={onClick}
      aria-label={label}
      // Only the USER-CONFIGURABLE vocabulary carries `data-format-item`: the
      // four pinned actions below are chrome, and a spec that counts format items
      // must not count them (`scripts/check-token-adoption` and the flow tier both
      // read this attribute as "a format action").
      {...(pinned ? { "data-sheet-action": id } : { "data-format-item": id })}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minHeight: 64,
        border: "1px solid var(--line-1)",
        borderRadius: 12,
        background: "transparent",
        color: "var(--fg-2)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        padding: "8px 4px",
      }}
    >
      {glyph}
      {/* Two lines, not one ellipsised line: at four columns on a phone the
          longest names ("Photo to note", "Show raw markdown") truncated into
          "Photo to n…", which is a label nobody can read and therefore a tile
          nobody can use. */}
      <span style={{ maxWidth: "100%", textAlign: "center", lineHeight: 1.25, overflowWrap: "anywhere" }}>{label}</span>
    </button>
  );

  const tileGlyphs: Record<string, ReactNode> = {
    heading1: <span style={{ fontWeight: 700, fontSize: 17 }}>H1</span>,
    heading2: <span style={{ fontWeight: 700, fontSize: 16 }}>H2</span>,
    bulletList: <svg width="20" height="20" viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11" {...st} /><circle cx="4.5" cy="6" r="1.3" fill="var(--fg-2)" /><circle cx="4.5" cy="12" r="1.3" fill="var(--fg-2)" /><circle cx="4.5" cy="18" r="1.3" fill="var(--fg-2)" /></svg>,
    quote: <svg width="20" height="20" viewBox="0 0 24 24"><path d="M5 5v14M9 8h11M9 12h11M9 16h7" {...st} /></svg>,
    code: <svg width="20" height="20" viewBox="0 0 24 24"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4" {...st} /></svg>,
    wikilink: <span style={{ fontWeight: 700, fontSize: 15 }}>[[</span>,
    link: <svg width="20" height="20" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6L11 7" {...st} /><path d="M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6L13 17" {...st} /></svg>,
  };
  const tileRun: Record<string, (v: EditorView) => void> = {
    heading1: editorCommands.heading1,
    heading2: editorCommands.heading2,
    bulletList: editorCommands.bulletList,
    quote: editorCommands.quote,
    code: editorCommands.code,
    wikilink: editorCommands.wikilink,
    link: editorCommands.link,
  };

  return (
    <>
      <div
        data-testid="editor.format-bar"
        // Ornament role (myne#394): CHROME, like every other bar.
        {...ornamentRole("chrome")}
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: "1px solid var(--line-1)",
          background: "var(--bg-2)",
          padding: "2px 6px",
          paddingBottom: "calc(2px + env(safe-area-inset-bottom, 0px))",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0 }}>
          {standing.map((id) => RENDERERS[id]?.() ?? null)}
          <div style={{ width: 1, height: 20, background: "var(--line-2)", margin: "0 4px", flex: "none" }} />
          <button {...tap(onAttach)} disabled={attaching} aria-label={t("editor.formatBar.attachFile")} style={{ ...fbtn, opacity: attaching ? 0.5 : 1 }}>
            {attaching ? (
              <Spinner size={18} />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24"><path d="M21 12.5 12.5 21a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.6 18.4a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6" {...st} /></svg>
            )}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "none" }}>
          <button
            {...tap(() => setMore(true))}
            aria-label={t("editor.formatBar.more")}
            data-testid="editor.format-more"
            style={fbtn}
          >
            <svg width="20" height="20" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="var(--fg-2)" /><circle cx="12" cy="12" r="1.6" fill="var(--fg-2)" /><circle cx="19" cy="12" r="1.6" fill="var(--fg-2)" /></svg>
          </button>
          <button {...run((v) => v.contentDOM.blur())} aria-label={t("editor.formatBar.hideKeyboard")} style={fbtn}>
            <svg width="21" height="21" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="11" rx="2" stroke="var(--fg-2)" strokeWidth="1.6" fill="none" /><path d="M7 8.5h.01M11 8.5h.01M15 8.5h.01M7 12h.01M11 12h.01M15 12h.01M9 20l3-3 3 3" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
          </button>
        </div>
      </div>

      {more && (
        <Sheet onClose={() => setMore(false)}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 0 12px" }}>
            <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>{t("editor.formatBar.moreTitle")}</span>
            <button
              type="button"
              onClick={() => setMore(false)}
              style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 0 }}
            >
              {t("common.done")}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, maxHeight: "52vh", overflowY: "auto" }}>
            {rest.map((id) =>
              tile(
                id,
                () => {
                  const fn = tileRun[id];
                  if (fn && view) fn(view);
                  setMore(false);
                },
                tileGlyphs[id] ?? <span style={{ fontWeight: 700 }}>{id.slice(0, 2)}</span>,
                labelOf(id),
              ),
            )}
            {tile("photo", () => { onPhotoToNote(); setMore(false); },
              <svg width="20" height="20" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2" {...st} /><path d="M8 6l1.5-2h5L16 6" {...st} /><circle cx="12" cy="13" r="3.4" {...st} /></svg>,
              t("editor.formatBar.photoToNote"), true)}
            {tile("library", () => { onLibrary(); setMore(false); },
              <svg width="20" height="20" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" {...st} /><circle cx="8.5" cy="9.5" r="1.5" fill="var(--fg-2)" /><path d="M20 15l-4.5-4.5L5 20" {...st} /></svg>,
              t("editor.formatBar.insertFromLibrary"), true)}
            {tile("record", () => { onRecord(); setMore(false); },
              <svg width="20" height="20" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" {...st} /><path d="M6 11a6 6 0 0 0 12 0M12 17v3" {...st} /></svg>,
              t("editor.formatBar.recordVoiceNote"), true)}
            {tile("raw", () => { onToggleRaw(); setMore(false); },
              rawMode ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1L18.5 8.5a2 2 0 0 0-3-3L5 16l-1 4zM14 6l3 3" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke="var(--fg-2)" strokeWidth="1.7" /><circle cx="12" cy="12" r="2.7" stroke="var(--fg-2)" strokeWidth="1.7" /></svg>
              ),
              rawMode ? t("editor.formatBar.showLivePreview") : t("editor.formatBar.showRawMarkdown"), true)}
          </div>
        </Sheet>
      )}
    </>
  );
}
