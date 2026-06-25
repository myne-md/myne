// Browser-extension pairing dialog (ext-foundation-handoff task 4, TB10).
//
// FUNCTIONAL, not polished (no `kind: ui`, no Penpot frame). When a browser
// extension requests a connection, the desktop core opens a pending pairing
// session carrying a short numeric challenge; this dialog surfaces it so the
// user compares it against the code the extension shows, then Accept (mint a
// scoped, revocable token bound to the exact extension id) or Reject (clear
// the session — no lingering authorization).
//
// The dialog is intentionally NOT Esc/backdrop-dismissable: declining is the
// explicit "Reject" gesture (a silent dismiss would leave an unresolved
// session). It polls `pairingPending()` so it appears when the host opens a
// session and disappears once Accept/Reject resolves it.
//
// E2E hooks (task 10 authors the scenarios): `pairing.dialog`,
// `pairing.challenge`, `pairing.accept`, `pairing.reject`, `pairing.rejected`.
// Load-bearing copy is asserted by E2E — keep the literals stable.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  pairingAccept,
  pairingDispatchComplete,
  pairingPending,
  pairingReject,
  type PendingPairing,
} from "../lib/clipper-pairing";

/** Poll cadence for a pending session (ms). Cheap read; no event channel yet. */
const POLL_MS = 1000;

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1100,
};

const CARD_STYLE: CSSProperties = {
  width: 420,
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: 10,
  padding: "var(--space-5, 24px)",
  fontFamily: "var(--font-sans)",
  color: "var(--fg-1)",
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const CHALLENGE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 32,
  letterSpacing: "0.25em",
  textAlign: "center",
  padding: "12px 0",
  background: "var(--bg-2)",
  borderRadius: 8,
  userSelect: "all",
};

const BUTTON_ROW_STYLE: CSSProperties = {
  display: "flex",
  gap: 12,
  justifyContent: "flex-end",
};

const BTN_BASE: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 6,
  border: "1px solid var(--line-1)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  cursor: "pointer",
};

// Title + intro copy. These exported constants are the canonical ENGLISH source
// the component test (`tests/components/pairingDialog.test.tsx`) imports and
// asserts against; production renders the i18n keys
// (`clipper.pairing.{title,intro,rejected}`) whose English values are
// byte-identical to these literals, so the English render still matches the
// pinned strings while other locales translate.
/** Title + intro copy (English source; test-asserted). */
export const PAIRING_TITLE = "A browser extension wants to connect";
export const PAIRING_INTRO =
  "Confirm this code matches the one shown in the extension, then Accept to pair.";
export const PAIRING_REJECTED_COPY = "Pairing rejected.";

type DialogState =
  | { phase: "idle" }
  | { phase: "pending"; pending: PendingPairing }
  | { phase: "rejected" }
  | { phase: "working" };

/**
 * Mounts globally (App shell). Renders nothing unless a pairing session is
 * pending (or just rejected, briefly). Self-contained: owns its own polling +
 * Accept/Reject calls.
 */
export function PairingDialog() {
  const { t } = useTranslation();
  const [state, setState] = useState<DialogState>({ phase: "idle" });
  // Avoid clobbering a "rejected"/"working" phase with a poll result.
  const busyRef = useRef(false);

  const poll = useCallback(async () => {
    if (busyRef.current) return;
    try {
      const pending = await pairingPending();
      setState((prev) => {
        // Don't override a transient "rejected" acknowledgement until the
        // host has actually cleared the session (pending === null).
        if (prev.phase === "rejected") {
          return pending ? { phase: "pending", pending } : prev;
        }
        if (pending) return { phase: "pending", pending };
        return { phase: "idle" };
      });
    } catch {
      // A read failure (host not ready, no session) → treat as idle; the
      // next poll retries. Never surfaces a token or extension id.
      setState((prev) => (prev.phase === "rejected" ? prev : { phase: "idle" }));
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(id);
  }, [poll]);

  const onAccept = useCallback(
    async (requestId?: string | null) => {
      // Re-entry guard: a rapid double-click must mint exactly once. The
      // `disabled={working}` prop only blocks clicks AFTER React re-renders, so
      // two synchronous clicks would otherwise both call `pairingAccept`. The
      // ref flips synchronously, so the second call returns before minting.
      if (busyRef.current) return;
      busyRef.current = true;
      setState({ phase: "working" });
      try {
        // Mint the scoped token (desktop-authoritative). When the session was
        // opened by the relay (`requestId` present), deliver the token to the
        // blocked relay thread so it replies `paired` to the extension.
        const token = await pairingAccept();
        if (requestId) {
          await pairingDispatchComplete(requestId, "accepted", token);
        }
        setState({ phase: "idle" });
      } catch {
        // Mint failure (CSPRNG) leaves the session intact — re-poll picks it
        // back up so a retry is non-destructive. The relay times out honestly.
        setState({ phase: "idle" });
      } finally {
        busyRef.current = false;
        void poll();
      }
    },
    [poll],
  );

  const onReject = useCallback(async (requestId?: string | null) => {
    // Re-entry guard (see onAccept): a double-click must reject exactly once.
    if (busyRef.current) return;
    busyRef.current = true;
    setState({ phase: "working" });
    try {
      await pairingReject();
      // Tell the blocked relay the user declined → it replies an honest error
      // to the extension (never a fake pairing). Best-effort if it timed out.
      if (requestId) {
        await pairingDispatchComplete(requestId, "rejected");
      }
    } catch {
      // No pending session to reject — fall through to the rejected ack.
    } finally {
      setState({ phase: "rejected" });
      busyRef.current = false;
    }
  }, []);

  if (state.phase === "idle" || state.phase === "working") {
    // "working" renders nothing extra; the buttons disable in-place below
    // only while a session is on screen, so a bare working phase is blank.
    if (state.phase === "idle") return null;
  }

  // Rejected acknowledgement (brief, dismissable by the user).
  if (state.phase === "rejected") {
    return (
      <div style={BACKDROP_STYLE} data-testid="pairing.dialog" data-phase="rejected">
        <div style={CARD_STYLE} role="dialog" aria-label={t("clipper.pairing.title")}>
          <p data-testid="pairing.rejected" style={{ margin: 0 }}>
            {t("clipper.pairing.rejected")}
          </p>
          <div style={BUTTON_ROW_STYLE}>
            <button
              type="button"
              style={BTN_BASE}
              data-testid="pairing.dismiss"
              onClick={() => setState({ phase: "idle" })}
            >
              {t("clipper.pairing.close")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Pending (or working over a pending session).
  const pending = state.phase === "pending" ? state.pending : undefined;
  if (!pending) return null;
  const working = busyRef.current;

  return (
    <div style={BACKDROP_STYLE} data-testid="pairing.dialog" data-phase="pending">
      <div style={CARD_STYLE} role="dialog" aria-label={t("clipper.pairing.title")}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{t("clipper.pairing.title")}</h2>
        <p style={{ margin: 0, fontSize: 14, color: "var(--fg-2)" }}>
          {t("clipper.pairing.intro")}
        </p>
        <div
          style={CHALLENGE_STYLE}
          data-testid="pairing.challenge"
          aria-label={t("clipper.pairing.codeAriaLabel")}
        >
          {pending.challenge}
        </div>
        <div style={BUTTON_ROW_STYLE}>
          <button
            type="button"
            style={BTN_BASE}
            data-testid="pairing.reject"
            disabled={working}
            onClick={() => void onReject(pending.request_id)}
          >
            {t("clipper.pairing.reject")}
          </button>
          <button
            type="button"
            style={{
              ...BTN_BASE,
              background: "var(--accent, #2563eb)",
              color: "var(--bg-1)",
              borderColor: "transparent",
            }}
            data-testid="pairing.accept"
            disabled={working}
            onClick={() => void onAccept(pending.request_id)}
          >
            {t("clipper.pairing.accept")}
          </button>
        </div>
      </div>
    </div>
  );
}
