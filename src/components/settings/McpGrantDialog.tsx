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
// # What the approval actually stores, and why the copy is blunt about it
//
// The stored grant is the list of folders to LEAVE OUT, so an approval with an
// empty list shares the whole vault and a folder created afterwards is covered
// without being asked about. That is the opposite of the model this screen first
// shipped with, so the sentence that used to promise a frozen set now says the
// plain truth: you are choosing what to leave out, everything else is shared, and
// leaving a folder out takes everything inside it too (the host defines that rule
// in `core/src/plugins/mcp/view.rs`, so the count the user reads and the bytes
// written are the same decision).
//
// The dialog must never let an empty picker read as "share nothing": that is the
// one misreading this model makes possible, and two lines state it in words at
// the moment the decision is made, `excludeHelper` and `firstGrantHelper` beside
// the picker and `frozenNotice` under the counts.
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
  /**
   * The folders it already leaves out, so a re-approval starts from what is
   * stored rather than from an empty picker that would silently widen the grant
   * to the whole vault on one click.
   */
  excludedFolders: string[];
  /**
   * The folders it may already write in, for the same reason and one consequence
   * worse: a re-approval that started from an empty picker would silently REVOKE
   * every write the connection had, and nobody notices that until a client's write
   * starts landing in the review card instead.
   */
  writeFolders: string[];
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
   * Approve, with the EXACT exclusion set and write allow list to store. Async so
   * the caller can report a refusal; resolving `false` keeps the dialog open with
   * the reason.
   */
  onApprove: (
    name: string,
    excludedFolders: string[],
    writeFolders: string[],
  ) => Promise<boolean>;
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
  const [writable, setWritable] = useState<string[]>([]);
  const [preview, setPreview] = useState<McpGrantPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog is (re)opened for a connection: a stale exclusion
  // set from the previous connection would be applied to this one's grant.
  useEffect(() => {
    if (!open) return;
    setNameDraft(connection?.name ?? "");
    setExcluded(connection?.excludedFolders ?? []);
    setWritable(connection?.writeFolders ?? []);
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

  // The write selection is pruned against the READABLE set the host returns, not
  // against a prefix test here: excluding a folder takes its subtree out of the
  // read scope too, so a write grant underneath it must go with it, and that rule
  // lives in the host. Without this the user could tick a folder for writing and
  // then learn at Approve time that the same screen had just excluded it.
  useEffect(() => {
    if (preview === null) return;
    const readable = preview.folders;
    setWritable((current) => {
      const next = current.filter((folder) => readable.includes(folder));
      return next.length === current.length ? current : next;
    });
  }, [preview]);

  const name = (connection?.name ?? nameDraft).trim();
  const nameRefused =
    name.length === 0 || RESERVED_NAMES.includes(name);

  // The folder options, with the root named rather than rendered as an empty row.
  const options: SelectOption<string>[] = folders.map((folder) => ({
    value: folder,
    label: folder === "" ? t("settings.ai.externalAccess.rootFolder") : folder,
  }));

  // The WRITE candidates are the readable set under the CURRENT exclusion
  // selection, so an excluded folder is never offered and the two pickers cannot
  // disagree about what may be read.
  const writeOptions: SelectOption<string>[] = (preview?.folders ?? []).map(
    (folder) => ({
      value: folder,
      label: folder === "" ? t("settings.ai.externalAccess.rootFolder") : folder,
    }),
  );

  const approve = async () => {
    // The exclusion set comes back FROM the preview, not from the picker: the host
    // owns the rule (a folder takes its subtree with it, the root takes only
    // itself, an entry naming nothing is dropped), so the count the user read and
    // the bytes written are the same decision rather than two implementations.
    if (preview === null) return;
    setBusy(true);
    setError(null);
    // Sent as it stands: the prune above already removed anything this approval
    // took out of the read scope, and the writer refuses a non-subset as the
    // backstop. A second filter here would be a guard no test could distinguish
    // from the prune, which is how a safeguard stops being one.
    const accepted = await onApprove(name, preview.excludedFolders, writable);
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
            {t("settings.ai.externalAccess.reextendHelper")}
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
          {excluded.length === 0 && (
            // The hazard stated AT the control, not only in the counts under it.
            // An empty exclusion list is the one approval that hands over the
            // whole vault, and a person who reads one line under the picker does
            // not necessarily read the sentence under the counts.
            <p style={HELPER_STYLE}>
              {t("settings.ai.externalAccess.firstGrantHelper")}
            </p>
          )}
        </div>

        <div style={FIELD_ROW_STYLE}>
          <span style={LABEL_STYLE}>
            {t("settings.ai.externalAccess.writeLabel")}
          </span>
          <div style={CONTROL_SLOT_STYLE}>
            <SearchableSelect
              multiple
              options={writeOptions}
              selected={writable}
              onChange={setWritable}
              aria-label={t("settings.ai.externalAccess.writeLabel")}
              placeholder={t("settings.ai.externalAccess.writePlaceholder")}
              searchPlaceholder={t("settings.ai.externalAccess.excludeSearch")}
              emptyText={t("settings.ai.externalAccess.excludeEmpty")}
              testId="settings.mcp-grant-write"
            />
          </div>
          <p style={HELPER_STYLE} data-testid="settings.mcp-grant-write-helper">
            {t("settings.ai.externalAccess.writeHelper")}
          </p>
        </div>

        {/* The two bounds, always visible and never behind a disclosure: a rule
            the reader has to click for is a rule most readers never see. The first
            is the one this model makes possible to misread, so it says the plain
            version: what you create later is shared. */}
        <p style={HELPER_STYLE} data-testid="settings.mcp-grant-later-folders">
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
