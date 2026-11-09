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
// The write grant (a later slice) belongs to the connection list but not to this
// task's boundary: the write summary says "nothing" until the host has a write
// scope to report, because a row that implied one it could not enforce would be
// the overstatement the whole feature is written against.
//
// There is also no "add the folders created since you approved this" row any
// more, and its absence is a decision rather than an omission: the grant lists
// the folders to LEAVE OUT, so a folder created afterwards is already covered.
// The row that used to offer to add it would now be offering to add nothing.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../notes/components/relativeTime";
import {
  acceptMcpWriteRequest,
  dismissMcpWriteRequest,
  revokeMcpConnection,
  setMcpConnectionGrant,
} from "../../lib/prefs";
import {
  readMcpExternalAccess,
  type McpConnectionView,
  type McpExternalAccessView,
  type McpWriteRequestView,
} from "../../lib/mcp-access";
import { McpGrantDialog } from "./McpGrantDialog";
import { Button } from "../primitives/Button";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import { BLOCK_STYLE, HELPER_STYLE, LABEL_STYLE } from "./panel-styles";

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
  /**
   * Raised while the approval dialog is up.
   *
   * The Settings shell and `ModalShell` both listen for Esc on `window`, so an
   * ungated shell closes itself and the child dialog on one press. The shell uses
   * this to stand down while the dialog owns the key, the same contract
   * `AiPanel`'s provider consent uses.
   */
  onDialogOpenChange?: (open: boolean) => void;
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
  onDialogOpenChange,
}: McpSectionProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<McpExternalAccessView | null>(null);
  const [failed, setFailed] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  // Which queued request is mid-decision, keyed `connection\u0000folder`. One at a
  // time, because two writes to `vault.prefs` in flight would race the nonce.
  const [deciding, setDeciding] = useState<string | null>(null);
  const [snippetFor, setSnippetFor] = useState<string | null>(null);
  // `null` = closed, `"new"` = declaring a connection, a row = re-approving one.
  const [approving, setApproving] = useState<McpConnectionView | "new" | null>(
    null,
  );

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

  const decide = async (
    request: McpWriteRequestView,
    accept: boolean,
  ) => {
    setDeciding(`${request.connection}\u0000${request.folder}`);
    try {
      if (accept) {
        const widened = await acceptMcpWriteRequest(
          request.connection,
          request.folder,
        );
        // A stale row reports `false`: its grant is gone or the folder has been
        // excluded since, and the host dropped it either way. Saying "now
        // writable" there would be a promise the stored grant does not carry.
        onShowToast?.(
          widened
            ? t("settings.ai.externalAccess.writeRequestAccepted", {
                folder: folderLabel(request.folder, t),
                connection: request.connection,
              })
            : t("settings.ai.externalAccess.writeRequestStale"),
        );
      } else {
        await dismissMcpWriteRequest(request.connection, request.folder);
      }
    } catch {
      onShowToast?.(t("settings.ai.externalAccess.writeRequestFailed"));
    } finally {
      setDeciding(null);
      // The host is the only authority for what the queue now holds.
      reload();
    }
  };

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

  // Keep the shell's Esc gate in step with the dialog, and clear it on unmount:
  // the shell's flag outlives this section, so an unmount with the dialog open
  // would leave Esc gated for the rest of the session.
  useEffect(() => {
    onDialogOpenChange?.(approving !== null);
    return () => onDialogOpenChange?.(false);
  }, [approving, onDialogOpenChange]);

  const approve = async (
    name: string,
    excludedFolders: string[],
    writeFolders: string[],
  ): Promise<boolean> => {
    let accepted = false;
    try {
      accepted = await setMcpConnectionGrant(name, excludedFolders, writeFolders);
    } catch {
      onShowToast?.(t("settings.ai.externalAccess.grantFailed"));
      return false;
    }
    if (!accepted) return false;
    setApproving(null);
    reload();
    return true;
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
              {t("common.tryagain")}
            </Button>
          </div>
        </div>
      )}

      {/* The queue of writes a connection attempted into a folder it may read but
          not write (task 13). Above the connection list on purpose: it is the one
          thing on this surface that is WAITING for the person, and a row below
          three connection cards reads as furniture. Nothing here has been applied,
          and each accept widens one grant by exactly one folder. */}
      {enabled && !failed && view !== null && view.writeRequests.length > 0 && (
        <div
          style={BLOCK_STYLE}
          data-testid="settings.mcp-write-requests"
          data-request-count={String(view.writeRequests.length)}
        >
          <p style={LABEL_STYLE} data-testid="settings.mcp-write-requests-title">
            {t("settings.ai.externalAccess.writeRequestsTitle", {
              count: view.writeRequests.length,
            })}
          </p>
          {view.writeRequests.map((request) => {
            const key = `${request.connection}\u0000${request.folder}`;
            const folder = folderLabel(request.folder, t);
            return (
              <div
                key={key}
                style={ROW_STYLE}
                data-testid="settings.mcp-write-request"
                data-connection={request.connection}
              >
                <p style={HELPER_STYLE}>
                  {request.summary.length > 0
                    ? t("settings.ai.externalAccess.writeRequestLineTyped", {
                        connection: request.connection,
                        verb: verbLabel(request.verb, t),
                        folder,
                        summary: request.summary,
                      })
                    : t("settings.ai.externalAccess.writeRequestLine", {
                        connection: request.connection,
                        verb: verbLabel(request.verb, t),
                        folder,
                      })}
                </p>
                <div style={ACTIONS_STYLE}>
                  <Button
                    variant="primary"
                    onClick={() => void decide(request, true)}
                    disabled={deciding !== null}
                    data-testid="settings.mcp-write-request-accept"
                  >
                    {t("settings.ai.externalAccess.writeRequestAccept", { folder })}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void decide(request, false)}
                    disabled={deciding !== null}
                    data-testid="settings.mcp-write-request-dismiss"
                  >
                    {t("common.dismiss")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Only while the feature is ON. With the toggle off, "no connection is
          approved" is a sentence about a list nobody could have added to, and the
          helper above has already said the door is shut; the owner read it as one
          redundant line too many under an obviously-off switch (myne-md/myne#1020).
          It also used to carry "approving one is what lets a tool read this vault,
          minus the folders you leave out", which is `helperOn`'s own sentence
          restated. */}
      {!failed && enabled && view !== null && view.connections.length === 0 && (
        <p style={HELPER_STYLE} data-testid="settings.mcp-empty">
          {t("settings.ai.externalAccess.empty")}
        </p>
      )}

      {enabled && (
        <div style={ACTIONS_STYLE} data-testid="settings.mcp-add-row">
          <Button
            variant="secondary"
            onClick={() => setApproving("new")}
            data-testid="settings.mcp-add"
          >
            {t("settings.ai.externalAccess.addConnection")}
          </Button>
        </div>
      )}

      <McpGrantDialog
        open={approving !== null}
        connection={
          approving === null || approving === "new"
            ? null
            : {
                name: approving.name,
                // A legacy grant is re-approved from its OWN reach: the seed is
                // (every folder) minus (what it could read), because that is the
                // exclusion list whose reading equals what the stored grant named.
                // Seeding it empty is what made "one click to fix it" turn an
                // approval of `Work/` into an approval of the whole vault, with the
                // preview's note count the only sign.
                excludedFolders: approving.legacy
                  ? legacyExclusionSeed(view?.folders ?? [], approving.legacyFolders)
                  : approving.excludedFolders,
                writeFolders: approving.writeFolders,
              }
        }
        folders={view?.folders ?? []}
        onApprove={approve}
        onClose={() => setApproving(null)}
      />

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
              {/* One entry point to the approval screen per row, and its label is
                  the act: a legacy grant has to be approved again under this
                  model, and a current one is edited. Without this a user who
                  later creates a folder they want left out would have no way to
                  say so except revoking and re-approving by hand. */}
              {row.legacy ? (
                <Button
                  variant="secondary"
                  onClick={() => setApproving(row)}
                  data-testid="settings.mcp-reapprove"
                >
                  {t("settings.ai.externalAccess.approveAgain")}
                </Button>
              ) : (
                <div style={ACTIONS_STYLE}>
                  <Button
                    variant="secondary"
                    onClick={() => setApproving(row)}
                    data-testid="settings.mcp-edit"
                  >
                    {t("settings.ai.externalAccess.editExclusions")}
                  </Button>
                </div>
              )}
              {!row.legacy && row.excludedFolders.length > 0 && (
                <p style={HELPER_STYLE} data-testid="settings.mcp-excluded">
                  {t("settings.ai.externalAccess.excludedLine", {
                    count: row.excludedFolders.length,
                    folders: row.excludedFolders.join(", "),
                  })}
                </p>
              )}
              {/* The write scope, beside the read scope and below it: the order of
                  the two sentences is the order of the decision, and "write
                  nowhere" is stated rather than left to the absence of a line. */}
              <p style={HELPER_STYLE} data-testid="settings.mcp-write-scope">
                {row.legacy || row.writeFolders.length === 0
                  ? t("settings.ai.externalAccess.writeNone")
                  : t("settings.ai.externalAccess.writeSummary", {
                      count: row.writeFolders.length,
                      folders: row.writeFolders.join(", "),
                    })}
              </p>

              <WhenLine row={row} />
              {row.staleExcludedFolders.length > 0 && (
                <p style={HELPER_STYLE} data-testid="settings.mcp-stale">
                  {t("settings.ai.externalAccess.staleExclusion", {
                    count: row.staleExcludedFolders.length,
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

/**
 * "May read 412 notes in 38 folders", or the honest empty form.
 *
 * Under the allow-list model an empty set meant "nothing", so `readNothing` was
 * the only empty case. Now an empty set means the whole vault and the empty case
 * is the opposite one (every folder left out), plus the legacy row, which this
 * build serves as nothing at all. All three say so in words rather than being
 * inferred from a zero.
 */
/**
 * A folder key as a person reads it: the root gets a name, and a key keeps its
 * slashes because that is how the sidebar shows it.
 */
function folderLabel(
  folder: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  return folder === "" ? t("common.vaultroot") : folder;
}

/**
 * The exclusion list a legacy grant is re-approved from.
 *
 * A legacy grant stored the folders it COULD read; this build stores the folders
 * it MAY NOT read. The honest translation is `every folder` minus `what it could
 * read`, and it has to happen here because the stored shape cannot say it: seeding
 * the dialog empty reads as "leave nothing out", which is a one-click approval of
 * the whole vault, and the preview's note count is the only thing that would say
 * so. Subtree-aware in both directions, because an approval that named `Work/` also
 * read `Work/2026/`.
 *
 * A legacy grant naming nothing keeps nothing out on purpose: "read nothing
 * everywhere" has no exclusion-list form, so it re-approves as the whole vault and
 * the preview count is the guard. That grant could not read anything at all, which
 * makes the whole vault a widening the person is shown before they click.
 */
function legacyExclusionSeed(
  allFolders: readonly string[],
  legacyFolders: readonly string[],
): string[] {
  const readable = (folder: string): boolean =>
    legacyFolders.some(
      (allowed) =>
        folder === allowed ||
        (allowed !== "" && folder.startsWith(`${allowed.replace(/\/$/, "")}/`)),
    );
  return allFolders.filter((folder) => !readable(folder));
}

/**
 * A queued request's verb as a sentence fragment.
 *
 * The verb is a wire identifier (`note_create`), and printing it would put a tool
 * name in the middle of a sentence a person is deciding about. An unknown verb
 * falls back to the identifier rather than to a guess: a build that has not learnt
 * a verb yet should say so plainly.
 */
function verbLabel(
  verb: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const known = [
    "note_create",
    "note_append",
    "note_edit",
    "note_move",
    "note_set_field",
  ];
  if (!known.includes(verb)) return verb;
  return t(`settings.ai.externalAccess.verb.${verb}`);
}

function readScopeLabel(
  row: McpConnectionView,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (row.legacy) {
    return t("settings.ai.externalAccess.needsReapproval");
  }
  if (row.folderCount === 0) {
    return t("settings.ai.externalAccess.readNothing");
  }
  if (row.excludedFolders.length === 0) {
    return t("settings.ai.externalAccess.wholeVault");
  }
  return t("settings.ai.externalAccess.readSummary", {
    count: row.noteCount,
    folders: row.folderCount,
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
