import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon, useEnterTransition } from "../../../../components";
import { HAS_TAURI } from "../../../../lib/app-window";
import { searchNotes } from "../../../../lib/search-notes";
import { noteSearch } from "../../../../lib/search";
import type { NoteEntry, PaletteCommand } from "../types";

/** Command palette (mobile port of the desktop `CommandPalette`) — a top-anchored
 *  modal opened ONLY from the bottom bar's Search button (the list toolbar's
 *  search is a plain inline filter). Animates in on mount. A COMMANDS section
 *  (substring-filtered over the registry) sits above a NOTES section (backend
 *  MYS1 BM25 search, client fallback in browser-dev), debounced 120ms. */
export function CommandPalette({
  commands,
  notes,
  bodies,
  onOpenNote,
  onClose,
}: {
  commands: PaletteCommand[];
  notes: NoteEntry[];
  bodies: Map<string, string>;
  onOpenNote: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const query = q.trim();
  const needle = query.toLowerCase();
  const cmdMatches = query ? commands.filter((c) => c.label.toLowerCase().includes(needle)) : commands;
  const snippetOf = useMemo(() => new Map(notes.map((n) => [n.id, n.snippet])), [notes]);
  const [noteResults, setNoteResults] = useState<NoteEntry[]>([]);
  useEffect(() => {
    if (query === "") {
      setNoteResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!HAS_TAURI) {
        setNoteResults(searchNotes(q, notes, bodies));
        return;
      }
      void noteSearch(query)
        .then((hits) => {
          if (cancelled) return;
          setNoteResults(hits.map((h) => ({ id: h.note_id, title: h.title || t("editor.untitledNote"), snippet: snippetOf.get(h.note_id) ?? "" })));
        })
        .catch(() => {
          if (!cancelled) setNoteResults(searchNotes(q, notes, bodies));
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q, query, notes, bodies, snippetOf]);

  const sectionLabel: CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-3)", padding: "12px 16px 4px" };
  const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 11, width: "100%", border: "none", background: "transparent", padding: "10px 16px", cursor: "pointer", textAlign: "start", fontFamily: "var(--font-sans)" };
  const first = cmdMatches[0] ?? null;

  // Enter animation: mount closed, flip open before first paint (forced-reflow
  // hook — see `useEnterTransition`) so the transition is guaranteed to run
  // (scrim fades, panel slides down + fades from the top).
  const paletteRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useEnterTransition(paletteRef);
  // Exit animation: reverse the enter, THEN unmount. Every dismiss path routes
  // through this instead of `onClose` directly.
  const closingRef = useRef(false);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setShown(false);
    window.setTimeout(onClose, 240);
  }, [onClose]);

  // Focus the search field on MOUNT (not gated behind the `shown` animation
  // flip) so the focus call stays close to the opening tap — iOS only raises the
  // soft keyboard for a focus that isn't stranded a frame away from the gesture.
  // `autoFocus` on the input is the belt; this effect is the suspenders.
  const paletteInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    paletteInputRef.current?.focus();
  }, []);

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 60, display: "flex", flexDirection: "column", justifyContent: "center" }}>
      {/* The scrim is a touch convenience, not a control (myne#728, task 16):
          Escape is the keyboard way out, and announcing a full-screen button
          called nothing in front of the palette would be worse than
          announcing no button at all. */}
      <div
        role="presentation"
        onClick={requestClose}
        style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.42)", opacity: shown ? 1 : 0, transition: "opacity var(--duration-base) var(--ease-standard)" }}
      />
      <div
        ref={paletteRef}
        style={{
          position: "relative",
          // Vertically centered (was top-anchored). The input sits at the panel
          // top, so it stays above the keyboard even when the results fill out.
          // Phone-identical below 664px; clamps + centers on tablets (SC-01).
          width: "min(640px, calc(100% - 24px))",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          maxHeight: "72%",
          background: "var(--bg-1)",
          border: "1px solid var(--line-2)",
          borderRadius: 16,
          boxShadow: "var(--shadow-3)",
          overflow: "hidden",
          transformOrigin: "top center",
          opacity: shown ? 1 : 0,
          transform: shown ? "translateY(0) scale(1)" : "translateY(-14px) scale(0.98)",
          transition: "transform var(--duration-slow) var(--ease-emphasized), opacity var(--duration-base) var(--ease-standard)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 14px", borderBottom: "1px solid var(--line-1)", flex: "none" }}>
          <Icon name="search" size={18} color="var(--fg-3)" strokeWidth={1.7} />
          <input
            ref={paletteInputRef}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (first) { requestClose(); first.run(); }
                else if (noteResults[0]) { requestClose(); onOpenNote(noteResults[0].id); }
              } else if (e.key === "Escape") requestClose();
            }}
            placeholder={t("editor.commandPalette.searchPlaceholder")}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-sans)", fontSize: 16, color: "var(--fg-1)" }}
          />
        </div>
        <div style={{ overflowY: "auto", minHeight: 0 }}>
          {cmdMatches.length > 0 && (
            <>
              <div style={sectionLabel}>{t("commandPalette.sectionCommands")}</div>
              {cmdMatches.map((c) => (
                <button key={c.id} data-testid="palette.command" data-command-id={c.id} onClick={() => { requestClose(); c.run(); }} style={rowStyle}>
                  <span style={{ flex: "none", display: "flex", color: "var(--fg-2)" }}>{c.icon}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
                  {c.hint && <span style={{ flex: "none", fontSize: 12, color: "var(--fg-3)" }}>{c.hint}</span>}
                </button>
              ))}
            </>
          )}
          {noteResults.length > 0 && (
            <>
              <div style={sectionLabel}>{t("commandPalette.sectionNotes")}</div>
              {noteResults.map((n) => (
                <button key={n.id} onClick={() => { requestClose(); onOpenNote(n.id); }} style={rowStyle}>
                  <span style={{ flex: "none", display: "flex" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinejoin="round" /></svg>
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 15, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</span>
                    {n.snippet && <span style={{ display: "block", fontSize: 12, color: "var(--fg-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.snippet}</span>}
                  </span>
                </button>
              ))}
            </>
          )}
          {query !== "" && cmdMatches.length === 0 && noteResults.length === 0 && (
            <div style={{ padding: "24px 16px", textAlign: "center", fontSize: 14, color: "var(--fg-3)" }}>{t("editor.commandPalette.noMatches")}</div>
          )}
          <div style={{ height: "calc(8px + env(safe-area-inset-bottom, 0px))" }} />
        </div>
      </div>
    </div>
  );
}
