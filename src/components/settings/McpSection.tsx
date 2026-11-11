// Settings > AI > External access, as its own topic (mcp external access rework,
// myne-md/myne#1052; original section myne-md/myne#923).
//
// # The shape of this surface
//
// Resting state is the connection list plus anything waiting for a decision. Adding
// a connection is a three-step flow that runs in its OWN modal
// area: pick the client, get that client's config path and snippet, then decide
// what it may use. Running it inline rather than in a dialog over Settings is why
// this file has no `onDialogOpenChange`: there is no nested modal left to tell the
// shell about.
//
// # The one thing the accept must never do
//
// Wait on a host read. `mcp_grant_preview` supplies the note count, and a failed
// read used to leave the previous build's Approve button disabled with nothing on
// screen saying why, which reads as "choose folders before I will let you approve".
// The host resolves the exclusion set at the write either way, so the count is the
// friendly extra and the claim is the sentence that renders without it.
//
// # The five claims that survive
//
// One line each, at the decision each belongs to, and none behind a disclosure:
// what a connected tool does with what it reads is outside Myne (the switch); a
// name is a label, not a password (the name field); approvals are on this device
// (the list footer); what is shared grows with the vault (the scope line); writing
// is a named list and every write keeps a restore point (the write disclosure).

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../notes/components/relativeTime";
import {
  acceptMcpReadRequest,
  acceptMcpWriteRequest,
  dismissMcpWriteRequest,
  revokeMcpConnection,
  setMcpConnectionGrant,
} from "../../lib/prefs";
import {
  readMcpExternalAccess,
  readMcpGrantPreview,
  type McpConnectionView,
  type McpExternalAccessView,
  type McpGrantPreview,
  type McpWriteRequestView,
} from "../../lib/mcp-access";
import {
  DEFAULT_CONNECTION_NAME,
  GENERIC_CLIENT,
  MCP_CLIENT_PRESETS,
  mcpSnippet,
  presetById,
  type McpClientPreset,
} from "../../lib/mcp-clients";
import { ClientMark } from "./mcp-client-marks";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { ModalShell } from "../primitives/ModalShell";
import { Icon } from "../primitives/Icon";
import { IconButton } from "../primitives/IconButton";
import { Input } from "../primitives/Input";
import { copyText } from "../../lib/clipboard";
import { writeText as clipboardWriteText } from "../../platform/clipboardManager";
import { MultiSelectBox } from "../primitives/MultiSelectBox";
import { ScrollArea } from "../primitives/ScrollArea";
import type { SelectOption } from "../primitives/Select";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import { BLOCK_STYLE, HELPER_STYLE, LABEL_STYLE } from "./panel-styles";

const CODE_STYLE: CSSProperties = {
  display: "block",
  marginTop: "var(--space-2)",
  padding: "var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  userSelect: "all",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  paddingTop: "var(--space-3)",
  borderTop: "1px solid var(--line-1)",
};

const ROW_HEAD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

const NAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
  minWidth: 0,
  overflowWrap: "anywhere",
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flexShrink: 0,
};

const CARD_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
};

const CARD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-2)",
  minWidth: 0,
  textAlign: "left",
  font: "inherit",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  cursor: "pointer",
  transition: "border-color var(--duration-fast) var(--ease-standard)",
};

/** The steps already behind the user read as done, not merely inactive: accent
 *  metal and a check, so the strip answers "where am I" without reading titles. */
const TIMELINE_STEP_DONE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flex: 1,
  minWidth: 0,
  padding: "var(--space-2) var(--space-2)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: "var(--radius-2)",
};

/** One row per verb, with air between them: nine switched stacked edge to edge read
 *  as one block of chrome. */
const TOOL_LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

const TOOL_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-1) 0",
};

/** The four paragraphs behind the row's question mark: the longer account the
 *  surface's own copy left out on purpose (`myne-md/myne#1052`). */
const EXPLANATION_KEYS = [
  "settings.ai.externalAccess.infoOneDoor",
  "settings.ai.externalAccess.infoNotACredential",
  "settings.ai.externalAccess.infoClientTools",
  "settings.ai.externalAccess.infoBudget",
] as const;

/** The wizard's action row: pinned to the bottom of the scrolling step body, so
 *  Approve is reachable on a short window instead of being scrolled off the
 *  dialog (myne-md/myne#1052). */
const FLOW_ACTIONS_STYLE: CSSProperties = {
  ...ACTIONS_STYLE,
  position: "sticky",
  bottom: 0,
  marginTop: "var(--space-2)",
  paddingTop: "var(--space-2)",
  // The modal card's OWN surface (`--bg-2` in client-core/src/components.css), not
  // a neighbouring rung: one rung off paints the row as a visible band.
  background: "var(--bg-2)",
  borderTop: "1px solid var(--line-1)",
};

/** One slot on the track: the button fills it so a click anywhere on the segment
 *  counts, and the slot itself never shrinks below its share. */
const TIMELINE_SLOT_STYLE: CSSProperties = {
  display: "flex",
  flex: 1,
  minWidth: 0,
};

/** The timeline track: one bar, the active step filled inside it. */
const TIMELINE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: "var(--space-1)",
  padding: "var(--space-1)",
  borderRadius: "var(--radius-2)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  marginBottom: "var(--space-4)",
};

const TIMELINE_STEP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flex: 1,
  minWidth: 0,
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-1)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const TIMELINE_STEP_ACTIVE_STYLE: CSSProperties = {
  ...TIMELINE_STEP_STYLE,
  color: "var(--fg-1)",
  background: "var(--paper)",
  boxShadow: "inset 0 0 0 1px var(--accent)",
};

/** The numbered disc beside a step's label, in the track's own metal. */
const TIMELINE_INDEX_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "var(--space-5)",
  height: "var(--space-5)",
  borderRadius: "var(--radius-pill)",
  border: "1px solid var(--line-1)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  flexShrink: 0,
};

/** One disclosure that holds CONTENT rather than helper copy. */
function Collapsible({
  label,
  detail,
  testId,
  children,
}: {
  label: string;
  detail: string;
  testId: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: "var(--space-3)" }}>
      <Button
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        data-testid={`${testId}-toggle`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          width: "100%",
          justifyContent: "flex-start",
          padding: "var(--space-2) 0",
          fontSize: "var(--text-sm)",
          textAlign: "left",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform var(--duration-fast) var(--ease-standard)",
            color: "var(--fg-3)",
          }}
        >
          <Icon name="chevron-down" size={14} />
        </span>
        <span>{label}</span>
        <span style={{ color: "var(--fg-3)" }}>{detail}</span>
      </Button>
      {open && <div style={{ marginTop: "var(--space-2)" }}>{children}</div>}
    </div>
  );
}

/** One step, and the values the flow is carrying. */
interface FlowState {
  step: 1 | 2 | 3;
  /** `null` at step 1; a preset id once one is chosen. */
  presetId: string | null;
  /** A connection being re-approved, whose name may not be edited. */
  editing: string | null;
  name: string;
  /** The single access list: every folder the connection may touch, read and
   *  write alike. The grant's two fields are derived from it (`derivedGrant`). */
  access: string[];
  disabled: string[];
}

export interface McpSectionProps {
  /** Told when the setup modal opens or closes, so the Settings shell can gate
   *  its own Esc handler on it (`myne-md/myne#1052`). */
  onDialogOpenChange?: (open: boolean) => void;
  /** `cli_enabled`: the ONE master switch for external access, on both doors. */
  enabled: boolean;
  onSetEnabled: (next: boolean) => void;
  /** Panel toast surface (wired by `AiPanel`; omitted in dev and in stories). */
  onShowToast?: (message: string) => void;
}

export function McpSection({
  onDialogOpenChange,
  enabled,
  onSetEnabled,
  onShowToast,
}: McpSectionProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<McpExternalAccessView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [preview, setPreview] = useState<McpGrantPreview | null>(null);


  const reload = useCallback(() => {
    let alive = true;
    readMcpExternalAccess()
      .then((next) => {
        if (!alive) return;
        setView(next);
        setFailed(false);
      })
      .catch(() => {
        // A failed read is NOT "nothing is approved": those are different facts,
        // and the second would tell the person their vault is closed to external
        // clients when it may not be.
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => reload(), [reload]);

  useEffect(() => {
    onDialogOpenChange?.(flow !== null);
    return () => onDialogOpenChange?.(false);
  }, [flow !== null, onDialogOpenChange]);

  // The count the scope step states, recomputed by the host as folders are
  // ticked. Deliberately decorative: a missing count costs the number and never
  // the accept (see the file header).
  // What the one list means to the grant underneath: the selected folders are the
  // write scope, and every folder it does not name is excluded from reads, so one
  // list answers both questions. A folder created later is in neither, which keeps
  // the old rule that a new folder is readable without a second approval.
  const derived = useMemo(() => {
    if (flow === null) return { excluded: [] as string[], write: [] as string[] };
    // The whole vault, from the view: the preview's own `folders` are what the
    // CURRENT exclusion set leaves readable, so deriving from it would be circular.
    const known = view?.folders ?? [];
    const chosen = new Set(flow.access);
    return {
      excluded: known.filter((folder) => !chosen.has(folder) && folder !== ""),
      write: flow.access,
    };
  }, [flow, preview, view]);

  useEffect(() => {
    if (flow === null || flow.step !== 3) return;
    let alive = true;
    readMcpGrantPreview(derived.excluded)
      .then((next) => {
        if (alive) setPreview(next);
      })
      .catch(() => {
        if (alive) setPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [flow?.step, derived.excluded]);

  const pending = view?.writeRequests ?? [];

  const startNew = () =>
    setFlow({
      step: 1,
      presetId: null,
      editing: null,
      name: "",
      access: [],
      disabled: [],
    });

  const startEdit = (row: McpConnectionView) => {
    // The list is the READABLE set: every grant the old dialog approved writes nowhere,
    // so seeding from `write_folders` narrowed a whole-vault grant to the vault root.
    // A verb this build cannot dispatch was never the person's choice, and a grant that
    // may write nowhere keeps its write verbs off rather than gaining them here.
    const readable = row.legacy
      ? row.legacyFolders
      : (view?.folders ?? []).filter(
          (folder) => folder !== "" && !row.excludedFolders.includes(folder),
        );
    const switchedOff = (row.tools ?? [])
      .filter((tool) => tool.availableInBuild && !tool.enabled)
      .map((tool) => tool.verb);
    const mayWrite = !row.legacy && row.writeFolders.length > 0;
    const writeOff = mayWrite
      ? []
      : (row.tools ?? []).filter((tool) => tool.isWrite).map((tool) => tool.verb);
    const disabled = [...new Set([...switchedOff, ...writeOff])];
    setFlow({
      // A connection already approved has its client, its name and its scope, so
      // editing starts at the step that decides something.
      step: 3,
      presetId: null,
      editing: row.name,
      name: row.name,
      access: readable,
      disabled,
    });
  };

  const chooseClient = (preset: McpClientPreset) =>
    setFlow((current) =>
      current === null
        ? current
        : {
            ...current,
            step: 2,
            presetId: preset.id,
            name: preset.id === GENERIC_CLIENT.id ? DEFAULT_CONNECTION_NAME : preset.id,
          },
    );

  const approve = async () => {
    if (flow === null) return;
    const name = flow.name.trim();
    if (name.length === 0) return;
    setBusy(true);
    try {
      const accepted = await setMcpConnectionGrant(
        name,
        derived.excluded,
        derived.write,
        flow.disabled,
      );
      if (!accepted) {
        onShowToast?.(t("settings.ai.externalAccess.grantFailed"));
        return;
      }
      setFlow(null);
      setPreview(null);
      reload();
    } catch {
      onShowToast?.(t("settings.ai.externalAccess.grantFailed"));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (request: McpWriteRequestView, accept: boolean) => {
    setBusy(true);
    try {
      if (accept) {
        const widened =
          request.kind === "read"
            ? await acceptMcpReadRequest(request.connection, request.folder)
            : await acceptMcpWriteRequest(request.connection, request.folder);
        onShowToast?.(
          widened
            ? t("settings.ai.externalAccess.requestAccepted", {
                folder: folderLabel(request.folder, t),
                connection: request.connection,
              })
            : t("settings.ai.externalAccess.requestStale"),
        );
      } else {
        await dismissMcpWriteRequest(request.connection, request.folder, request.kind);
      }
    } catch {
      onShowToast?.(t("settings.ai.externalAccess.requestFailed"));
    } finally {
      setBusy(false);
      reload();
    }
  };

  const revoke = async (name: string) => {
    setBusy(true);
    try {
      await revokeMcpConnection(name);
    } catch {
      onShowToast?.(t("settings.ai.externalAccess.revokeFailed"));
    } finally {
      setBusy(false);
      reload();
    }
  };

  const preset = flow?.presetId === null || flow?.presetId === undefined
    ? null
    : presetById(flow.presetId);

  const scopeLine = useMemo(() => {
    if (preview !== null) {
      return t("settings.ai.externalAccess.scopeLine", {
        count: preview.noteCount,
        folders: preview.folderCount,
      });
    }
    // The claim without the number: it is true whether or not the host answered,
    // and it is the sentence the consent rests on.
    return t("settings.ai.externalAccess.scopeLineWords");
  }, [preview, t]);

  return (
    <SettingsSection
      title={t("settings.ai.sections.externalAccess")}
      testId="settings.mcp-external-access"
    >
      <SettingRow
        anchorId="ai.external-access"
        testId="settings.mcp-enable"
        stateAttrs={{ "data-enabled": String(enabled) }}
        label={t("settings.ai.externalAccess.label")}
        helper={
          enabled
            ? t("settings.ai.externalAccess.helperOn")
            : t("settings.ai.externalAccess.helperOff")
        }
        explanation={EXPLANATION_KEYS.map((key) => t(key))}
        control={(helperId) => (
          <Switch
            checked={enabled}
            onChange={onSetEnabled}
            ariaLabel={t("settings.ai.externalAccess.label")}
            ariaDescribedBy={helperId}
            testId="settings.mcp-enable-toggle"
          />
        )}
      />

      {/* A failed read is NOT an empty vault: this branch exists so the screen never
          tells the user nothing is approved when the truth is that nothing answered. */}
      {failed && (
        <div style={BLOCK_STYLE} data-testid="settings.mcp-failed">
          <p style={HELPER_STYLE}>{t("settings.ai.externalAccess.readFailed")}</p>
          <div style={ACTIONS_STYLE}>
            <Button variant="secondary" onClick={() => reload()} data-testid="settings.mcp-retry">
              {t("settings.ai.externalAccess.retry")}
            </Button>
          </div>
        </div>
      )}

      {enabled && !failed && flow === null && pending.length > 0 && (
        <div
          style={BLOCK_STYLE}
          data-testid="settings.mcp-requests"
          data-request-count={String(pending.length)}
        >
          <p style={LABEL_STYLE} data-testid="settings.mcp-requests-title">
            {t("settings.ai.externalAccess.requestsTitle", { count: pending.length })}
          </p>
          {pending.map((request) => (
            <div
              key={`${request.connection}\u0000${request.folder}\u0000${request.kind}`}
              style={ROW_STYLE}
              data-testid="settings.mcp-request"
              data-kind={request.kind}
            >
              <p style={HELPER_STYLE}>
                {request.kind === "read"
                  ? t("settings.ai.externalAccess.requestLineRead", {
                      connection: request.connection,
                      folder: folderLabel(request.folder, t),
                    })
                  : request.summary.length > 0
                    ? t("settings.ai.externalAccess.requestLineWriteTyped", {
                        connection: request.connection,
                        folder: folderLabel(request.folder, t),
                        summary: request.summary,
                      })
                    : t("settings.ai.externalAccess.requestLineWrite", {
                        connection: request.connection,
                        folder: folderLabel(request.folder, t),
                      })}
              </p>
              <div style={ACTIONS_STYLE}>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void decide(request, true)}
                  data-testid="settings.mcp-request-accept"
                >
                  {t("settings.ai.externalAccess.requestAccept")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void decide(request, false)}
                  data-testid="settings.mcp-request-dismiss"
                >
                  {t("settings.ai.externalAccess.requestDismiss")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {enabled && !failed && flow === null && view !== null && view.connections.length === 0 && (
        <div data-testid="settings.mcp-empty">
          <EmptyState
            variant="firstRun"
            icon="share-2"
            size="sm"
            frame={false}
            title={t("settings.ai.externalAccess.empty")}
            body={t("settings.ai.externalAccess.emptyBody")}
            action={
              <Button variant="primary" onClick={startNew} data-testid="settings.mcp-add">
                {t("settings.ai.externalAccess.addConnection")}
              </Button>
            }
          />
        </div>
      )}

      {/* ── the three steps, in their own modal ─────────────────────────── */}
      {enabled && flow !== null && (
        <ModalShell
          open
          title={t("settings.ai.externalAccess.addConnection")}
          onClose={() => setFlow(null)}
          labelId="settings-mcp-flow-title"
          width={640}
          testId="settings.mcp-flow-modal"
        >
        <div
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
          data-testid="settings.mcp-flow"
          data-step={String(flow.step)}
        >
          <div style={TIMELINE_STYLE} data-testid="settings.mcp-step-strip" role="list">
            {[1, 2, 3].map((step) => {
              const done = step < flow.step;
              const current = step === flow.step;
              return (
                <span key={step} role="listitem" style={TIMELINE_SLOT_STYLE}>
                  <Button
                    variant="ghost"
                    aria-current={current ? "step" : undefined}
                    data-done={done ? "true" : undefined}
                    // Backwards only: a step is walkable once it was walked through.
                    disabled={!done}
                    onClick={() =>
                      setFlow((existing) =>
                        existing === null ? existing : { ...existing, step: step as 1 | 2 | 3 },
                      )
                    }
                    style={
                      current
                        ? TIMELINE_STEP_ACTIVE_STYLE
                        : done
                          ? TIMELINE_STEP_DONE_STYLE
                          : TIMELINE_STEP_STYLE
                    }
                    data-testid={`settings.mcp-step-${step}`}
                  >
                    <span
                      style={{
                        ...TIMELINE_INDEX_STYLE,
                        ...(current
                          ? { border: "1px solid var(--accent)", color: "var(--fg-1)" }
                          : done
                            ? {
                                border: "1px solid var(--accent)",
                                background: "var(--accent)",
                                color: "var(--accent-on)",
                              }
                            : {}),
                      }}
                    >
                      {done ? <Icon name="circle-check" size={14} /> : String(step)}
                    </span>
                    <span
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {t(`settings.ai.externalAccess.step${step}Title`)}
                    </span>
                  </Button>
                </span>
              );
            })}
          </div>

          <ScrollArea
            style={{ maxHeight: "56vh" }}
            // The action row is sticky to this scroller's bottom edge, so a
            // focused switch must stop above it (2.4.11).
            contentStyle={{ scrollPaddingBottom: "var(--space-7)" }}
          >
          {flow.step === 1 && (
            <div data-testid="settings.mcp-step-clients">
              <p style={LABEL_STYLE}>{t("settings.ai.externalAccess.step1Question")}</p>
              <div style={CARD_GRID_STYLE} role="radiogroup">
                {MCP_CLIENT_PRESETS.map((client) => (
                  <Button
                    key={client.id}
                    variant="secondary"
                    role="radio"
                    aria-checked={false}
                    style={CARD_STYLE}
                    onClick={() => chooseClient(client)}
                    data-testid="settings.mcp-client"
                    data-client={client.id}
                  >
                    <ClientMark mark={client.mark} name={client.name} />
                    <span>{client.name}</span>
                  </Button>
                ))}
              </div>
              <p
                style={{ ...HELPER_STYLE, marginTop: "var(--space-2)" }}
                data-testid="settings.mcp-trademarks"
              >
                {t("settings.ai.externalAccess.trademarks")}
              </p>
              <Collapsible
                label={GENERIC_CLIENT.name}
                detail={t("settings.ai.externalAccess.otherClientsDetail")}
                testId="settings.mcp-other-clients"
              >
                <p style={HELPER_STYLE}>{t("settings.ai.externalAccess.otherClientsHelper")}</p>
                <code style={CODE_STYLE} data-testid="settings.mcp-generic-command">
                  {mcpSnippet(GENERIC_CLIENT, DEFAULT_CONNECTION_NAME)}
                </code>
              </Collapsible>
              <div style={FLOW_ACTIONS_STYLE}>
                <Button
                  variant="secondary"
                  onClick={() => setFlow(null)}
                  data-testid="settings.mcp-flow-cancel"
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          )}

          {flow.step === 2 && preset !== null && (
            <div data-testid="settings.mcp-step-config">
              <p style={LABEL_STYLE} data-testid="settings.mcp-config-path">
                {t("settings.ai.externalAccess.configPath", { path: preset.configPath })}
              </p>
              <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-2)" }}>
                <code style={{ ...CODE_STYLE, flex: 1 }} data-testid="settings.mcp-snippet">
                  {mcpSnippet(preset, flow.name.trim() || DEFAULT_CONNECTION_NAME)}
                </code>
                <CopyButton text={mcpSnippet(preset, flow.name.trim() || DEFAULT_CONNECTION_NAME)} />
              </div>
              <p style={HELPER_STYLE} data-testid="settings.mcp-name-claim">
                {t("settings.ai.externalAccess.nameClaim")}
              </p>
              <div style={{ marginTop: "var(--space-2)" }}>
                <label style={LABEL_STYLE} htmlFor="mcp-connection-name">
                  {t("settings.ai.externalAccess.nameLabel")}
                </label>
                <Input
                  id="mcp-connection-name"
                  mono
                  value={flow.name}
                  onChange={(event) =>
                    setFlow((current) =>
                      current === null ? current : { ...current, name: event.target.value },
                    )
                  }
                  data-testid="settings.mcp-connection-name"
                />
              </div>
              {preset.clientSideToolList && (
                <p style={HELPER_STYLE} data-testid="settings.mcp-client-tools-note">
                  {t("settings.ai.externalAccess.clientToolsNote", { name: preset.name })}
                </p>
              )}
              <div style={FLOW_ACTIONS_STYLE}>
                <Button
                  variant="secondary"
                  onClick={() =>
                    setFlow((current) => (current === null ? current : { ...current, step: 1 }))
                  }
                  data-testid="settings.mcp-flow-back"
                >
                  {t("settings.ai.externalAccess.back")}
                </Button>
                <Button
                  variant="primary"
                  disabled={flow.name.trim().length === 0}
                  onClick={() =>
                    setFlow((current) => (current === null ? current : { ...current, step: 3 }))
                  }
                  data-testid="settings.mcp-flow-next"
                >
                  {t("settings.ai.externalAccess.next")}
                </Button>
              </div>
            </div>
          )}

          {flow.step === 3 && (
            <div data-testid="settings.mcp-step-scope">
              <p style={HELPER_STYLE} data-testid="settings.mcp-scope-line">
                {scopeLine}
              </p>

              <MultiSelectBox
                collapsible
                options={folderOptions(view?.folders ?? [], t)}
                selected={flow.access}
                onChange={(next) =>
                  setFlow((current) => (current === null ? current : { ...current, access: next }))
                }
                label={t("settings.ai.externalAccess.accessLabel")}
                emptySummary={t("settings.ai.externalAccess.accessNothing")}
                searchPlaceholder={t("settings.ai.externalAccess.findFolder")}
                emptyText={t("settings.ai.externalAccess.noFolderMatches")}
                maxListHeight={240}
                testId="settings.mcp-access-picker"
              />

              <div style={{ marginTop: "var(--space-3)" }}>
                <p style={LABEL_STYLE}>{t("settings.ai.externalAccess.toolsLabel")}</p>
                <div
                  style={TOOL_LIST_STYLE}
                  data-testid="settings.mcp-tools"
                  data-tool-count={String(toolRoster(view, flow).length)}
                >
                  {toolRoster(view, flow).map((tool) => (
                    <div
                      key={tool.verb}
                      style={TOOL_ROW_STYLE}
                      data-testid="settings.mcp-tool"
                      data-verb={tool.verb}
                    >
                      <span style={{ ...HELPER_STYLE, margin: 0 }}>
                        {verbLabel(tool.verb, t)}
                        {!tool.availableInBuild && (
                          <span style={{ color: "var(--fg-3)" }}>
                            {` · ${t("settings.ai.externalAccess.toolUnavailable")}`}
                          </span>
                        )}
                      </span>
                      <Switch
                        checked={tool.enabled}
                        disabled={!tool.availableInBuild || busy}
                        onChange={(next) =>
                          setFlow((current) => {
                            if (current === null) return current;
                            const disabled = next
                              ? current.disabled.filter((verb) => verb !== tool.verb)
                              : [...current.disabled, tool.verb];
                            return { ...current, disabled };
                          })
                        }
                        ariaLabel={verbLabel(tool.verb, t)}
                        testId={`settings.mcp-tool-${tool.verb}`}
                      />
                    </div>
                  ))}
                </div>
                <p style={HELPER_STYLE} data-testid="settings.mcp-tools-note">
                  {t("settings.ai.externalAccess.toolsNote", {
                    count: view?.readBudget?.notesPerWindow ?? 0,
                    minutes: Math.round((view?.readBudget?.windowSeconds ?? 0) / 60),
                  })}
                </p>
              </div>

              <div style={FLOW_ACTIONS_STYLE}>
                <Button
                  variant="secondary"
                  onClick={() =>
                    setFlow((current) =>
                      current === null ? current : { ...current, step: current.editing === null ? 2 : 3 },
                    )
                  }
                  data-testid="settings.mcp-flow-back"
                >
                  {t("settings.ai.externalAccess.back")}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || flow.name.trim().length === 0}
                  onClick={() => void approve()}
                  data-testid="settings.mcp-approve"
                >
                  {t("settings.ai.externalAccess.approve")}
                </Button>
              </div>
            </div>
          )}
          </ScrollArea>
        </div>
        </ModalShell>
      )}

      {enabled && !failed && flow === null && view !== null && view.connections.length > 0 && (
        <div
          style={BLOCK_STYLE}
          data-testid="settings.mcp-connections"
          data-connection-count={String(view.connections.length)}
        >
          {view.connections.map((row, index) => (
            <div
              key={row.name}
              style={ROW_STYLE}
              data-testid="settings.mcp-connection"
              data-connection-index={String(index)}
            >
              <div style={ROW_HEAD_STYLE}>
                <span style={NAME_STYLE}>{row.name}</span>
                <div style={ACTIONS_STYLE}>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void revoke(row.name)}
                    data-testid="settings.mcp-revoke"
                  >
                    {t("settings.ai.externalAccess.revoke")}
                  </Button>
                </div>
              </div>
              <p style={HELPER_STYLE} data-testid="settings.mcp-read-scope">
                {readScopeLabel(row, t)}
              </p>
              <p style={HELPER_STYLE} data-testid="settings.mcp-write-scope">
                {row.legacy || row.writeFolders.length === 0
                  ? t("settings.ai.externalAccess.writeNone")
                  : t("settings.ai.externalAccess.writeSummary", {
                      count: row.writeFolders.length,
                      folders: row.writeFolders.join(", "),
                    })}
              </p>
              <p style={HELPER_STYLE} data-testid="settings.mcp-tools-scope">
                {toolsLine(row, t)}
              </p>
              <WhenLine row={row} />
              <div style={ACTIONS_STYLE}>
                <Button
                  variant="secondary"
                  onClick={() => startEdit(row)}
                  data-testid="settings.mcp-edit"
                >
                  {row.legacy
                    ? t("settings.ai.externalAccess.approveAgain")
                    : t("settings.ai.externalAccess.editExclusions")}
                </Button>
              </div>
            </div>
          ))}
          <p style={HELPER_STYLE} data-testid="settings.mcp-device-claim">
            {t("settings.ai.externalAccess.deviceClaim")}
          </p>
          {/* The primary lives in the zero state, so a second connection needs its
              own way back in: without this the list would be the last word for
              anyone who ever approved one. */}
          <div style={{ marginTop: "var(--space-2)" }}>
            <Button
              variant="secondary"
              onClick={startNew}
              data-testid="settings.mcp-add"
            >
              {t("settings.ai.externalAccess.addConnection")}
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

/** The snippet's copy control: feedback lands on the control, not in a toast. */
function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (!confirmed) return;
    const timer = window.setTimeout(() => setConfirmed(false), 1500);
    return () => window.clearTimeout(timer);
  }, [confirmed]);
  return (
    <IconButton
      icon="copy"
      label={t("settings.ai.externalAccess.copySnippet")}
      confirmed={confirmed}
      onClick={() => {
        // The copy confirms itself: a tick on the control, and the shared helper
        // announces it. No toast for a success.
        void copyText(clipboardWriteText, text, {
          // Silent on both sides: the tick on the control IS the feedback
          // (`agent-tooling` copy rule), so nothing is announced twice.
          onSuccess: { kind: "silent", reason: "the control shows a tick" },
          onFailure: { kind: "silent", reason: "a failed copy leaves the control un-ticked" },
        }).then((ok) => {
          if (ok) setConfirmed(true);
        });
      }}
      testId="settings.mcp-copy"
    />
  );
}

/** The switch bank for a connection being edited, or the catalog for a new one. */
function toolRoster(
  view: McpExternalAccessView | null,
  flow: FlowState,
): { verb: string; enabled: boolean; availableInBuild: boolean }[] {
  const stored = view?.connections.find((row) => row.name === flow.editing)?.tools ?? [];
  if (stored.length > 0) {
    return stored.map((tool) => ({
      verb: tool.verb,
      // The switch bank reflects the flow's own edits, not the stored state.
      enabled: tool.availableInBuild && !flow.disabled.includes(tool.verb),
      availableInBuild: tool.availableInBuild,
    }));
  }
  // A connection that is not approved yet has no stored row, so the switches come
  // from the host's own catalog: a first-run vault has no connection to borrow one
  // from, and an empty switch bank on the first approval screen is the failure this
  // field exists to remove.
  const catalog = view?.toolCatalog ?? [];
  return catalog.map((tool) => ({
    verb: tool.verb,
    enabled: tool.availableInBuild && !flow.disabled.includes(tool.verb),
    availableInBuild: tool.availableInBuild,
  }));
}

function folderOptions(
  folders: readonly string[],
  t: (key: string, options?: Record<string, unknown>) => string,
): SelectOption<string>[] {
  return folders.map((folder) => ({
    value: folder,
    label: folder === "" ? t("settings.ai.externalAccess.rootFolder") : folder,
  }));
}

function folderLabel(
  folder: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return folder === "" ? t("settings.ai.externalAccess.rootFolder") : folder;
}

function verbLabel(
  verb: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const known = [
    "note_search",
    "note_read",
    "vault_list",
    "vault_state",
    "note_create",
    "note_append",
    "note_set_field",
    "note_move",
    "note_edit",
  ];
  if (!known.includes(verb)) return verb;
  return t(`settings.ai.externalAccess.verb.${verb}`);
}

function readScopeLabel(
  row: McpConnectionView,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (row.legacy) return t("settings.ai.externalAccess.needsReapproval");
  if (row.folderCount === 0) return t("settings.ai.externalAccess.readNothing");
  if (row.excludedFolders.length === 0) return t("settings.ai.externalAccess.wholeVault");
  return t("settings.ai.externalAccess.readSummary", {
    count: row.noteCount,
    folders: row.folderCount,
  });
}

function toolsLine(
  row: McpConnectionView,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const off = (row.tools ?? []).filter((tool) => tool.availableInBuild && !tool.enabled);
  if (off.length === 0) return t("settings.ai.externalAccess.toolsAll");
  return t("settings.ai.externalAccess.toolsOff", {
    count: off.length,
    verbs: off.map((tool) => verbLabel(tool.verb, t)).join(", "),
  });
}

function WhenLine({ row }: { row: McpConnectionView }) {
  const { t } = useTranslation();
  const approved = formatRelativeTime(new Date(row.approvedAt * 1000));
  const used = row.lastUsedAt === null ? null : formatRelativeTime(new Date(row.lastUsedAt * 1000));
  return (
    <p style={HELPER_STYLE} data-testid="settings.mcp-when">
      {used === null
        ? t("settings.ai.externalAccess.whenLineNever", { approved })
        : t("settings.ai.externalAccess.whenLine", { approved, used })}
    </p>
  );
}
