// Settings > AI > External access (external-mcp-connection, myne-md/myne#923).
//
// The user-facing half of the `myne-mcp` surface: the master switch, the list of
// approved connections with what each may read, when each was last used, and the
// revoke that takes one away. The one-time approval screen it opens is
// `McpGrantDialog`.
//
// # Placement, and the two gates that put it there
//
// A section inside the AI panel's Limits topic rather than a panel of its own.
// The PRD says so ("in Settings, under AI, in its own section"), and the topic is
// the panel's boundary topic: Limits already holds "what AI can read" and "what a
// chat may cost", and this is the third answer to the same question, asked about a
// different program. Developer mode is the other gate and it is structural rather
// than a condition here: the whole AI panel lives in the rail's `developer` group,
// so the panel cannot be open with the mode off (`CliPanel`'s header records the
// same mechanism). What this file gates is the CAPABILITY: `externalMcp` is absent
// on web and mobile, and an absent capability omits the section rather than
// greying it (`decisions.md` 2026-07-26).
//
// # The copy is the load-bearing part
//
// Three facts have to survive translation, because each one is a place the product
// could imply a guarantee it cannot keep:
//
//   - **Myne does not control what the tool does with what it reads.** The
//     connected program is separately distributed, unaudited from Myne's side, and
//     has its own outbound path; `src-tauri/src/no_egress.rs` binds this WebView
//     and nothing else. This is stated on the section AND again at the approval,
//     because the approval is the moment the decision is made.
//   - **A connection name is a label, not a credential.** A token, a pairing code
//     or a peer check is defeated by construction by any program running as the
//     same OS user, so the section must not read as an authentication mechanism.
//   - **Nothing is inherited.** The grant is device-local; a second computer starts
//     with no approval. That bug would have shipped three times in this tree, so
//     the sentence is unconditional rather than shown only when a second device
//     exists.
//
// # What is deliberately not here
//
// The write grant (a later slice) and the delta row both belong to the connection
// list but not to this task's boundary: the delta row lands with the approval
// screen, and the write summary says "nothing" until the host has a write scope to
// report. A row that implied a write scope it could not enforce would be the
// overstatement the whole feature is written against.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../notes/components/relativeTime";
import { revokeMcpConnection } from "../../lib/prefs";
import {
  readMcpExternalAccess,
  type McpConnectionView,
  type McpExternalAccessView,
} from "../../lib/mcp-access";
import { Button } from "../primitives/Button";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import { BLOCK_STYLE, HELPER_STYLE } from "./panel-styles";

// The snippet is the one value on this surface a user copies by hand into another
// program's config file, so it is mono, selectable and never truncated. Same shape
// `CliAccessSettings` gives its `export PATH=…` line, and for the same reason: the
// app cannot edit the other program's configuration, so this is the whole remedy.
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
  // Wrapping rather than scrolling: the env var is near the end of the line, and
  // the one part the user must get right is the part a horizontal scrollbar
  // hides.
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  userSelect: "all",
};

// One row of the connection list. A hairline rather than a card: the section is
// already the group, and a stack of `--paper-2` cards inside it reads as nested
// furniture (`PRODUCT.md` allows the fill and the hairline, not decoration).
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
  // A declared name is free text: wrap rather than push the revoke button out of
  // the row.
  minWidth: 0,
  overflowWrap: "anywhere",
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flexShrink: 0,
};

export interface McpSectionProps {
  /** `cli_enabled`: the ONE master switch for external access, on both doors. */
  enabled: boolean;
  onSetEnabled: (next: boolean) => void;
  /** Panel toast surface (wired by `AiPanel`; omitted in dev and in stories). */
  onShowToast?: (message: string) => void;
}

/** The config line a client pastes, naming the connection this row approves. */
function mcpSnippet(name: string): string {
  // Written as one literal with the name spliced in, because the shape of a
  // client's config is not ours to paraphrase and the user pastes it verbatim.
  return `{"mcpServers":{"myne":{"command":"myne-mcp","env":{"MYNE_MCP_CONNECTION":${JSON.stringify(name)}}}}}`;
}

export function McpSection({
  enabled,
  onSetEnabled,
  onShowToast,
}: McpSectionProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<McpExternalAccessView | null>(null);
  const [failed, setFailed] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [snippetFor, setSnippetFor] = useState<string | null>(null);

  const reload = useCallback(() => {
    let alive = true;
    readMcpExternalAccess()
      .then((next) => {
        if (!alive) return;
        setView(next);
        setFailed(false);
      })
      .catch(() => {
        // A failed read is NOT rendered as "nothing is approved": those are
        // different facts, and the second one would tell the user their vault is
        // closed to external clients when it may not be.
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => reload(), [reload]);

  const revoke = async (name: string) => {
    setRevoking(name);
    try {
      await revokeMcpConnection(name);
      setSnippetFor((open) => (open === name ? null : open));
    } catch {
      onShowToast?.(t("settings.ai.externalAccess.revokeFailed"));
    } finally {
      setRevoking(null);
      // Re-read whatever happened: on success the row is gone, on failure the row
      // is unchanged, and the host is the only authority for both.
      reload();
    }
  };

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
        explanation={[
          t("settings.ai.externalAccess.explanationShared"),
          t("settings.ai.externalAccess.explanationLabel"),
          t("settings.ai.externalAccess.explanationDevice"),
        ]}
        control={(helperId, explanationId) => (
          <Switch
            checked={enabled}
            onChange={onSetEnabled}
            ariaLabel={t("settings.ai.externalAccess.label")}
            ariaDescribedBy={
              explanationId === undefined
                ? helperId
                : `${helperId} ${explanationId}`
            }
            testId="settings.mcp-enable-toggle"
          />
        )}
      />

      {/* The bound, stated on the section and never behind a disclosure: a limit
          the reader has to click for is a limit most readers never see. */}
      <p style={HELPER_STYLE} data-testid="settings.mcp-outside-myne">
        {t("settings.ai.externalAccess.outsideMyne")}
      </p>

      {failed && (
        <div style={BLOCK_STYLE} data-testid="settings.mcp-failed">
          <p style={HELPER_STYLE}>{t("settings.ai.externalAccess.readFailed")}</p>
          <div style={ACTIONS_STYLE}>
            <Button
              variant="secondary"
              onClick={() => reload()}
              data-testid="settings.mcp-retry"
            >
              {t("settings.ai.externalAccess.retry")}
            </Button>
          </div>
        </div>
      )}

      {!failed && view !== null && view.connections.length === 0 && (
        <p style={HELPER_STYLE} data-testid="settings.mcp-empty">
          {t("settings.ai.externalAccess.empty")}
        </p>
      )}

      {!failed && view !== null && view.connections.length > 0 && (
        <div
          style={BLOCK_STYLE}
          data-testid="settings.mcp-connections"
          // A COUNT, never a name: renderers already put the name on screen, but a
          // `data-*` would also put it in every screenshot and CI failure artefact
          // (src/AGENTS.md "Test observability").
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
                    variant="ghost"
                    aria-expanded={snippetFor === row.name}
                    onClick={() =>
                      setSnippetFor((open) => (open === row.name ? null : row.name))
                    }
                    data-testid="settings.mcp-snippet-toggle"
                  >
                    {t("settings.ai.externalAccess.snippetToggle")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={revoking !== null}
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
                {t("settings.ai.externalAccess.writeNone")}
              </p>
              <WhenLine row={row} />
              {row.missingFolders.length > 0 && (
                <p style={HELPER_STYLE} data-testid="settings.mcp-missing">
                  {t("settings.ai.externalAccess.missing", {
                    count: row.missingFolders.length,
                  })}
                </p>
              )}

              {snippetFor === row.name && (
                <div>
                  <p style={HELPER_STYLE}>
                    {t("settings.ai.externalAccess.snippetHelper")}
                  </p>
                  <code style={CODE_STYLE} data-testid="settings.mcp-snippet">
                    {mcpSnippet(row.name)}
                  </code>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

/** "May read 412 notes in 38 folders", or the honest empty form. */
function readScopeLabel(
  row: McpConnectionView,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (row.readFolders.length === 0) {
    return t("settings.ai.externalAccess.readNothing");
  }
  return t("settings.ai.externalAccess.readSummary", {
    count: row.noteCount,
    folders: row.readFolders.length,
  });
}

/**
 * Both durable facts about a connection, on one line.
 *
 * `lastUsedAt` is the host's stamp from the last call that reached the door, so
 * `null` means "not since it was approved" rather than "never": the approval is
 * itself a fact, and the line states it either way.
 */
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
