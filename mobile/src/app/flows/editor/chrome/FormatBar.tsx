import { type CSSProperties, useRef } from "react";
import { useTranslation } from "react-i18next";
import { editorCommands } from "@myne/editor/toolbar/commands";
import { undo, redo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { Spinner } from "../../../../components";
import type { PressEvt } from "../types";

/** Markdown formatting bar that rides above the keyboard (mobile's answer to the
 *  desktop selection toolbar — mirrors Obsidian's accessory bar). Every action
 *  runs a SHARED `@myne/editor` command against the live CMEditor view, so the
 *  formatting logic is identical to desktop and lives in exactly one place.
 *  Horizontally scrollable action row + a pinned keyboard-dismiss button. */
export function FormatBar({
  view,
  attaching,
  rawMode,
  onToggleRaw,
  onAttach,
  onLibrary,
  onRecord,
}: {
  view: EditorView | null;
  attaching: boolean;
  rawMode: boolean;
  onToggleRaw: () => void;
  onAttach: () => void;
  onLibrary: () => void;
  onRecord: () => void;
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
  return (
    <div
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
        <button {...run((v) => { undo(v); v.focus(); })} aria-label={t("notes.list.undo")} style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M7 7L3 11l4 4" {...st} /><path d="M3 11h11a6 6 0 0 1 0 12h-2" {...st} /></svg>
        </button>
        <button {...run((v) => { redo(v); v.focus(); })} aria-label={t("editor.formatBar.redo")} style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M17 7l4 4-4 4" {...st} /><path d="M21 11H10a6 6 0 0 0 0 12h2" {...st} /></svg>
        </button>
        <div style={{ width: 1, height: 22, background: "var(--line-2)", margin: "0 5px", flex: "none" }} />
        <button {...run(editorCommands.heading1)} aria-label={t("editor.slash.heading1")} style={{ ...fbtn, fontWeight: 700 }}>H1</button>
        <button {...run(editorCommands.heading2)} aria-label={t("editor.slash.heading2")} style={{ ...fbtn, fontWeight: 700, fontSize: 14 }}>H2</button>
        <button {...run(editorCommands.bold)} aria-label={t("editor.toolbar.customize.bold")} style={{ ...fbtn, fontWeight: 800 }}>B</button>
        <button {...run(editorCommands.italic)} aria-label={t("editor.toolbar.customize.italic")} style={{ ...fbtn, fontStyle: "italic", fontWeight: 600 }}>I</button>
        <button {...run(editorCommands.bulletList)} aria-label={t("editor.slash.bulletList")} style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11" {...st} /><circle cx="4.5" cy="6" r="1.3" fill="var(--fg-2)" /><circle cx="4.5" cy="12" r="1.3" fill="var(--fg-2)" /><circle cx="4.5" cy="18" r="1.3" fill="var(--fg-2)" /></svg>
        </button>
        <button {...run(editorCommands.checklist)} aria-label={t("editor.toolbar.customize.checklist")} style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="7" rx="1.5" {...st} /><path d="M4.6 7.5l1.5 1.5 2.3-2.6" {...st} /><path d="M13 7.5h8M13 16.5h8" {...st} /><rect x="3" y="13" width="7" height="7" rx="1.5" {...st} /></svg>
        </button>
        <button {...run(editorCommands.quote)} aria-label={t("editor.slash.quote")} style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M5 5v14M9 8h11M9 12h11M9 16h7" {...st} /></svg>
        </button>
        <button {...run(editorCommands.code)} aria-label={t("editor.toolbar.customize.code")} style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4" {...st} /></svg>
        </button>
        <button {...run(editorCommands.wikilink)} aria-label={t("editor.slash.wikiLink")} style={{ ...fbtn, fontWeight: 700, fontSize: 15 }}>[[</button>
        <button {...run(editorCommands.link)} aria-label={t("editor.slash.link")} style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6L11 7" {...st} /><path d="M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6L13 17" {...st} /></svg>
        </button>
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
