// "Who's here" right-panel tab (epic live-collab, `collab-presence-ui` task 4):
// the roster of peers editing the OPEN note, fed from the awareness store.
//
// One row per participant carrying their resolved name and their deterministic
// `--group-*` colour dot. The row is the shared `<Button>` primitive (a real
// `<button>` with the app's one padding/radius/hover/press/focus treatment) carrying
// an accessible name; a click jumps the view to that participant's last known caret
// (no follow mode). An empty state when you are alone. Title Case for a name in the
// list, sentence case for the surrounding copy (decisions/ui/0659).

import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { awarenessNotePeers, getAwarenessSnapshot, subscribeAwareness } from "../collab/awarenessStore";
import { identityLabelText } from "../collab/identityLabel";
import type { Participant } from "../collab/participant";
import { colorVarForIndex } from "../collab/participant";
import { requestPresenceJump } from "../collab/presenceJump";
import { useSelectedNote } from "../sidebarState";
import { SECTION_HEADING_STYLE } from "./sharedStyles";
import { Button } from "../../components/primitives/Button";

export function WhoIsHereTab() {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const awareness = useSyncExternalStore(subscribeAwareness, getAwarenessSnapshot);
  const peers = [...awarenessNotePeers(awareness, ctx.selectedId).values()];

  return (
    <>
      {peers.length > 0 ? (
        <div style={SECTION_HEADING_STYLE}>
          {t("editor.chrome.presence.title", { count: peers.length })}
        </div>
      ) : null}
      {peers.length === 0 ? (
        <div
          data-testid="editor.presence-empty"
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--fg-3)",
            marginTop: "var(--space-1)",
          }}
        >
          {t("editor.chrome.presence.empty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {peers.map((p) => (
            <WhoRow key={p.id} participant={p} onJump={() => requestPresenceJump(ctx.selectedId, p)} />
          ))}
        </div>
      )}
    </>
  );
}

function WhoRow({
  participant,
  onJump,
}: {
  participant: Participant;
  onJump: () => void;
}) {
  const { t } = useTranslation();
  // The store holds the label as a DESCRIPTOR, so it is rendered HERE, with the
  // translator this render holds: a string frozen into the store would keep the
  // language the peer appeared in (`identityLabel.ts`).
  const resolved =
    participant.label === null ? "" : identityLabelText(participant.label, t);
  const name =
    participant.unAttributed || resolved.length === 0
      ? t("editor.chrome.presence.unknown")
      : resolved;
  return (
    <Button
      type="button"
      variant="ghost"
      data-testid="editor.presence-row"
      aria-label={t("editor.chrome.presence.jumpTo", { name })}
      onClick={onJump}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: "var(--space-2)",
        width: "100%",
      }}
    >
      <span
        aria-hidden="true"
        data-testid="editor.presence-dot"
        style={{
          width: 8,
          height: 8,
          borderRadius: "var(--radius-pill)",
          background: colorVarForIndex(participant.color),
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--fg-1)",
        }}
      >
        {name}
      </span>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {t("editor.chrome.presence.editing")}
      </span>
    </Button>
  );
}
