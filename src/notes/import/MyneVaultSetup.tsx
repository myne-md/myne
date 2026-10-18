// Setup step for the Myne vault import source (myne-md/myne#464).
//
// Three things the other sources' setup step does not need, because they pick a
// path and this one picks a VAULT:
//
//  - a list of the user's OTHER local vaults, from `vault_list`, with the
//    currently-unlocked one and any unreadable one excluded;
//  - a credential for the chosen vault, master password or 24-word recovery
//    phrase, because a source vault is locked;
//  - an import label, which is the suffix a renamed note gets and the reason a
//    repeat run is idempotent. Its cost is stated where it is entered rather
//    than discovered later.
//
// Every value binds to a design token. No hardcoded colour, radius, spacing or
// font size appears below, which is what `check-token-adoption.mjs` ratchets on
// and what lets a custom theme reach this screen at all.
//
// # This module is SUBSTITUTED on web, for the capability and not for the phrase
//
// `vaultImport` is absent there, so `availableSourceOrder()` already omits the
// card and this component is unreachable; `web/vite.config.ts` carries the entry
// and `web/src/notes/import/MyneVaultSetup.tsx` is the stub. The phrase field
// below used to be a second reason. The artefact grep
// (`scripts/check-web-no-phrase.mjs`) read this grid's absence out of `web/dist`,
// and device enrolment had already shown that a runtime gate leaves a grid in the
// bundle, one devtools breakpoint away. That grep is deleted (`decisions.md`
// 2026-10-18, entry 0704), so the substitution now rests on the absent capability
// alone.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Input } from "../../components/primitives/Input";
import { Select } from "../../components/primitives/Select";
import { PasswordInput } from "../../components/PasswordInput";
import { isLegalImportLabel } from "./conflict";
import { listVaults } from "../../lib/vault-list";
import type { VaultSummary } from "../../types/vault-summary";
import { BODY_STYLE, FOOTER_STYLE } from "./modalChrome";
import { IMPORT_SOURCES } from "./sourceCatalog";

/** Which credential the user is presenting. */
type CredentialKind = "password" | "phrase";

/** 24 words, per `protocol.md` §3.1. */
const PHRASE_CELL_COUNT = 24;

/** The `<Select>` value that means "nothing chosen yet". */
const NO_VAULT = "";

export interface MyneVaultSetupProps {
  /** The vault being imported INTO. Excluded from the list. */
  readonly activeVaultId: string | null;
  /**
   * The picked `.myne-backup` file (myne-md/myne#816). When set, the step shows
   * that file instead of the local-vault list, and `onReady` carries
   * `backupPath` rather than `sourceVaultId`.
   */
  readonly backupPath?: string | undefined;
  /**
   * True for the Myne source (myne-md/myne#816): the step picks a
   * `.myne-backup` file rather than a local vault, and the local-vault list is
   * not shown. Set by the modal from the chosen source id.
   */
  readonly backupMode?: boolean | undefined;
  /** Open the OS picker for the backup file (only meaningful in backup mode). */
  readonly onChooseFile?: (() => void) | undefined;
  /**
   * Called with the user's choices. This component does NOT open the source
   * slot; the caller does, inside the same try/finally that closes it.
   *
   * Splitting the two WAS the bug. Opening here left an Argon2id-long window in
   * which this subtree could be unmounted by Esc or a backdrop click, after
   * which the derivation still landed, a second vault's keys sat resident until
   * the TTL swept them, and the import ran behind a closed modal.
   */
  readonly onReady: (args: {
    /**
     * Exactly one of `sourceVaultId` (a local vault) or `backupPath` (an
     * extracted `.myne-backup`) is set. The Myne import source is a backup file
     * now (myne-md/myne#816); the local-vault branch is kept reachable for the
     * substituted web stub and any future re-introduction.
     */
    sourceVaultId?: string;
    backupPath?: string;
    importLabel: string;
    credential: { password: string } | { recoveryPhrase: string };
  }) => void;
  readonly onCancel: () => void;
  /**
   * Back to the source picker. Absent when a caller named the source, since
   * there is nothing to go back to.
   *
   * Distinct from `onCancel`, and the distinction is the finding: this step used
   * to offer one button, labelled Back, that closed the whole modal. A user who
   * picked the wrong card had no way to pick another without starting over.
   */
  readonly onBack?: (() => void) | undefined;
  /**
   * A retryable message from a rejected `importSourceOpen`, rendered above the
   * fields.
   *
   * A wrong password used to drop the whole flow into the terminal error phase,
   * which cost the user the vault choice and the label to fix one character,
   * and whose copy says "Any notes already imported were kept", false here,
   * since the open failed and the run never started.
   */
  readonly error?: string | null;
  /**
   * The non-secret cells to come back to after a retryable failure.
   *
   * A wrong source password is the likeliest failure of this flow, and the
   * retryable arm sets `phase` back to `setup`, which mounts a FRESH instance:
   * every cell reset, including the 24 recovery words. The comment justifying
   * that arm lists re-choosing the vault and re-typing the label as the outcome
   * it avoids, and the user got exactly that plus a banner.
   *
   * Only the non-secret cells come back. The password and the phrase stay local
   * and die with the unmount on purpose: carrying them up would keep a source
   * vault's credential in a parent that outlives the setup step, and for a
   * mistyped password the secret is the one thing the user has to retype
   * anyway.
   */
  readonly initialChosen?: string | undefined;
  readonly initialLabel?: string | undefined;
  readonly initialKind?: CredentialKind | undefined;
}

const FIELD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const FIELD_LABEL: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const BANNER: CSSProperties = {
  padding: "var(--space-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  background: "var(--paper-2)",
  color: "var(--fg-1)",
  fontSize: "var(--text-sm)",
};

const ERROR_BANNER: CSSProperties = {
  padding: "var(--space-2)",
  border: "1px solid var(--danger)",
  borderRadius: "var(--radius-2)",
  background: "var(--danger-soft)",
  color: "var(--fg-1)",
  fontSize: "var(--text-sm)",
  margin: 0,
};

const HINT: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  lineHeight: 1.5,
};

const DISCLOSURE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-3)",
  borderRadius: "var(--radius-1)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
};

const DISCLOSURE_LABEL: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-1)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
};

const DISCLOSURE_TEXT: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-2)",
  lineHeight: 1.5,
};

const PHRASE_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: "var(--space-2)",
};

const CELL_WRAP: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
};

const CELL_NUMBER: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  width: "1.4em",
  textAlign: "end",
  fontFamily: "var(--font-mono)",
};

const CELL_INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "var(--space-1) var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  outline: "none",
};

/**
 * The name to show for a vault whose label this session has never decrypted.
 *
 * A vault's label lives ENCRYPTED inside its `vault.prefs`, so a vault this
 * session has never unlocked has no name to show. The fallback is a position,
 * not an identifier: showing the `VaultId` would put an opaque UUID in front of
 * the user and would also put a per-vault correlation tag on screen.
 */
function vaultName(
  v: VaultSummary,
  index: number,
  t: (k: string, v?: Record<string, unknown>) => string,
): string {
  return v.label ?? t("notes.import.myne.unnamedVault", { n: index + 1 });
}

/**
 * The 24-cell phrase grid, held to `recovery-flow.md` §3.2.
 *
 * Its own copy rather than `EnrollPhraseCredential`, and that is now duplication
 * rather than a requirement. The reason it existed was that this module's
 * `data-testid` was one of the needles `check-web-no-phrase.mjs` grepped
 * `web/dist` for, so reusing the shared primitive would have made two surfaces
 * indistinguishable in the artefact and broken a guard whose whole assertion was
 * one string. That guard is deleted (`decisions.md` 2026-10-18, entry 0704), so
 * nothing stops these two grids from becoming one.
 *
 * The §3.2 properties it inherits, each of which is a privacy rule rather than a
 * style choice: no per-cell validation, no typeahead over the BIP-39 wordlist,
 * paste-to-distribute from cell one, and browser autocomplete/spellcheck off.
 * Any positive or negative per-cell feedback leaks one bit of wordlist
 * membership per word to anyone looking at the screen.
 */
function PhraseGrid({
  cells,
  onCells,
}: {
  cells: readonly string[];
  onCells: (next: string[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const setCell = (i: number, value: string): void => {
    const next = [...cells];
    next[i] = value;
    onCells(next);
  };
  const onPaste = (i: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    // §3.2 paste-to-distribute: a phrase kept as one string in a password
    // manager is the common case, and asking the user to split it by hand is
    // 24 chances to put a word in the wrong cell.
    const tokens = e.clipboardData.getData("text").trim().split(/\s+/);
    if (tokens.length < 2) return;
    e.preventDefault();
    const next = [...cells];
    for (let k = 0; k < tokens.length && i + k < PHRASE_CELL_COUNT; k += 1) {
      next[i + k] = tokens[k];
    }
    onCells(next);
  };
  return (
    <div style={PHRASE_GRID} data-testid="import-myne.phrase-grid">
      {Array.from({ length: PHRASE_CELL_COUNT }, (_, i) => (
        <label key={i} htmlFor={`import-myne-word-${i}`} style={CELL_WRAP}>
          <span style={CELL_NUMBER}>{i + 1}</span>
          <Input
            id={`import-myne-word-${i}`}
            type="text"
            value={cells[i] ?? ""}
            onChange={(e) => setCell(i, e.target.value)}
            onPaste={onPaste(i)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="text"
            style={CELL_INPUT}
            aria-label={t("notes.import.myne.wordAria", { number: i + 1 })}
            data-testid="import-myne.phrase-cell"
            data-index={i + 1}
          />
        </label>
      ))}
    </div>
  );
}

export function MyneVaultSetup({
  activeVaultId,
  backupPath,
  backupMode = false,
  onChooseFile,
  onReady,
  onCancel,
  onBack,
  error = null,
  initialChosen,
  initialLabel,
  initialKind,
}: MyneVaultSetupProps): ReactElement {
  const { t } = useTranslation();
  // A backup source needs no vault listing: the file IS the source. Seed the
  // list empty and skip the probe so the loading/empty gates below do not fire.
  const [vaults, setVaults] = useState<VaultSummary[] | null>(
    backupMode ? [] : null,
  );
  const [chosen, setChosen] = useState<string>(initialChosen ?? NO_VAULT);
  const [kind, setKind] = useState<CredentialKind>(initialKind ?? "password");
  // Secret cells start EMPTY on every mount, including a retry. See
  // `initialChosen` on the props for why they are not carried back.
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [cells, setCells] = useState<string[]>(() =>
    Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
  );
  const [label, setLabel] = useState(initialLabel ?? "");

  useEffect(() => {
    if (backupMode) return;
    let live = true;
    void listVaults().then((res) => {
      if (!live) return;
      // A read failure yields an empty list rather than an error screen: the
      // honest thing to tell the user is "no other vaults here", and the
      // difference between none and unreadable is not one they can act on from
      // an import dialog.
      const all = "ok" in res ? res.ok : [];
      // The vault being imported INTO cannot be its own source: importing a
      // vault into itself would rename every note against its own titles. A
      // `Corrupted` vault is excluded too, because there is nothing to read.
      //
      // A NULL `activeVaultId` excludes EVERYTHING rather than nothing, and
      // that inversion is the finding. `activeVaultId()`'s own docstring
      // forbids treating an unresolved active vault as "use whichever one looks
      // most recent", and the same reasoning applies here one step earlier: an
      // unknown active vault means we cannot prove any candidate is not it, and
      // offering a list that might contain the open vault is how a vault gets
      // imported into itself. The list resolves a moment later when the probe
      // lands, and the empty state below already explains itself.
      setVaults(
        activeVaultId === null
          ? []
          : all.filter(
              (v) => v.id !== activeVaultId && v.status.kind === "Exists",
            ),
      );
    });
    return () => {
      live = false;
    };
  }, [activeVaultId]);

  // A choice that is no longer in the list stops being the choice. The list is
  // re-filtered whenever `activeVaultId` resolves, so without this a selection
  // made during the unresolved window survives into a list that excludes it,
  // and Continue submits a vault id the user can no longer see.
  useEffect(() => {
    if (vaults === null || chosen === NO_VAULT) return;
    if (!vaults.some((v) => v.id === chosen)) setChosen(NO_VAULT);
  }, [vaults, chosen]);

  // Prefill the label from the chosen vault's own name. The user can change it,
  // and the hint below says what changing it costs.
  useEffect(() => {
    if (chosen === NO_VAULT || vaults === null) return;
    const i = vaults.findIndex((v) => v.id === chosen);
    if (i !== -1) setLabel(vaultName(vaults[i], i, t));
  }, [chosen, vaults, t]);

  const options = useMemo(
    () => [
      { value: NO_VAULT, label: t("notes.import.myne.vaultPlaceholder") },
      ...(vaults ?? []).map((v, i) => ({ value: v.id, label: vaultName(v, i, t) })),
    ],
    [vaults, t],
  );

  // The 24 cells are cleared on `pagehide`, matching
  // `vault-recover/PhraseEntryStep.tsx`.
  //
  // The reason travels with the surface rather than with the screen, which is
  // what `recovery-flow.md` §3.2 as amended by this change now says: a browser
  // restores form state on back-navigation and session restore, from storage
  // this client neither owns nor can reach, and `autoComplete="off"` on each
  // cell is only the first half. `pagehide` is the event that fires on bfcache
  // entry as well as unload, which is why it is the one used.
  //
  // Best-effort, and stated as such, exactly as §3.5 requires: nothing here can
  // guarantee the browser has not already snapshotted the field. It is here on
  // the desktop client too, and that is not redundancy for its own sake: the
  // module is a WebView surface, the recovery screen's own copy carries the
  // same clear for the same reason, and a per-client exemption is how one of
  // the two surfaces silently loses it.
  useEffect(() => {
    const clear = () =>
      setCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);

  // The label is validated HERE, at the input, because this is the only place
  // a person can still fix it.
  //
  // It is spliced into a note's `title:` AND into the target of every
  // retargeted wikilink, so it inherits the dialect's title-segment rule. A `/`
  // turns `[[Beta (2024/archive)]]` into a path-form link whose final segment
  // is `archive)`, and a `]]` closes the wikilink early and leaves the rest as
  // literal text in every linking note. `renamedTitleFor` refuses an illegal
  // label too, but its refusal is a silent no-op rename that sends the
  // collision down the skip path; refusing at the input is what turns that into
  // a sentence the user can act on.
  //
  // Checked against a one-character SAMPLE title, and what that can and cannot
  // establish is worth stating, because an earlier version of this comment
  // claimed the length property and the check does not carry it.
  //
  // `isLegalSegment` rejects a trailing dot, illegal characters AND a byte
  // length, and only the first two are properties of the label alone. The third
  // is a property of the RESULT, so a label legal against `x` can still push a
  // real title past `MAX_SEGMENT_BYTES`. This screen runs BEFORE the source
  // vault is open and has no titles to measure against, so it cannot check it:
  // the sample is the shortest possible title, which makes this the most
  // permissive form of the rule rather than the intended one.
  //
  // The length case is therefore handled where the titles are known, in
  // `decideRenames`: a title the label cannot legally extend is left unrenamed
  // and its inbound links are counted as unresolved, so it appears in the
  // report instead of taking the skip arm silently.
  const labelIllegal = !isLegalImportLabel("x", label);

  // §3.2 normalisation happens inside the derivation (`protocol.md` §7.4), so
  // this only has to join the cells the way the user typed them.
  const phrase = cells.join(" ").trim();
  const secretReady = kind === "password" ? password.length > 0 : cells.every((c) => c.trim() !== "");

  const submit = useCallback(() => {
    if (
      (backupMode ? backupPath === undefined : chosen === NO_VAULT) ||
      !secretReady ||
      labelIllegal
    ) {
      return;
    }
    const credential =
      kind === "password" ? { password } : { recoveryPhrase: phrase };
    // The secret leaves THIS component's state as it is handed over. It still
    // lives in V8 until that string is collected, which the threat model
    // accepts under A7, but holding it in a mounted component for the length of
    // an import would be a longer window for no reason.
    setPassword("");
    setCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));
    onReady({
      sourceVaultId: backupMode ? undefined : chosen,
      backupPath: backupMode ? backupPath : undefined,
      importLabel: label,
      credential,
    });
  }, [
    backupMode,
    backupPath,
    chosen,
    kind,
    password,
    phrase,
    secretReady,
    labelIllegal,
    label,
    onReady,
  ]);

  if (vaults === null) {
    return (
      <div style={BODY_STYLE} data-testid="import-myne.loading">
        <p style={HINT}>{t("notes.import.myne.loading")}</p>
      </div>
    );
  }

  if (vaults.length === 0 && !backupMode) {
    // An empty list explains itself rather than rendering an empty box. This is
    // the ordinary state for a user with one vault, not an error. A backup
    // source skips this: its list is empty by construction.
    return (
      <>
        <div style={BODY_STYLE} data-testid="import-myne.empty">
          <p style={BANNER}>{t("notes.import.myne.noOtherVaults")}</p>
        </div>
        <div style={FOOTER_STYLE}>
          {onBack !== undefined && (
            <Button onClick={onBack} data-testid="import-myne.back">
              {t("common.back")}
            </Button>
          )}
          <Button onClick={onCancel} data-testid="import-myne.cancel">
            {t("common.close")}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div style={BODY_STYLE} data-testid="import-myne.setup">
        {error !== null && (
          <p style={ERROR_BANNER} role="alert" data-testid="import-myne.error">
            {error}
          </p>
        )}
        {/* The PRE-import fidelity disclosure, which every other source gets from
            `SetupBody` and this one used to skip entirely: `SetupBody` renders
            it and the vault branch bypasses `SetupBody`, so two catalog keys
            were defined and shown nowhere and the one disclosure the picker's
            own comment calls a requirement arrived only AFTER the run. */}
        <div style={DISCLOSURE}>
          <span style={DISCLOSURE_LABEL}>
            {t("notes.import.modal.keepsLabel")}
          </span>
          <span style={DISCLOSURE_TEXT} data-testid="import.source-survives">
            {t(IMPORT_SOURCES.myne.survivesKey)}
          </span>
          <span style={{ ...DISCLOSURE_LABEL, marginTop: "var(--space-1)" }}>
            {t("notes.import.modal.losesLabel")}
          </span>
          <span style={DISCLOSURE_TEXT} data-testid="import.source-loses">
            {t(IMPORT_SOURCES.myne.losesKey)}
          </span>
        </div>

        <div style={FIELD}>
          <span style={FIELD_LABEL}>
            {backupMode
              ? t("notes.import.myne.backupLabel")
              : t("notes.import.myne.vaultLabel")}
          </span>
          {!backupMode ? (
            /* `Select`, never a native `<select>`: `docs/design/README.md`'s
               picker table forbids the OS popup outright, because it does not
               match the app chrome. Option count here is the vault count, which
               is 1 to a handful, so `Select` rather than `SearchableSelect`. */
            <Select
              value={chosen}
              options={options}
              onChange={setChosen}
              aria-label={t("notes.import.myne.vaultLabel")}
              testId="import-myne.vault"
            />
          ) : (
            /* The picked `.myne-backup`, chosen through the OS picker
               (myne-md/myne#816). */
            <div
              style={{
                display: "flex",
                gap: "var(--space-2)",
                alignItems: "center",
              }}
            >
              {backupPath !== undefined ? (
                <span
                  data-testid="import-myne.backup-path"
                  title={backupPath}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm)",
                    color: "var(--fg-1)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {backupPath}
                </span>
              ) : (
                <span
                  data-testid="import-myne.backup-none"
                  style={{ flex: 1, fontSize: "var(--text-sm)", color: "var(--fg-3)" }}
                >
                  {t("notes.import.myne.noBackupChosen")}
                </span>
              )}
              <Button
                variant="secondary"
                onClick={() => onChooseFile?.()}
                data-testid="import-myne.choose-backup"
              >
                {t("notes.import.myne.chooseBackup")}
              </Button>
            </div>
          )}
        </div>

        <div style={FIELD}>
          <span style={FIELD_LABEL}>
            {kind === "password"
              ? t("notes.import.myne.passwordLabel")
              : t("notes.import.myne.phraseLabel")}
          </span>
          {kind === "password" ? (
            <PasswordInput
              label={t("notes.import.myne.passwordLabel")}
              value={password}
              onChange={setPassword}
              show={showPassword}
              onToggleShow={() => setShowPassword(!showPassword)}
              testId="import-myne.secret"
            />
          ) : (
            <PhraseGrid cells={cells} onCells={setCells} />
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setKind(kind === "password" ? "phrase" : "password");
              setPassword("");
              setCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));
            }}
            data-testid="import-myne.toggle-credential"
          >
            {kind === "password"
              ? t("notes.import.myne.usePhrase")
              : t("notes.import.myne.usePassword")}
          </Button>
        </div>

        <div style={FIELD}>
          <label style={FIELD_LABEL} htmlFor="import-myne-label">
            {t("notes.import.myne.importLabel")}
          </label>
          <Input
            id="import-myne-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            data-testid="import-myne.label"
          />
          <p style={HINT}>{t("notes.import.myne.importLabelHint")}</p>
          {labelIllegal && (
            <p style={HINT} role="alert" data-testid="import-myne.label-error">
              {t("notes.import.myne.importLabelIllegal")}
            </p>
          )}
        </div>
      </div>

      <div style={FOOTER_STYLE}>
        {onBack !== undefined && (
          <Button onClick={onBack} data-testid="import-myne.back">
            {t("common.back")}
          </Button>
        )}
        <Button onClick={onCancel} data-testid="import-myne.cancel">
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          // The label is REQUIRED, and gating on it is what makes
          // `renamedTitleFor`'s own comment true. An empty label makes that
          // function return the title unchanged, which makes the rename a no-op,
          // which sends the collision back down the skip path: the silent
          // mis-link the whole rule exists to prevent.
          // **The gate is the SAME predicate `submit` uses, and it was not.**
          // In `backupMode` the source is a `.myne-backup`, so the vault-list
          // selection is never made (`chosen` stays `NO_VAULT`, and the effect
          // that would set it returns early) — the button was therefore disabled
          // for the whole backup path, whatever path and password were entered,
          // and the import could not be started at all. `submit` already asked
          // the right question; this now asks it too.
          disabled={
            (backupMode ? backupPath === undefined : chosen === NO_VAULT) ||
            !secretReady ||
            labelIllegal
          }
          onClick={submit}
          data-testid="import-myne.continue"
        >
          {t("common.continue")}
        </Button>
      </div>
    </>
  );
}
