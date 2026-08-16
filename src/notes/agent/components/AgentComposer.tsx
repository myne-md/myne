// Starting an agent run (myne-md/myne#529, task 7).
//
// The entry point is chat, with the open note as the default scope. That was the
// chosen shape, and it has a consequence worth stating where the code lives:
// folder-scale work then ordinarily reaches its scope through a MODEL-originated
// expansion, which is the injection-reachable path, and nothing caps how many of
// those one run may make.
//
// **The scope attachment below is the mitigation for exactly that, not
// decoration.** A user who already knows the work spans a folder attaches it
// here, before sending, and the grant is theirs rather than something the model
// asked for. Removing this control does not make the feature smaller; it routes
// every folder-scale run through the riskier of the two mechanisms.
//
// The note count is shown before sending for the same reason the approval dialog
// shows it: "Projects" is not a size, and a user who has not been told it is 400
// notes has not been told what they are granting.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../../components/primitives/Button";
import { Input } from "../../../components/primitives/Input";
import {
  agentPreviewGrant,
  agentStart,
  type GrantPreview,
  type ScopeGrant,
} from "../../../lib/agent-run";
import { beginRun, failRun, settleStep } from "../agentStore";
import { UndoLastRun } from "./UndoLastRun";

export interface AgentComposerProps {
  /** The open note, used as the default scope when nothing is attached. */
  openNoteId: string | null;
  /** Folders the user can attach. */
  folders: readonly string[];
  /** Called when a run needs the review screen. */
  onRunSettled: () => void;
  /** Called after an undo reverted notes on disk, with their ids. */
  onRunUndone?: (noteIds: readonly string[]) => void;
}

export function AgentComposer({
  openNoteId,
  folders,
  onRunSettled,
  onRunUndone,
}: AgentComposerProps) {
  const { t } = useTranslation();
  const [task, setTask] = useState("");
  const [attached, setAttached] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<GrantPreview | null>(null);

  // The count comes from the HOST, resolved by the same code the commit runs.
  // Counting here would leave out the `ai_excluded_folders` clamp, so the number
  // shown before sending would be larger than the scope the user actually gets.
  useEffect(() => {
    if (attached === null) {
      setPreview(null);
      return;
    }
    let live = true;
    void agentPreviewGrant({ kind: "folder", value: attached })
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch(() => {
        if (live) setPreview(null);
      });
    return () => {
      live = false;
    };
  }, [attached]);

  const grant: ScopeGrant | null = attached
    ? { kind: "folder", value: attached }
    : openNoteId
      ? { kind: "notes", value: [openNoteId] }
      : null;

  async function send() {
    if (!grant || task.trim() === "" || busy) return;
    setBusy(true);
    beginRun();
    try {
      settleStep(await agentStart(task, grant));
      onRunSettled();
    } catch {
      failRun(t("agent.composer.startFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="agentComposer.root"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        padding: "var(--space-3)",
        borderTop: "1px solid var(--line-1)",
      }}
    >
      {/* The previous run's undo, offered here rather than only on the review
          screen: this is the surface that is still on screen after that screen
          has been closed. Renders nothing when the host holds no record. */}
      <UndoLastRun onReverted={onRunUndone} />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={{ color: "var(--fg-2)" }}>{t("agent.composer.scopeLabel")}</span>
        {/* The user-originated scope control. */}
        <select
          data-testid="agentComposer.attachScope"
          value={attached ?? ""}
          onChange={(e) => setAttached(e.target.value === "" ? null : e.target.value)}
          style={{
            background: "var(--bg-1)",
            color: "var(--fg-1)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-1)",
            padding: "var(--space-1) var(--space-2)",
          }}
        >
          <option value="">{t("agent.composer.scopeOpenNote")}</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        {/* The size, before sending. */}
        {attached && preview !== null ? (
          <>
            <span data-testid="agentComposer.scopeCount" style={{ color: "var(--fg-2)" }}>
              {t("agent.composer.scopeCount", { count: preview.noteCount })}
            </span>
            {preview.excludedCount > 0 ? (
              <span
                data-testid="agentComposer.scopeExcluded"
                style={{ color: "var(--fg-2)" }}
              >
                {t("agent.scope.excluded", { count: preview.excludedCount })}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Input
          data-testid="agentComposer.task"
          value={task}
          placeholder={t("agent.composer.placeholder")}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          style={{ flex: 1 }}
        />
        <Button
          variant="primary"
          disabled={busy || !grant || task.trim() === ""}
          onClick={() => void send()}
          data-testid="agentComposer.send"
        >
          {t("agent.composer.send")}
        </Button>
      </div>
    </div>
  );
}
