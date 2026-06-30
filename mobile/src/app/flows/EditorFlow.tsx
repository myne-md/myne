import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { Screen, ScreenScroll, Icon, MyneMark, Banner, Spinner, Sheet } from "../../components";
import { noteList, noteRead, noteCreate, noteUpdate, noteDelete } from "../../lib/notes";
import type { NoteListError } from "../../lib/notes";
import { listVaults, orderByLastUnlock } from "../../lib/vault-list";
import { HAS_TAURI } from "../../lib/app-window";
import { ioBanner } from "../../lib/io-banner";
import type { VaultSummary } from "../../types/vault-summary";
import type { EditorFlowProps } from "./types";
import { SettingsSheet, applyStoredTheme } from "./SettingsSheet";

/**
 * Editor flow — the wired main surface after unlock. Mirrors the static
 * `notes/05·06` list + `notes/07` reading + `workspace/08` editor +
 * `workspace/11 · Settings` screens, but driven by the real `notes` plugin.
 *
 * View machine: `list` ⇄ `editor`. Mount → `noteList()` then `noteRead()` per
 * id to derive a (title, snippet) for each row. `+` opens a blank editor;
 * tapping a row opens it on that note's plaintext (plain <textarea>, the mobile
 * port of the desktop B4.5 stub — no CodeMirror). Save → `noteCreate` /
 * `noteUpdate`; delete → `noteDelete`. The gear (Settings tab) opens the
 * <SettingsSheet>; the "Personal ▾" bar opens a vault switcher.
 *
 * Note plaintext is held in component-local state for the controlled textarea
 * and wiped on every exit path + on unmount (best-effort; the load-bearing
 * zeroize is Rust-side per `src-tauri/CLAUDE.md`).
 */

interface NoteEntry {
  id: string;
  title: string;
  snippet: string;
}

type Editing = { id: string | null };

const DEV_SEED: string[] = [
  "# Threat model v2\n\nWe assume a powerful network adversary that can observe all traffic and compromise the relay. The vault key never leaves the device.",
  "# Weekly review — 2026-06-15\n\nShipped the sync conflict resolver. Next: mobile share sheet and editor polish.",
  "# Reading — Seeing Like a State\n\nLegibility as the central drive of the modern state. Chapter 1 notes.",
];

/** First non-empty line → title; next non-empty line → snippet (md marks stripped). */
function deriveTitleSnippet(text: string): { title: string; snippet: string } {
  const lines = text.split("\n");
  let title = "";
  let titleIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(/^#{1,6}\s*/, "").trim();
    if (t) {
      title = t;
      titleIdx = i;
      break;
    }
  }
  let snippet = "";
  for (let i = titleIdx + 1; i < lines.length; i++) {
    const s = lines[i].replace(/^#{1,6}\s*/, "").trim();
    if (s) {
      snippet = s;
      break;
    }
  }
  return { title, snippet };
}

function entryFrom(id: string, text: string): NoteEntry {
  const { title, snippet } = deriveTitleSnippet(text);
  return { id, title: title || "Untitled note", snippet };
}

export function EditorFlow({ vaultId, onLock, onCreateVault, onSwitchVault, onDeleteVaultSuccess }: EditorFlowProps) {
  const [view, setView] = useState<"list" | "editor">("list");
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [editorText, setEditorText] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [vaults, setVaults] = useState<VaultSummary[]>([]);

  // In-memory note store for browser-dev (no Tauri host). The real backend
  // owns persistence under `pnpm tauri dev`; this keeps `pnpm dev` demoable.
  const devStoreRef = useRef<Map<string, string> | null>(null);
  const devStore = useCallback((): Map<string, string> => {
    if (devStoreRef.current === null) {
      const m = new Map<string, string>();
      if (!HAS_TAURI) DEV_SEED.forEach((t) => m.set(crypto.randomUUID(), t));
      devStoreRef.current = m;
    }
    return devStoreRef.current;
  }, []);

  const loadEntries = useCallback(async (): Promise<NoteEntry[]> => {
    if (HAS_TAURI) {
      const ids = await noteList();
      const texts = await Promise.all(ids.map((id) => noteRead(id).catch(() => "")));
      return ids.map((id, i) => entryFrom(id, texts[i]));
    }
    return [...devStore().entries()].map(([id, text]) => entryFrom(id, text));
  }, [devStore]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      setNotes(await loadEntries());
    } catch (raw) {
      const e = raw as NoteListError;
      setListError(e.kind === "Io" ? ioBanner(e.detail.io_error_kind) : "Couldn't load your notes.");
    } finally {
      setLoading(false);
    }
  }, [loadEntries]);

  // Boot: apply the persisted theme, then load the list.
  useEffect(() => {
    applyStoredTheme();
    void refresh();
  }, [refresh]);

  // Best-effort plaintext wipe on unmount.
  useEffect(() => {
    return () => setEditorText("");
  }, []);

  // Lazy-load the switcher's vault list when it opens.
  useEffect(() => {
    if (!switcherOpen) return;
    let cancelled = false;
    void (async () => {
      if (HAS_TAURI) {
        const res = await listVaults();
        if (cancelled) return;
        setVaults("ok" in res ? orderByLastUnlock(res.ok) : []);
      } else {
        setVaults([
          { id: vaultId ?? "dev-personal", status: { kind: "Exists" }, label: "Personal", last_unlock: Date.now() },
          { id: "dev-work", status: { kind: "Exists" }, label: "Work", last_unlock: Date.now() - 86_400_000 },
        ]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [switcherOpen, vaultId]);

  // ── Editor transitions ─────────────────────────────────────────────────────
  const exitEditor = useCallback(() => {
    setEditorText("");
    setEditing(null);
    setEditorBusy(false);
    setEditorError(null);
    setDeleteConfirm(false);
    setView("list");
  }, []);

  const newNote = useCallback(() => {
    setEditorText("");
    setEditing({ id: null });
    setEditorError(null);
    setView("editor");
  }, []);

  const openNote = useCallback(
    async (id: string) => {
      setEditorError(null);
      let text = "";
      try {
        text = HAS_TAURI ? await noteRead(id) : devStore().get(id) ?? "";
      } catch {
        setEditorError("Couldn't open this note.");
      }
      setEditorText(text);
      setEditing({ id });
      setView("editor");
    },
    [devStore],
  );

  async function saveNote() {
    if (!editing) return;
    // Discard a brand-new empty note rather than persisting an empty blob.
    if (editing.id === null && editorText.trim() === "") {
      exitEditor();
      return;
    }
    setEditorBusy(true);
    setEditorError(null);
    try {
      if (editing.id === null) {
        if (HAS_TAURI) await noteCreate(editorText);
        else devStore().set(crypto.randomUUID(), editorText);
      } else if (HAS_TAURI) {
        await noteUpdate(editing.id, editorText);
      } else {
        devStore().set(editing.id, editorText);
      }
      await refresh();
      exitEditor();
    } catch {
      setEditorError("Couldn't save this note.");
      setEditorBusy(false);
    }
  }

  async function confirmDeleteNote() {
    if (!editing || editing.id === null) {
      exitEditor();
      return;
    }
    setEditorBusy(true);
    setEditorError(null);
    try {
      if (HAS_TAURI) await noteDelete(editing.id);
      else devStore().delete(editing.id);
      await refresh();
      exitEditor();
    } catch {
      setEditorError("Couldn't delete this note.");
      setEditorBusy(false);
      setDeleteConfirm(false);
    }
  }

  // ── List view ───────────────────────────────────────────────────────────────
  if (view === "list") {
    const count = notes.length;
    return (
      <Screen>
        <div style={{ flex: "none", padding: "60px 20px 0" }}>
          <VaultBar onSwitcher={() => setSwitcherOpen(true)} onNew={newNote} />
          <h1 style={{ margin: "14px 0 0", fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>
            Notes
          </h1>
          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--success)" }} />
            <span style={{ fontSize: 13, color: "var(--fg-3)" }}>
              Encrypted on this device · {count} {count === 1 ? "note" : "notes"}
            </span>
          </div>
        </div>

        {listError && (
          <div style={{ padding: "12px 20px 0" }}>
            <Banner kind="danger">{listError}</Banner>
          </div>
        )}

        {loading ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Spinner />
          </div>
        ) : count === 0 && !listError ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 40px", textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--fg-1)" }}>No notes yet</div>
            <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)" }}>
              Tap the + to write your first note. Everything is encrypted on this device before it is stored.
            </div>
          </div>
        ) : (
          <ScreenScroll style={{ marginTop: 14 }}>
            {notes.map((n, i) => (
              <NoteRow key={n.id} entry={n} last={i === notes.length - 1} onOpen={() => void openNote(n.id)} />
            ))}
          </ScreenScroll>
        )}

        <TabBar onSettings={() => setSettingsOpen(true)} />

        {switcherOpen && (
          <VaultSwitcher
            vaults={vaults}
            activeId={vaultId}
            onSelect={(id) => {
              setSwitcherOpen(false);
              if (id !== vaultId) onSwitchVault(id);
            }}
            onCreate={() => {
              setSwitcherOpen(false);
              onCreateVault();
            }}
            onClose={() => setSwitcherOpen(false)}
          />
        )}

        {settingsOpen && (
          <SettingsSheet
            vaultId={vaultId}
            onClose={() => setSettingsOpen(false)}
            onLock={onLock}
            onDeleteVaultSuccess={onDeleteVaultSuccess}
          />
        )}
      </Screen>
    );
  }

  // ── Editor view ─────────────────────────────────────────────────────────────
  const headerTitle = deriveTitleSnippet(editorText).title || (editing?.id ? "Untitled" : "New note");
  const isExisting = editing?.id != null;

  return (
    <Screen>
      <div
        style={{
          flex: "none",
          padding: "56px 16px 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <button
          onClick={exitEditor}
          style={{ border: "none", background: "transparent", color: "var(--fg-3)", fontSize: 15, fontWeight: 500, cursor: "pointer", flex: "none", width: 64, textAlign: "left" }}
        >
          Cancel
        </button>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "center",
            fontSize: 15,
            fontWeight: 600,
            color: "var(--fg-1)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {headerTitle}
        </div>
        <button
          onClick={() => void saveNote()}
          disabled={editorBusy}
          style={{
            border: "none",
            background: "transparent",
            color: "var(--accent)",
            fontSize: 15,
            fontWeight: 600,
            cursor: editorBusy ? "default" : "pointer",
            opacity: editorBusy ? 0.6 : 1,
            flex: "none",
            width: 64,
            textAlign: "right",
          }}
        >
          Done
        </button>
      </div>

      {editorError && (
        <div style={{ padding: "12px 16px 0" }}>
          <Banner kind="danger">{editorError}</Banner>
        </div>
      )}

      <textarea
        value={editorText}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setEditorText(e.target.value)}
        placeholder="# Start writing…"
        autoFocus
        spellCheck
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
          border: "none",
          outline: "none",
          resize: "none",
          background: "var(--bg-1)",
          color: "var(--fg-1)",
          fontFamily: "var(--font-mono)",
          fontSize: 15,
          lineHeight: 1.75,
          padding: "18px 22px",
          boxSizing: "border-box",
        }}
      />

      {isExisting && (
        <div style={{ flex: "none", padding: "12px 20px 34px", borderTop: "1px solid var(--line-1)", display: "flex", justifyContent: "center" }}>
          <button
            onClick={() => setDeleteConfirm(true)}
            disabled={editorBusy}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              border: "none",
              background: "transparent",
              color: "var(--danger)",
              fontSize: 15,
              fontWeight: 600,
              cursor: editorBusy ? "default" : "pointer",
              opacity: editorBusy ? 0.6 : 1,
            }}
          >
            <Icon name="trash" size={18} color="var(--danger)" strokeWidth={1.8} />
            Delete note
          </button>
        </div>
      )}

      {deleteConfirm && (
        <Sheet>
          <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)", textAlign: "center" }}>Delete this note?</div>
          <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.5, color: "var(--fg-3)", textAlign: "center" }}>
            This permanently removes the note from this device. This cannot be undone.
          </div>
          <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
            <button
              onClick={() => void confirmDeleteNote()}
              disabled={editorBusy}
              style={{
                width: "100%",
                height: 50,
                border: "none",
                borderRadius: 8,
                background: "var(--danger)",
                color: "#fff",
                fontFamily: "var(--font-sans)",
                fontSize: 16,
                fontWeight: 600,
                cursor: editorBusy ? "default" : "pointer",
                opacity: editorBusy ? 0.7 : 1,
              }}
            >
              {editorBusy ? "Deleting…" : "Delete note"}
            </button>
            <button
              onClick={() => setDeleteConfirm(false)}
              style={{
                width: "100%",
                height: 50,
                border: "1px solid var(--line-2)",
                borderRadius: 8,
                background: "transparent",
                color: "var(--fg-1)",
                fontFamily: "var(--font-sans)",
                fontSize: 16,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </Sheet>
      )}
    </Screen>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

/** "Personal ▾" + search/compose top bar (mirror notes/05 VaultBar, wired). */
function VaultBar({ onSwitcher, onNew }: { onSwitcher: () => void; onNew: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <button
        onClick={onSwitcher}
        style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "transparent", padding: 0, cursor: "pointer" }}
      >
        <MyneMark size={22} radius={4} />
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>Personal</span>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M2 4l4 4 4-4" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div style={{ display: "flex", gap: 6 }}>
        <div style={{ width: 38, height: 38, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="search" size={20} color="var(--fg-2)" strokeWidth={1.7} />
        </div>
        <button
          onClick={onNew}
          aria-label="New note"
          style={{ width: 38, height: 38, borderRadius: 8, border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
        >
          <Icon name="plus" size={20} color="var(--accent)" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

/** A chronological note row (mirror notes/05 ChronoRow geometry). */
function NoteRow({ entry, last, onOpen }: { entry: NoteEntry; last: boolean; onOpen: () => void }) {
  return (
    <div
      onClick={onOpen}
      style={{
        padding: "14px 20px",
        borderTop: "1px solid var(--line-1)",
        borderBottom: last ? "1px solid var(--line-1)" : undefined,
        cursor: "pointer",
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-1)" }}>{entry.title}</div>
      {entry.snippet && (
        <div
          style={{
            marginTop: 3,
            fontSize: 14,
            color: "var(--fg-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.snippet}
        </div>
      )}
    </div>
  );
}

/** Bottom tab bar (Notes active / Settings opens the sheet). Mirror notes TabBar. */
function TabBar({ onSettings }: { onSettings: () => void }) {
  const inactive = "var(--fg-3)";
  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        padding: "8px 0 30px",
      }}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="5" y="3" width="14" height="18" rx="2.5" stroke="var(--accent)" strokeWidth="1.8" />
          <path d="M9 8h6M9 12h6M9 16h3" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--accent)" }}>Notes</span>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="7" stroke={inactive} strokeWidth="1.8" />
          <path d="M16 16l4 4" stroke={inactive} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 500, color: inactive }}>Search</span>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="6" cy="17" r="2.6" stroke={inactive} strokeWidth="1.8" />
          <circle cx="18" cy="14" r="2.6" stroke={inactive} strokeWidth="1.8" />
          <circle cx="13" cy="6" r="2.6" stroke={inactive} strokeWidth="1.8" />
          <path d="M8.3 15.6l3-7M8.4 16.2l7-1.6" stroke={inactive} strokeWidth="1.6" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 500, color: inactive }}>Graph</span>
      </div>
      <button
        onClick={onSettings}
        aria-label="Settings"
        style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, border: "none", background: "transparent", cursor: "pointer", padding: 0 }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M4 7h11M19 7h1M4 17h1M9 17h11" stroke={inactive} strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="17" cy="7" r="2.4" stroke={inactive} strokeWidth="1.8" />
          <circle cx="7" cy="17" r="2.4" stroke={inactive} strokeWidth="1.8" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 500, color: inactive }}>Settings</span>
      </button>
    </div>
  );
}

/** Vault switcher sheet (the "Personal ▾" chevron's target). */
function VaultSwitcher({
  vaults,
  activeId,
  onSelect,
  onCreate,
  onClose,
}: {
  vaults: VaultSummary[];
  activeId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 2px 12px" }}>
        <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>Vaults</div>
        <button
          onClick={onClose}
          style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 0 }}
        >
          Done
        </button>
      </div>
      <div style={{ border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
        {vaults.map((v, i) => {
          const active = v.id === activeId;
          return (
            <div
              key={v.id}
              onClick={() => onSelect(v.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "13px 14px",
                borderTop: i === 0 ? undefined : "1px solid var(--line-1)",
                cursor: "pointer",
              }}
            >
              <MyneMark size={22} radius={4} />
              <span style={{ flex: 1, fontSize: 16, color: "var(--fg-1)" }}>{v.label ?? "Vault"}</span>
              {active && <Icon name="check" size={18} color="var(--accent)" strokeWidth={2} />}
            </div>
          );
        })}
      </div>
      <button
        onClick={onCreate}
        style={{
          marginTop: 12,
          width: "100%",
          height: 48,
          border: "1px solid var(--line-2)",
          borderRadius: 10,
          background: "transparent",
          color: "var(--accent)",
          fontFamily: "var(--font-sans)",
          fontSize: 15,
          fontWeight: 600,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <Icon name="plus" size={18} color="var(--accent)" strokeWidth={2} />
        Create new vault
      </button>
    </Sheet>
  );
}
