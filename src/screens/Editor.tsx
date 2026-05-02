// Terminal post-vault-creation screen — empty shell.
//
// Mounted by App.tsx when stage transitions to "editor" from
// <CreateVault>'s onComplete callback (which fires from <ReadyStep>'s
// "Done" button).
//
// T-shape layout (per design session 2026-04-28-empty-editor-shell.md
// Q2 = A): outer flex column with a row of three panes on top
// (260 left + flex center + 280 right) and a 28 px full-width status
// bar on the bottom.
//
// All copy is intentionally honest: no "Encrypted" / "synced" claims
// (there is no sync server, no per-note encryption pipeline yet);
// the account-number chip is a static MY-XXXX-… placeholder
// (the real account number is owned by <CreateVault>'s reducer and
// not threaded through to App-level — it becomes a vault-unlock
// concern when that feature lands). The "0 words" indicator is
// static; live counters are explicitly out of scope per the PRD.
//
// References:
//   - PRD: agent-tooling/features/empty-editor-shell/prd.md
//   - Design session: agent-tooling/sessions/design/2026-04-28-empty-editor-shell.md
//   - Mockup (structural reference only, NOT copied):
//     docs/design/ui_kits/desktop/Editor.jsx

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FailClosedError } from "../components/FailClosedError";
import { Icon } from "../components/primitives/Icon";
import { isVaultUnlocked, lockVault } from "../lib/vault-unlock";

const SECTION_HEADING_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 600,
};

const STATUS_TEXT_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
};

interface EditorProps {
  /**
   * Callback invoked when the Editor mount guard fires (slot empty
   * despite Stage = `editor`) and the user clicks the "Kilitle" CTA
   * on the resulting `<FailClosedError reason="invalid-state" />`.
   * The parent (App.tsx) is responsible for re-probing
   * `vault_status` and routing to welcome/unlock based on the result.
   * The component itself only fires `vault_lock` (idempotent on
   * already-empty slot) before invoking this callback.
   */
  onResetRequested?: () => void;
  /**
   * Callback invoked when the user clicks the Lock affordance in the
   * editor's bottom bar. The parent (App.tsx) dispatches the
   * `editor.lock` Stage transition → `locked`. This component fires
   * `vault_lock()` IPC (idempotent) before invoking the callback so
   * the slot is wiped before the locked screen renders.
   *
   * **Implicit decrypting-hide invariant:** Lock affordance only
   * mounts when stage = `editor`; `decrypting` is an `unlock` sub-
   * state during which `editor` is not mounted, so the affordance is
   * structurally absent during Argon2id (MYND-35 acceptance "decrypting
   * hide" satisfied without explicit conditional render).
   */
  onLock?: () => void;
}

/**
 * Mount-time reality check (Q5β-1 belt+suspenders): the React Stage
 * machine says we're in `editor`, but the Rust-side slot might
 * actually be empty (devtools manipulation, routing regression,
 * post-lock race). Probe `vault_is_unlocked` once on mount; if the
 * slot is empty, render the fail-closed error UI in place of the
 * editor body.
 */
export function Editor({ onResetRequested, onLock }: EditorProps = {}) {
  const [content, setContent] = useState("");
  const [slotPopulated, setSlotPopulated] = useState<boolean | null>(null);

  const probed = useRef(false);
  useEffect(() => {
    if (probed.current) return; // StrictMode double-invoke guard
    probed.current = true;
    void (async () => {
      try {
        const ok = await isVaultUnlocked();
        setSlotPopulated(ok);
      } catch (e) {
        // IPC error itself is treated as invalid state — fail-closed
        // UI instead of the editor body. Surface to dev console so a
        // genuinely broken IPC channel doesn't masquerade as a
        // slot-empty signal silently.
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[Editor] vault_is_unlocked IPC rejected:", e);
        }
        setSlotPopulated(false);
      }
    })();
  }, []);

  if (slotPopulated === null) {
    // Loading shim — the IPC takes microseconds (single RwLock read);
    // a flash of nothing is invisible at human latency. Returning
    // null avoids any flash of the editor body before the guard
    // result arrives.
    return null;
  }

  if (slotPopulated === false) {
    return (
      <FailClosedError
        reason={{ kind: "invalid-state" }}
        onCtaClick={() => {
          void (async () => {
            // vault_lock is idempotent (Ok(()) on already-empty slot)
            // — safe to call regardless of whether the slot is
            // genuinely empty or the IPC failed.
            await lockVault().catch(() => {
              // Even if lock rejects, we still want to re-probe
              // and route the user out of editor stage.
            });
            onResetRequested?.();
          })();
        }}
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--bg-1)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          flex: 1,
          minHeight: 0,
        }}
      >
        <LeftSidebar />
        <CenterPane content={content} onChange={setContent} />
        <RightSidebar />
      </div>
      <BottomBar onLock={onLock} />
    </div>
  );
}

function LeftSidebar() {
  return (
    <aside
      style={{
        width: 260,
        background: "var(--paper-2)",
        borderRight: "1px solid var(--line-1)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "14px 14px 12px",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--fg-2)",
          }}
        >
          MY-XXXX-XXXX-XXXX-XXXX-X
        </span>
      </div>

      <div
        style={{
          padding: "14px 14px 6px",
          ...SECTION_HEADING_STYLE,
        }}
      >
        Notes
      </div>
      <div
        style={{
          padding: "4px 14px 14px",
          fontSize: 13,
          color: "var(--fg-3)",
        }}
      >
        No notes yet.
      </div>
    </aside>
  );
}

interface CenterPaneProps {
  content: string;
  onChange: (next: string) => void;
}

function CenterPane({ content, onChange }: CenterPaneProps) {
  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          height: 38,
          padding: "0 16px",
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid var(--line-1)",
          fontSize: 12,
          color: "var(--fg-2)",
        }}
      >
        Untitled
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "32px 64px",
        }}
      >
        <div style={{ maxWidth: 680, margin: "0 auto" }}>
          <textarea
            value={content}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Start typing…"
            spellCheck={false}
            style={{
              width: "100%",
              minHeight: 360,
              border: 0,
              outline: 0,
              resize: "none",
              background: "transparent",
              color: "var(--fg-1)",
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              lineHeight: 1.7,
            }}
          />
        </div>
      </div>
    </main>
  );
}

function RightSidebar() {
  return (
    <aside
      style={{
        width: 280,
        background: "var(--paper-2)",
        borderLeft: "1px solid var(--line-1)",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={SECTION_HEADING_STYLE}>Backlinks</div>
      <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Linked from 0</div>
      <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4 }}>
        No backlinks yet.
      </div>
    </aside>
  );
}

interface BottomBarProps {
  onLock?: () => void;
}

function BottomBar({ onLock }: BottomBarProps) {
  const handleLockClick = () => {
    void (async () => {
      // vault_lock is idempotent + param-less. Errors are swallowed —
      // slot wipe is best-effort; the parent's `editor.lock` Stage
      // transition still fires either way (the Locked screen + later
      // unlock attempt would catch any structural issue).
      await lockVault().catch(() => {});
      onLock?.();
    })();
  };

  return (
    <div
      style={{
        height: 28,
        width: "100%",
        background: "var(--paper-2)",
        borderTop: "1px solid var(--line-1)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
      }}
    >
      <span style={STATUS_TEXT_STYLE}>Local-only · not synced</span>
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          onClick={handleLockClick}
          aria-label="Vault'u kilitle"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 8px",
            background: "transparent",
            border: 0,
            borderRadius: "var(--radius-1)",
            color: "var(--fg-3)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          <Icon name="lock" size={12} />
          <span>Kilitle</span>
        </button>
        <span
          style={{
            ...STATUS_TEXT_STYLE,
            fontFamily: "var(--font-mono)",
          }}
        >
          0 words
        </span>
      </div>
    </div>
  );
}
