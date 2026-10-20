// The presence roster as a mobile sheet (myne-md/myne#849 task 6).
//
// The mobile sibling of the desktop "Who's here" tab
// (`src/notes/components/WhoIsHereTab.tsx`), not a port of it: that component
// pulls desktop primitives and desktop sidebar state, so what is shared is the
// STORE and the label rule rather than the markup. One row per peer, carrying the
// name the shared rule resolved and the same `--group-*` colour their caret uses,
// with an empty state that names the caller as alone rather than showing an empty
// list.
//
// # Why it takes a note id rather than a peer list
//
// It reads the shared store itself. A caller passing an already-extracted list
// would be a second place the note binding could be got wrong, and the reason the
// store is keyed per note is exactly that two surfaces must not disagree about
// which note's peers they are showing.
//
// # Casing and copy
//
// Title Case for a name in a list, sentence case for the surrounding copy
// (`docs/decisions/ui/0659`). The name here comes from the shared rule, so its
// casing is that rule's; the sheet's own strings are the catalog's.

import { useTranslation } from "react-i18next";
import { identityLabelText } from "@myne/identity-label";
import { colorVarForIndex, type Participant } from "@myne/participant";
import { Sheet } from "../../../../components";
import { useAwarenessPeers } from "../../../../lib/awareness";
import { tappable } from "../../../a11y/tappable";

export function PresenceSheet({
  noteId,
  onJump,
  onClose,
}: {
  /** The note whose peers are listed. The sheet reads the store for this id. */
  noteId: string;
  /** Jump the editor to this peer's last known caret (task 8). */
  onJump: (peer: Participant) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const peers = useAwarenessPeers(noteId);

  return (
    <Sheet
      onClose={onClose}
      style={{ maxHeight: "82%", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      {(close) => (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flex: "none",
              paddingBottom: "var(--space-1)",
            }}
          >
            <span style={{ width: 60 }} />
            <span style={{ fontSize: "var(--text-lg)", fontWeight: "var(--weight-semibold)", color: "var(--fg-1)" }}>
              {t("editor.chrome.presence.title", { count: peers.length })}
            </span>
            {/* A `tappable` rather than a raw button element: `scripts/check-primitive-adoption.mjs`
                lets a NEW file start at zero raw elements, and the shared
                primitive set is desktop's. Same keyboard and screen-reader
                treatment, one line. */}
            <span
              {...tappable({ onActivate: close })}
              // No `label`: the text below IS the name, and `tappable` names a row
              // that has text from that text. The touch floor in both axes.
              style={{
                minWidth: "var(--m-touch)",
                minHeight: "var(--m-touch)",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                color: "var(--accent)",
                fontSize: "var(--text-md)",
                fontWeight: "var(--weight-semibold)",
                cursor: "pointer",
              }}
            >
              {t("editor.sheet.done")}
            </span>
          </div>
          <div style={{ overflowY: "auto", minHeight: 0 }}>
            {peers.length === 0 ? (
              <div
                data-testid="editor.presence-empty"
                style={{ padding: "var(--space-3) var(--space-4)", fontSize: "var(--text-sm)", color: "var(--fg-3)" }}
              >
                {t("editor.chrome.presence.empty")}
              </div>
            ) : (
              <div
                style={{
                  marginTop: "var(--space-2)",
                  border: "1px solid var(--line-1)",
                  borderRadius: "var(--radius-3)",
                  overflow: "hidden",
                  background: "var(--bg-1)",
                }}
              >
                {peers.map((peer, i) => (
                  <PresenceRow
                    key={peer.id}
                    peer={peer}
                    first={i === 0}
                    onActivate={() => {
                      // A peer with no position is a no-op inside the shared
                      // `requestPresenceJump`, so both rosters agree. The sheet still
                      // closes, so the tap is acknowledged rather than swallowed.
                      onJump(peer);
                      close();
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}

function PresenceRow({
  peer,
  first,
  onActivate,
}: {
  peer: Participant;
  first: boolean;
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  // The store holds the label as a DESCRIPTOR, so it is rendered HERE with the
  // translator this render holds. A string frozen into the store would keep the
  // language the peer first appeared in (`identityLabel.ts`).
  const resolved = peer.label === null ? "" : identityLabelText(peer.label, t);
  const name =
    peer.unAttributed || resolved.length === 0
      ? t("editor.chrome.presence.unknown")
      : resolved;
  return (
    <div
      {...tappable({
        onActivate,
        // A deliberate exception to `tappable`'s own "no label when the row has
        // text" rule, and the desktop row makes the same one: what a screen-reader
        // user needs here is what the row DOES. "Alice is editing" names the row's
        // contents and leaves the action unstated.
        label: t("editor.chrome.presence.jumpTo", { name }),
      })}
      data-testid="editor.presence-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-3) var(--space-4)",
        borderTop: first ? undefined : "1px solid var(--line-1)",
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden="true"
        data-testid="editor.presence-dot"
        style={{
          width: 8,
          height: 8,
          borderRadius: "var(--radius-pill)",
          // The SAME source the caret uses: `Participant.color` is the index the
          // store derived from the peer's id, so the dot and the caret cannot
          // disagree about which colour a peer is.
          background: colorVarForIndex(peer.color),
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--fg-1)" }}>
        {name}
      </span>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {t("editor.chrome.presence.editing")}
      </span>
    </div>
  );
}
