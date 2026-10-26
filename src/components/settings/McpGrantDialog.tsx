// The one-time approval screen for an external MCP connection
// (external-mcp-connection, myne-md/myne#923).
//
// # What the screen has to do that a toggle does not
//
// It is the moment a program outside Myne is given a set of the user's folders,
// so it states the SIZE of that set rather than describing the rule ("412 notes in
// 38 folders" is something a person can react to; "the folders you select" is a
// sentence they skim), lets the exclusions be part of the decision rather than a
// follow-up chore, says the set is frozen, and says what Myne does not control.
// Four sentences, and each one is a place the product could otherwise imply a
// guarantee it cannot keep.
//
// # The counts are the host's
//
// `readMcpGrantPreview` asks the same resolver the four read tools clamp with, on
// every change of the exclusion set. Summing a folder list here would be a second
// opinion about scope, and the screen would go on describing a grant the tools do
// not enforce the first time either changed.
//
// # Freezing, and why the exclusions are applied now rather than later
//
// The stored grant is the explicit folder set this preview describes, so the
// moment the user approves, the set stops following the vault: a folder created
// afterwards is outside it and the section's delta row reports it. Excluding a
// folder is the opposite act and is applied ONCE, at approval, subtrees included
// (the host defines that rule in `core/src/plugins/mcp/view.rs`, and it is the
// intuitive meaning of "do not share this folder" rather than the exact-path rule
// the grant itself uses, because a grant that grew by prefix would cover a folder
// nobody was asked about).
//
// # Not a credential
//
// The name is a label. There is no token, no pairing code and no "show once"
// step, because a secret in a client's own config file is readable by any process
// running as the same OS user, which is the same reason the CLI door records that
// it has no identity gatekeeper. The copy says so on the screen rather than only
// in the threat model.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  readMcpGrantPreview,
  type McpGrantPreview,
} from "../../lib/mcp-access";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { ModalShell } from "../primitives/ModalShell";
import { SearchableSelect } from "../primitives/SearchableSelect";
import type { SelectOption } from "../primitives/Select";
import {
  BLOCK_STYLE,
  CONTROL_SLOT_STYLE,
  HELPER_STYLE,
  LABEL_STYLE,
} from "./panel-styles";

/**
 * The names the host already reserves, refused here so the user reads a sentence
 * instead of approving a grant nothing can use.
 *
 * `unnamed-client` is the shim's own fallback (`mcp/src/dispatch.rs`), sent when a
 * client names no connection at all. Approving it would grant every unconfigured
 * client at once, which is the opposite of what this screen is for.
 */
const RESERVED_NAMES: readonly string[] = ["unnamed-client"];

const FIELD_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const COUNTS_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-3)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
};

const COUNT_LINE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
};

const ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

export interface McpGrantConnection {
  /** The declared name, already approved once. */
  name: string;
  /** The folders it holds now, so an extension keeps what it had. */
  folders: string[];
}

export interface McpGrantDialogProps {
  open: boolean;
  /**
   * The connection being approved, or `null` for a new one, whose name the user
   * types. An existing connection's name is shown read-only: renaming is not an
   * operation this screen offers, because the client's config carries the name and
   * a rename would silently stop matching it.
   */
  connection: McpGrantConnection | null;
  /** Every folder that exists now, canonical, the root as `""`. */
  folders: string[];
  /**
   * Approve, with the EXACT folder set to store. Async so the caller can report a
   * refusal; resolving `false` keeps the dialog open with the reason.
   */
  onApprove: (name: string, folders: string[]) => Promise<boolean>;
  onClose: () => void;
}

export function McpGrantDialog({
  open,
  connection,
  folders,
  onApprove,
  onClose,
}: McpGrantDialogProps) {
  const { t } = useTranslation();
  const [nameDraft, setNameDraft] = useState("");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [preview, setPreview] = useState<McpGrantPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog is (re)opened for a connection: a stale exclusion
  // set from the previous connection would be applied to this one's grant.
  useEffect(() => {
    if (!open) return;
    setNameDraft(connection?.name ?? "");
    setExcluded([]);
    setPreview(null);
    setError(null);
    setBusy(false);
  }, [open, connection]);

  // The count is the host's, recomputed on every change of the exclusion set.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    readMcpGrantPreview(excluded)
      .then((next) => {
        if (alive) setPreview(next);
      })
      .catch(() => {
        // A failed read is not "0 notes": the dialog keeps its previous count (or
        // none) rather than claiming the vault is empty, and Approve stays usable
        // because the host resolves the real set at the write either way.
        if (alive) setPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [open, excluded]);

  const name = (connection?.name ?? nameDraft).trim();
  const nameRefused =
    name.length === 0 || RESERVED_NAMES.includes(name);

  // The folder options, with the root named rather than rendered as an empty row.
  const options: SelectOption<string>[] = folders.map((folder) => ({
    value: folder,
    label: folder === "" ? t("settings.ai.externalAccess.rootFolder") : folder,
  }));

  const approve = async () => {
    // The folder set comes back FROM the preview, not from a subtraction done
    // here: the host owns the exclusion rule (a folder takes its subtree with it,
    // the root takes only itself), so the count the user read and the set that is
    // written are the same decision rather than two implementations of it.
    if (preview === null) return;
    setBusy(true);
    setError(null);
    const accepted = await onApprove(name, preview.folders);
    setBusy(false);
    if (!accepted) {
      setError(t("settings.ai.externalAccess.grantRefused"));
    }
  };

  return (
    <ModalShell
      open={open}
      title={
        connection === null
          ? t("settings.ai.externalAccess.dialogTitleNew")
          : t("settings.ai.externalAccess.dialogTitle", { name: connection.name })
      }
      onClose={onClose}
      labelId="mcp-grant-title"
      width={520}
      testId="settings.mcp-grant"
      closeLabel={t("common.close")}
    >
      <div style={BLOCK_STYLE}>
        {connection === null ? (
          <div style={FIELD_ROW_STYLE}>
            <label style={LABEL_STYLE} htmlFor="mcp-grant-name">
              {t("settings.ai.externalAccess.nameLabel")}
            </label>
            <Input
              id="mcp-grant-name"
              mono
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder={t("settings.ai.externalAccess.namePlaceholder")}
              data-testid="settings.mcp-grant-name"
            />
            <p style={HELPER_STYLE}>
              {t("settings.ai.externalAccess.nameHelper")}
            </p>
            {nameDraft.trim().length > 0 && nameRefused && (
              <p style={ERROR_STYLE} data-testid="settings.mcp-grant-name-refused">
                {nameDraft.trim() === "unnamed-client"
                  ? t("settings.ai.externalAccess.nameReserved")
                  : t("settings.ai.externalAccess.nameEmpty")}
              </p>
            )}
          </div>
        ) : (
          <p style={HELPER_STYLE} data-testid="settings.mcp-grant-approved-at">
            {connection.folders.length > 0
              ? t("settings.ai.externalAccess.reextendHelper")
              : t("settings.ai.externalAccess.firstGrantHelper")}
          </p>
        )}

        {/* The counts, from the host, as the exclusion set changes. The
            `data-*` values are counts rather than folder names: a name in an
            attribute lands in every screenshot and CI failure artefact. */}
        <div
          style={COUNTS_STYLE}
          data-testid="settings.mcp-grant-counts"
          data-note-count={String(preview?.noteCount ?? -1)}
          data-folder-count={String(preview?.folderCount ?? -1)}
          data-excluded-count={String(preview?.excludedCount ?? -1)}
        >
          <p style={COUNT_LINE_STYLE} data-testid="settings.mcp-grant-notes">
            {preview === null
              ? t("settings.ai.externalAccess.countsPending")
              : t("settings.ai.externalAccess.countsNotes", {
                  count: preview.noteCount,
                  folders: preview.folderCount,
                })}
          </p>
          <p style={HELPER_STYLE} data-testid="settings.mcp-grant-excluded">
            {t("settings.ai.externalAccess.countsExcluded", {
              count: preview?.excludedCount ?? 0,
            })}
          </p>
        </div>

        <div style={FIELD_ROW_STYLE}>
          <span style={LABEL_STYLE}>
            {t("settings.ai.externalAccess.excludeLabel")}
          </span>
          <div style={CONTROL_SLOT_STYLE}>
            <SearchableSelect
              multiple
              options={options}
              selected={excluded}
              onChange={setExcluded}
              aria-label={t("settings.ai.externalAccess.excludeLabel")}
              placeholder={t("settings.ai.externalAccess.excludePlaceholder")}
              searchPlaceholder={t("settings.ai.externalAccess.excludeSearch")}
              emptyText={t("settings.ai.externalAccess.excludeEmpty")}
              testId="settings.mcp-grant-exclude"
            />
          </div>
          <p style={HELPER_STYLE}>
            {t("settings.ai.externalAccess.excludeHelper")}
          </p>
        </div>

        {/* The two bounds, always visible and never behind a disclosure: a limit
            the reader has to click for is a limit most readers never see. */}
        <p style={HELPER_STYLE} data-testid="settings.mcp-grant-frozen">
          {t("settings.ai.externalAccess.frozenNotice")}
        </p>
        <p style={HELPER_STYLE} data-testid="settings.mcp-grant-outside-myne">
          {t("settings.ai.externalAccess.outsideMyne")}
        </p>

        {error !== null && (
          <p role="alert" style={ERROR_STYLE} data-testid="settings.mcp-grant-error">
            {error}
          </p>
        )}

        <div style={ACTIONS_STYLE}>
          <Button variant="secondary" onClick={onClose} data-testid="settings.mcp-grant-cancel">
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || nameRefused || preview === null}
            onClick={() => void approve()}
            data-testid="settings.mcp-grant-approve"
          >
            {t("settings.ai.externalAccess.approve")}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
