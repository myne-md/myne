import { type CSSProperties, type ReactNode, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { editorCommands } from "@myne/editor/toolbar/commands";
import { undo, redo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { Spinner } from "../../../../components";
import type { PressEvt } from "../types";
import { formatBarLabelKey, visibleFormatBarIds } from "../../../../lib/formatBarItems";

/** Markdown formatting bar that rides above the keyboard (mobile's answer to the
 *  desktop selection toolbar — mirrors Obsidian's accessory bar; since MYND-559
 *  it is mobile's ONLY format surface, the engine's floating toolbar being off).
 *  Every action runs a SHARED `@myne/editor` command against the live CMEditor
 *  view, so the formatting logic is identical to desktop and lives in exactly one
 *  place.
 *
 *  Layout (MYND-555): a horizontally scrollable region of USER-CONFIGURABLE
 *  format actions, then the pinned insert chrome (attach / library / record), then
 *  the pinned right rail (raw toggle + keyboard dismiss). Only the first region is
 *  reorderable/hideable — see `lib/formatBarItems.ts` for why the chrome is not. */
export function FormatBar({
  view,
  attaching,
  rawMode,
  onToggleRaw,
  onAttach,
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
  onLibrary: () => void;
  onRecord: () => void;
  /** Persisted `editor_toolbar_order` (device-local). Empty = canonical order. */
  order?: readonly string[];
  /** Persisted `editor_toolbar_hidden` (device-local). Empty = show everything. */
  hidden?: readonly string[];
}) {
  const { t } = useTranslation();
  // Fire on a genuine TAP only — never while the row is being scrolled. On
  // pointerdown we preventDefault (keeps the editor's focus + selection, so
  // formatting applies to the current selection) and record the start; the action
  // runs on pointerup ONLY if the pointer barely moved since (a tap, not a
  // horizontal scroll drag over the buttons).
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
  // The press is recorded in ONE shared ref, so if the finger leaves the pressed
  // button (drifting onto a neighbor, or the row being flick-scrolled) we must
  // drop it — otherwise releasing over a different button would fire that button.
  const cancel = () => { pressRef.current = null; };
  const run = (fn: (v: EditorView) => void) => ({
    onPointerDown: onPress,
    onPointerUp: (e: PressEvt) => { if (isTap(e) && view) fn(view); },
    onPointerLeave: cancel,
    onPointerCancel: cancel,
  });
  const tap = (cb: () => void) => ({
    onPointerDown: onPress,
    onPointerUp: (e: PressEvt) => { if (isTap(e)) cb(); },
    onPointerLeave: cancel,
    onPointerCancel: cancel,
  });
  const fbtn: CSSProperties = {
    minWidth: 40,
    height: 40,
    padding: "0 8px",
    borderRadius: 9,
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
  const st = { stroke: "var(--fg-2)", strokeWidth: 1.7, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

  const labelOf = (id: string): string => {
    const key = formatBarLabelKey(id);
    return key ? t(key) : id;
  };

  /** One renderer per vocabulary id. Keyed by the SAME ids
   *  `lib/formatBarItems.ts` freezes — a vocabulary entry with no entry here
   *  renders nothing, which the unit test forbids. */
  const RENDERERS: Record<string, () => ReactNode> = {
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
        <svg width="20" height="20" viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="7" rx="1.5" {...st} /><path d="M4.6 7.5l1.5 1.5 2.3-2.6" {...st} /><path d="M13 7.5h8M13 16.5h8" {...st} /><rect x="3" y="13" width="7" height="7" rx="1.5" {...st} /></svg>
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

  return (
    <div
      data-testid="editor.format-bar"
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-2)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 1, overflowX: "auto", padding: "6px 6px", scrollbarWidth: "none", touchAction: "pan-x" }}>
        {visible.map((id) => RENDERERS[id]?.() ?? null)}
        {/* Separator between the configurable format region and the pinned insert
            chrome — omitted when every format action is hidden, so an emptied bar
            does not open with a stray rule. */}
        {visible.length > 0 && (
          <div style={{ width: 1, height: 22, background: "var(--line-2)", margin: "0 5px", flex: "none" }} />
        )}
        <button {...tap(onAttach)} disabled={attaching} aria-label={t("editor.formatBar.attachFile")} style={{ ...fbtn, opacity: attaching ? 0.5 : 1 }}>
          {attaching ? <Spinner size={18} /> : (
            <svg width="20" height="20" viewBox="0 0 24 24"><path d="M21 12.5 12.5 21a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.6 18.4a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6" {...st} /></svg>
          )}
        </button>
        <button {...tap(onLibrary)} aria-label={t("editor.formatBar.insertFromLibrary")} style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" {...st} /><circle cx="8.5" cy="9.5" r="1.5" fill="var(--fg-2)" /><path d="M20 15l-4.5-4.5L5 20" {...st} /></svg>
        </button>
        <button {...tap(onRecord)} aria-label={t("editor.formatBar.recordVoiceNote")} style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" {...st} /><path d="M6 11a6 6 0 0 0 12 0M12 17v3" {...st} /></svg>
        </button>
      </div>
      <button {...tap(onToggleRaw)} aria-label={rawMode ? t("editor.formatBar.showLivePreview") : t("editor.formatBar.showRawMarkdown")} style={{ ...fbtn, borderLeft: "1px solid var(--line-1)", borderRadius: 0, width: 44 }}>
        {rawMode ? (
          // Raw/source mode → pen (you're editing the raw markdown).
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1L18.5 8.5a2 2 0 0 0-3-3L5 16l-1 4zM14 6l3 3" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : (
          // Live/preview mode → eye (you're viewing the rendered content).
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke="var(--fg-2)" strokeWidth="1.7" /><circle cx="12" cy="12" r="2.7" stroke="var(--fg-2)" strokeWidth="1.7" /></svg>
        )}
      </button>
      <button {...run((v) => v.contentDOM.blur())} aria-label={t("editor.formatBar.hideKeyboard")} style={{ ...fbtn, borderLeft: "1px solid var(--line-1)", borderRadius: 0, width: 48 }}>
        <svg width="22" height="22" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="11" rx="2" stroke="var(--fg-2)" strokeWidth="1.6" fill="none" /><path d="M7 7.5h.01M11 7.5h.01M15 7.5h.01M7 11h.01M11 11h.01M15 11h.01M9 20l3 -3 3 3" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
      </button>
    </div>
  );
}
