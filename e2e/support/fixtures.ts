// Fixture layer — vault seeding + at-rest fault injection (task 5; SYNC-2).
//
// `seedVaults` runs the `e2e-fixture-gen` workspace crate
// (`e2e/fixture-gen/`), which composes the SAME protocol public API the
// production creation path uses; the generated `vaults/<id>/vault.meta`
// unlocks through the untouched production unlock path. Weak KDF by
// default (params are vault.meta-resident — SYNC-9); production KDF on
// request (the VR-1 drill).
//
// The generator binary is built ONCE per process (memoized `cargo
// build`), then invoked directly — per-seed `cargo run` would re-pay
// cargo startup + the target-dir lock inside test budgets.
//
// Byte-surgery offsets mirror `e2e/fixture-gen/src/lib.rs::offsets`,
// whose tests pin each offset SEMANTICALLY (tampering a field breaks
// exactly that field's unwrap). The generator additionally EMITS its
// offset table in the seed JSON and `seedVaults` verifies this mirror
// against it on every call — a desynced mirror throws instead of
// silently tampering the wrong field.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { REPO_ROOT } from "./session";
import { scanForPlaintext } from "./plaintext-scan";

/**
 * A one-line, content-free description of what is under `<appDataDir>/vaults`,
 * for a failure message.
 *
 * Reports each vault directory's name and whether it still holds a `vault.meta`
 * — the file `vault_list` keys on, so an entry without one is invisible to the
 * app exactly as an absent directory is. It never opens the file, so nothing it
 * prints can carry vault content into a CI log.
 *
 * It exists because the boot probe added to `unlockToEditor` reported six
 * scenarios sitting on the WELCOME screen, which `initialStageFromProbe`
 * reaches on exactly one input: `vault_list` answered with zero vaults. The
 * seed runs to completion before the app process spawns, so "the seed was late"
 * is already ruled out, and the remaining explanations split on the one fact
 * this supplies: whether the vault is on disk at the moment of failure.
 * Populated means the app read a different place or dropped what it read; empty
 * means something removed it after the generator wrote it.
 */
export function vaultDirState(appDataDir: string): string {
  const vaults = join(appDataDir, "vaults");
  if (!existsSync(appDataDir)) return "appDataDir itself is gone";
  if (!existsSync(vaults)) return "no vaults/ directory";
  try {
    const names: string[] = readdirSync(vaults);
    const dirs = names.filter((n: string) => statSync(join(vaults, n)).isDirectory());
    if (dirs.length === 0) return "vaults/ is EMPTY";
    return dirs
      .map((n: string) => `${n}:${existsSync(join(vaults, n, "vault.meta")) ? "meta" : "NO-META"}`)
      .join(" ");
  } catch (raw) {
    return `unreadable (${(raw as Error).message})`;
  }
}

export interface SeededVault {
  vaultId: string;
  password: string;
  /** 24 space-joined lowercase BIP-39 words. */
  phrase: string;
  /** 27-char display account number. */
  account: string;
  /** Present only when seeded with `exportSuite: true`. */
  exportSuite?: ExportSuite;
  /** Present only on the LAST vault, and only with `importSourceSuite: true`. */
  importSourceSuite?: ImportSourceSuite;
}

/** One attachment of the MYND-116 note-export suite. */
export interface ExportSuiteAttachment {
  /** 64-char lowercase-hex attachment-id (blob filename + embed target). */
  idHex: string;
  /** Catalog display filename — BOTH suite attachments share it, so the
   *  export dedups the second to `"evidence (1).png"`. */
  filename: string;
  /** Exact plaintext file bytes (ASCII by construction). */
  contents: string;
  contentType: string;
}

/** Pre-baked note-export content (`--export-suite`): a note WITHOUT
 *  attachment refs (byte-verbatim export oracle), a note WITH two
 *  colliding-filename form-C embeds, and a note WITH one `.pdf` embed
 *  (the MYND-255 PDF-export exclusion-notice bait) + MYA1 blobs + MYC1
 *  catalog. The plaintexts are the generator's exact written bytes —
 *  in-source scenario content, not credentials. */
export interface ExportSuite {
  plainNoteId: string;
  plainNotePlaintext: string;
  attachmentsNoteId: string;
  attachmentsNotePlaintext: string;
  /** The two image attachments, in first-appearance (= export-naming)
   *  order — the `.pdf` bait rides `pdfAttachment` separately. */
  attachments: ExportSuiteAttachment[];
  /** Note WITH one form-C `.pdf` embed (MYND-255). */
  pdfNoteId: string;
  pdfNotePlaintext: string;
  pdfAttachment: ExportSuiteAttachment;
}

/**
 * Names the vault-import source suite laid down, so a scenario asserts against
 * the strings the generator wrote rather than against re-typed copies.
 *
 * The two `…NotWritten` fields are exactly that: reported, not written. The
 * generator cannot seal a `vault.dictionary` without keeping a second copy of
 * the postcard payload that lives in `src-tauri/src/spell/dictionary.rs`, and a
 * fixture that re-implements a format drifts from it silently. The dictionary
 * carry is covered by `tests/notes/import/myneDictionary.test.ts` and by
 * `plugins::importer::source_dictionary::tests` instead.
 */
export interface ImportSourceSuite {
  linkingNoteTitle: string;
  collidingLinkedTitle: string;
  collidingUnlinkedTitle: string;
  untitledBody: string;
  trashedTitle: string;
  templateTitle: string;
  referencedAttachmentId: string;
  unreferencedAttachmentId: string;
  /** Embedded by an imported note, absent from the source catalog: no blob. */
  tombstonedAttachmentId: string;
  brokenLinkTarget: string;
  dictionaryWordNotWritten: string;
  ignoredWordNotWritten: string;
}

export interface SeedOptions {
  kdf?: "weak" | "production";
  count?: number;
  password?: string;
  /** Lay the MYND-116 note-export suite into every seeded vault.
   *  Implies `generation: "v0.1"` — the suite writes `MY01`/`MYA1`/`MYC1`. */
  exportSuite?: boolean;
  /**
   * Lay the vault-import source suite into the LAST seeded vault
   * (myne-md/myne#464). Needs `count >= 2`, and the generator refuses fewer:
   * a vault-import scenario needs a target and a source, and putting the
   * source's content into both would hand the target the very titles the
   * collision rules are supposed to meet for the first time during the import.
   *
   * Implies `generation: "v0.1"` for the same reason `exportSuite` does.
   */
  importSourceSuite?: boolean;
  /**
   * Which protocol generation the seeded vault is written in. Defaults to the
   * product's birth format (v0.2 — `decisions.md` 2026-08-13), so a scenario
   * that says nothing gets the vault a real user would have.
   *
   * Pass `"v0.1"` ONLY when the scenario is about a pre-flip vault: the
   * migration itself, and the legacy-vault coverage that proves an old vault
   * still opens. Say which in a comment at the call site — a v0.1 seed that
   * exists by accident silently stops testing the format users actually get.
   */
  generation?: "v0.1" | "v0.2";
}

/** § 9.3 field offsets in vault.meta — lockstep mirror of
 *  `e2e-fixture-gen::offsets` (Rust tests pin the semantics; the
 *  generator's emitted table is runtime-verified in `seedVaults`). */
export const VAULT_META_OFFSETS = {
  MAGIC: 0,
  ACCOUNT_HASH: 6,
  KDF_PARAMS: 22,
  SALT_PASSWORD: 33,
  SALT_RECOVERY: 49,
  NONCE_PASSWORD_WRAP: 65,
  ENC_ROOT_KEY_PASSWORD: 89,
  NONCE_RECOVERY_WRAP: 153,
  ENC_ROOT_KEY_RECOVERY: 177,
  ITEMS_KEY_ID: 241,
  ITEMS_KEY_NONCE: 257,
  ENC_ITEMS_KEY: 281,
  END: 345,
} as const;

const GENERATOR_BIN = join(REPO_ROOT, "target", "release", "e2e-fixture-gen");
let generatorBuilt = false;

/** Build the generator once per process; later seeds exec the binary
 *  directly (no cargo startup / target-lock cost inside test budgets). */
function ensureGeneratorBuilt(): string {
  if (!generatorBuilt) {
    execFileSync("cargo", ["build", "--quiet", "--release", "-p", "e2e-fixture-gen"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 300_000,
    });
    generatorBuilt = true;
  }
  return GENERATOR_BIN;
}

function verifyOffsetsMirror(emitted: Record<string, number>): void {
  for (const [key, value] of Object.entries(VAULT_META_OFFSETS)) {
    if (emitted[key] !== value) {
      throw new Error(
        `VAULT_META_OFFSETS mirror desync at ${key}: TS=${value}, generator=${emitted[key]}. ` +
          "Update e2e/support/fixtures.ts to match e2e/fixture-gen/src/lib.rs::offsets.",
      );
    }
  }
}

/**
 * Seed `count` unlockable vaults into `appDataDir` (the session's
 * isolated `<XDG_DATA_HOME>/md.myne.desktop`). Call from `launchApp`'s
 * `seed` callback so the layout exists before the app boots.
 */
export function seedVaults(appDataDir: string, opts: SeedOptions = {}): SeededVault[] {
  const bin = ensureGeneratorBuilt();
  const args = [
    "--base",
    appDataDir,
    "--count",
    String(opts.count ?? 1),
    "--kdf",
    opts.kdf ?? "weak",
  ];
  if (opts.password) args.push("--password", opts.password);
  if (opts.exportSuite) args.push("--export-suite");
  if (opts.importSourceSuite) args.push("--import-source-suite");
  // `--export-suite` pins v0.1 generator-side; passing both is refused there
  // rather than silently reconciled, so only forward an explicit choice.
  if (opts.generation && !opts.exportSuite && !opts.importSourceSuite) {
    args.push("--generation", opts.generation);
  }
  let stdout: string;
  try {
    stdout = execFileSync(bin, args, {
      encoding: "utf8",
      // Production-KDF generation runs Argon2id at m=256 MiB ×2 per vault.
      timeout: 300_000,
    });
  } catch (e) {
    // Sanitized rethrow (SYNC-13): the raw error embeds the argv (a
    // caller-supplied --password would land in CI logs) and captured
    // stdout (credential JSON on a timeout-kill window).
    const status = (e as { status?: number | null }).status ?? "signal/timeout";
    throw new Error(`e2e-fixture-gen failed (exit: ${status}); argv/stdout suppressed`);
  }
  const parsed = JSON.parse(stdout) as {
    vaults: SeededVault[];
    offsets: Record<string, number>;
  };
  verifyOffsetsMirror(parsed.offsets);
  return parsed.vaults;
}

/** Single-vault convenience. */
export function seedVault(appDataDir: string, opts: Omit<SeedOptions, "count"> = {}): SeededVault {
  return seedVaults(appDataDir, { ...opts, count: 1 })[0];
}

// (MYND-486) The `seedCustomTheme` helper — which copied a fixture into the
// device-local `app_config_dir/themes/` directory — was removed when the
// custom-theme palettes moved into the encrypted `vault.themes` (`MYT1`) store.
// The `custom-themes.e2e.ts` ct2 scenario now seals the theme through the real
// `plugin:themes|themes_import` IPC (page-seat), so no on-disk fixture seed is
// needed. The `e2e/fixtures/themes/catppuccin-mocha.json` palette is still read
// by that scenario and passed as the `paletteJson` argument.

export function vaultMetaPath(appDataDir: string, vaultId: string): string {
  return join(appDataDir, "vaults", vaultId, "vault.meta");
}

// ---- at-rest magic-byte asserters (SYNC-W2-2) -----------------------------
//
// Positive controls complementing PS-1's negative residue scan: after an
// import, the per-attachment blob and the catalog must carry their
// load-bearing major-version magic (CLAUDE.md "Cryptographically load-bearing
// identifiers"; protocol.md §9.9 / §9.10). These helpers only READ the magic —
// they never redefine it.

/** Path to one per-attachment MYA1 blob: `vaults/<id>/attachments/<id-hex>`.
 *  `attachmentId` is the 64-char lowercase-hex id returned by
 *  `attachment_import` / `catalog_list` (the blob filename is the id verbatim;
 *  `attachments/commands.rs` `blob_path = attachments_dir.join(&id_hex)`). */
export function attachmentBlobPath(
  appDataDir: string,
  vaultId: string,
  attachmentId: string,
): string {
  return join(appDataDir, "vaults", vaultId, "attachments", attachmentId);
}

/** Path to the MYC1 attachments catalog: `vaults/<id>/vault.attachments`. */
export function attachmentsCatalogPath(appDataDir: string, vaultId: string): string {
  return join(appDataDir, "vaults", vaultId, "vault.attachments");
}

/** Path to the MYS1 search index: `vaults/<id>/vault.search`
 *  (`protocol/src/search_blob.rs`; spec § 9.6.1). */
export function searchIndexPath(appDataDir: string, vaultId: string): string {
  return join(appDataDir, "vaults", vaultId, "vault.search");
}

/** Path to the MYG1 graph-layout cache: `vaults/<id>/vault.graph`
 *  (`protocol/src/graph_layout_blob.rs`; spec § 9.19.1). */
export function graphLayoutPath(appDataDir: string, vaultId: string): string {
  return join(appDataDir, "vaults", vaultId, "vault.graph");
}

/** Path to the MYL1 sealed label store: `vaults/<id>/vault.label`
 *  (`protocol/src/vault_label_blob.rs`; spec § 9.22.1; myne-md/myne#411).
 *  Device-local: it holds one vault's NAME, sealed under a per-vault OS-keychain
 *  wrap key, so the locked picker can render it before any unlock. */
export function vaultLabelPath(appDataDir: string, vaultId: string): string {
  return join(appDataDir, "vaults", vaultId, "vault.label");
}

/** Path to the device-local hide-vault-names flag,
 *  `<app_config_dir>/vault-names.json` (`core/src/vault_label/hide_flag.rs`).
 *  Note the directory: it is a DEVICE setting, not vault data, so it lives
 *  beside `sync-config.json` under `app_config_dir` and not under any vault. */
export function hideVaultNamesFlagPath(appConfigDir: string): string {
  return join(appConfigDir, "vault-names.json");
}

/** Path to the device-local screen-capture override,
 *  `<app_config_dir>/screen-capture.json`
 *  (`core/src/screen_capture_override.rs`, myne-md/myne#482). Same directory
 *  and same reason as `vault-names.json` above: a DEVICE setting, not vault
 *  data, and it has to be readable before any vault is open because
 *  "unreadable before unlock" is the lockout it exists to open. */
export function screenCaptureOverridePath(appConfigDir: string): string {
  return join(appConfigDir, "screen-capture.json");
}

/**
 * Assert a blob's leading 4 bytes equal `magic` (latin1). The generic shape
 * every at-rest format check reuses — MYA1 (per-attachment blob), MYC1
 * (attachments catalog), MYS1 (search index), MY01 (per-note snapshot) all
 * call this with their own 4-char magic. Throws (not a soft warn) when the
 * file is absent: a missing artefact after a write IS the regression.
 *
 * Lives in fixtures (not a scenario) so it stays reusable; uses the project's
 * vitest `expect` via the caller — here it just compares + throws so it has no
 * test-runner dependency and reads cleanly from any scenario body.
 */
export function assertBlobMagic(path: string, magic: string): void {
  const bytes = readFileSync(path); // throws ENOENT if the artefact is missing
  const head = bytes.subarray(0, 4).toString("latin1");
  if (head !== magic) {
    throw new Error(
      `at-rest magic mismatch at ${path}: expected ${JSON.stringify(magic)}, got ${JSON.stringify(head)}`,
    );
  }
}

/** Which generation a vault is, read from `vault.meta`'s own magic.
 *
 * `MYV1` is v0.1 and `NTV5` is v0.2 (`protocol.md` §10.3). Every per-vault blob
 * family follows the vault it belongs to, so a fixture that hardcodes one
 * family's magic is asserting against whichever generation happened to be
 * current the day it was written. */
export function vaultGeneration(appDataDir: string, vaultId: string): "v0.1" | "v0.2" {
  const head = readFileSync(vaultMetaPath(appDataDir, vaultId))
    .subarray(0, 4)
    .toString("latin1");
  if (head === "MYV1") return "v0.1";
  if (head === "NTV5") return "v0.2";
  throw new Error(
    `vault.meta magic is ${JSON.stringify(head)}, which is neither MYV1 (v0.1) ` +
      "nor NTV5 (v0.2). A third value here is a format regression, not a new case " +
      "to add: fix the writer rather than this helper.",
  );
}

/** Assert the per-attachment blob at `attachments/<id-hex>` carries the
 *  attachment magic for THIS VAULT'S generation: `MYA1` on v0.1, `MYA5` on v0.2.
 *
 * **It used to hardcode `MYA1`, and that is why three scenarios were red.** The
 * product is right and has a test saying so: `core/src/plugins/attachments/
 * commands.rs` writes "under the vault's OWN generation", with
 * `an attachment imported into an NTV5 vault must be MYA5, not MYA1`. A vault
 * created today is v0.2 throughout, so every fixture vault became NTV5 and this
 * assertion started demanding the previous generation's magic. It failed on
 * develop and on every branch cut from it, and it read like an at-rest format
 * regression, which is the one thing it exists to be believed about.
 *
 * Deriving the expectation keeps the assertion STRONGER than relaxing it to
 * "either magic" would: a v0.1 vault whose attachment came out `MYA5` is still
 * a failure here, and so is the reverse. */
export function assertAttachmentBlobMagic(
  appDataDir: string,
  vaultId: string,
  attachmentId: string,
): void {
  const magic = vaultGeneration(appDataDir, vaultId) === "v0.2" ? "MYA5" : "MYA1";
  assertBlobMagic(attachmentBlobPath(appDataDir, vaultId, attachmentId), magic);
}

/** Assert the attachments catalog `vault.attachments` carries this vault's
 *  catalog magic: `MYC1` on v0.1, `MYC5` on v0.2. Same generation rule and the
 *  same reason as the attachment blob above; the migration moves the catalog
 *  and its blobs together (`core/src/plugins/vault_migrate/mod.rs`: "`MYC1`→
 *  `MYC5` plus every `attachments/<id>` `MYA1`→`MYA5`"). */
export function assertCatalogMagic(appDataDir: string, vaultId: string): void {
  const magic = vaultGeneration(appDataDir, vaultId) === "v0.2" ? "MYC5" : "MYC1";
  assertBlobMagic(attachmentsCatalogPath(appDataDir, vaultId), magic);
}

/**
 * Assert the search index `vault.search` carries the MYS1 at-rest header:
 * magic `MYS1` @0 (via the shared `assertBlobMagic`), `protocol_version`
 * `0x01` @4, `index_format_version` `0x01` @5, and a header at least
 * `SEARCH_BLOB_HEADER_LEN` (34) bytes (4 magic + 1 + 1 + 24 nonce + 4
 * big-endian ciphertext_len). The positive control parallel to PS-1's MY01
 * note-blob assert: a residue scan proves the index is plaintext-free, this
 * proves a silent format/version regression hasn't shipped. Read-only — the
 * load-bearing constants live in `protocol/src/search_blob.rs:62-77`; this
 * only mirrors them to catch drift.
 */
export const SEARCH_BLOB_PROTOCOL_VERSION = 0x01;
export const SEARCH_BLOB_INDEX_FORMAT_V1 = 0x01;
export const SEARCH_BLOB_HEADER_LEN = 34;

export function assertSearchIndexMagic(appDataDir: string, vaultId: string): void {
  const path = searchIndexPath(appDataDir, vaultId);
  assertBlobMagic(path, "MYS1"); // throws ENOENT if absent, mismatch if wrong magic
  const bytes = readFileSync(path);
  if (bytes.length < SEARCH_BLOB_HEADER_LEN) {
    throw new Error(
      `vault.search shorter than the MYS1 header at ${path}: ` +
        `len ${bytes.length} < ${SEARCH_BLOB_HEADER_LEN}`,
    );
  }
  if (bytes[4] !== SEARCH_BLOB_PROTOCOL_VERSION) {
    throw new Error(
      `vault.search protocol_version mismatch at ${path}: ` +
        `expected ${SEARCH_BLOB_PROTOCOL_VERSION}, got ${bytes[4]}`,
    );
  }
  if (bytes[5] !== SEARCH_BLOB_INDEX_FORMAT_V1) {
    throw new Error(
      `vault.search index_format_version mismatch at ${path}: ` +
        `expected ${SEARCH_BLOB_INDEX_FORMAT_V1}, got ${bytes[5]}`,
    );
  }
}

/** Directory holding a vault's encrypted per-note snapshots:
 *  `vaults/<id>/snapshots/` (flat, no per-note subdirs — protocol.md §9, the
 *  `notes/` privacy posture). */
export function snapshotsDir(appDataDir: string, vaultId: string): string {
  return join(appDataDir, "vaults", vaultId, "snapshots");
}

/** List the snapshot blob filenames for one note, newest-first.
 *  Snapshots are flat `snapshots/<note-uuid>__<snap-uuidv7>.myn` (protocol.md
 *  §9.{snapshots}); the trailing UUIDv7's time component sorts naturally, so a
 *  descending name sort is newest-first. Filters on the `<note-uuid>__` prefix
 *  so a multi-note vault's snapshots don't cross-contaminate. Returns `[]` when
 *  the dir is absent (a note with no snapshots yet). */
export function snapshotBlobNames(
  appDataDir: string,
  vaultId: string,
  noteUuid: string,
): string[] {
  const dir = snapshotsDir(appDataDir, vaultId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no snapshots/ dir yet
  }
  return names
    .filter((n) => n.startsWith(`${noteUuid}__`) && n.endsWith(".myn"))
    .sort()
    .reverse();
}

/** Path to one snapshot blob by full filename
 *  (`snapshots/<note-uuid>__<snap-uuidv7>.myn`). */
export function snapshotBlobPath(
  appDataDir: string,
  vaultId: string,
  blobName: string,
): string {
  return join(snapshotsDir(appDataDir, vaultId), blobName);
}

/**
 * At-rest positive control for a note's snapshots (SYNC-W2-2, extends SYNC-21):
 * assert at least one `snapshots/<note-uuid>__<snap-uuidv7>.myn` blob exists and
 * EVERY such blob carries the `MY01` envelope magic (reuses `assertBlobMagic` —
 * snapshots reuse the note's `item_key` + the §9.2 `MY01` envelope; no new
 * magic). Throws when the note has no snapshots (a missing blob after a real
 * capture IS the regression). Returns the blob names asserted, newest-first.
 */
export function assertSnapshotBlobsMagic(
  appDataDir: string,
  vaultId: string,
  noteUuid: string,
): string[] {
  const names = snapshotBlobNames(appDataDir, vaultId, noteUuid);
  if (names.length === 0) {
    throw new Error(
      `no snapshot blobs at ${snapshotsDir(appDataDir, vaultId)} for note ${noteUuid}`,
    );
  }
  for (const name of names) {
    assertBlobMagic(snapshotBlobPath(appDataDir, vaultId, name), "MY01");
  }
  return names;
}

/**
 * PS-1 residue scan over a vault's `snapshots/` directory (reuses
 * `scanForPlaintext`): every `needle` (note-content marker; the in-source
 * scenario-constant class, not a credential) must be ABSENT in plaintext under
 * `snapshots/`. The negative complement to `assertSnapshotBlobsMagic`'s positive
 * MY01 control. Returns the hits (empty array = clean) so the caller asserts the
 * shape (`toEqual([])`) — failure output reports needle INDICES, never the
 * needle text (SYNC-13). A missing dir scans as clean (no leakage possible).
 */
export function scanSnapshotsForResidue(
  appDataDir: string,
  vaultId: string,
  needles: string[],
): ReturnType<typeof scanForPlaintext> {
  const dir = snapshotsDir(appDataDir, vaultId);
  try {
    statSync(dir);
  } catch {
    return []; // no snapshots/ dir → nothing to leak
  }
  return scanForPlaintext(dir, needles);
}

/** XOR one byte at `offset` — the canonical at-rest tamper primitive.
 *  Pick offsets from `VAULT_META_OFFSETS` (e.g. ENC_ROOT_KEY_RECOVERY
 *  for the VR-2 tampered-twin, MAGIC for structural corruption). */
export function tamperVaultMeta(appDataDir: string, vaultId: string, offset: number): void {
  const path = vaultMetaPath(appDataDir, vaultId);
  const bytes = readFileSync(path);
  if (offset < 0 || offset >= bytes.length) {
    throw new Error(`tamper offset ${offset} out of range (len ${bytes.length})`);
  }
  bytes[offset] ^= 0xff;
  writeFileSync(path, bytes);
}

/** Replace vault.meta with random bytes (the "garbage file" class —
 *  lists as Exists, fails closed at submit). */
export function corruptVaultMetaWholesale(appDataDir: string, vaultId: string): void {
  const path = vaultMetaPath(appDataDir, vaultId);
  writeFileSync(path, randomBytes(statSync(path).size));
}

/** Delete vault.meta but leave the dir recognizably a vault (an orphan
 *  `notes/*.myn` blob) — `discover_vaults` then lists it with
 *  `well_formed = false` → `VaultSummaryStatus::Corrupted` → the boot
 *  probe routes to the fail-closed corrupted-vault surface
 *  (`vault_registry.rs::is_well_formed`). */
export function deleteVaultMetaKeepArtifacts(appDataDir: string, vaultId: string): void {
  rmSync(vaultMetaPath(appDataDir, vaultId));
  const notesDir = join(appDataDir, "vaults", vaultId, "notes");
  mkdirSync(notesDir, { recursive: true });
  // Content is irrelevant to discovery — presence of a `.myn` is the
  // artifact signal (`vault_artifacts_present`).
  writeFileSync(join(notesDir, "orphan.myn"), randomBytes(64));
}

/** chmod-based permission fault (Linux-canonical, SYNC-1). Returns an
 *  undo function. Meaningless under root — the harness runs
 *  unprivileged by design. */
export function denyRead(path: string): () => void {
  chmodSync(path, 0o000);
  return () => chmodSync(path, 0o600);
}

/** Lay down a LEGACY single-vault layout (`<appDataDir>/vault/vault.meta`)
 *  for the eager-boot-migration scenario (MYND-127). Seeds via the
 *  generator into a scratch area, then moves the meta into the legacy
 *  location. */
export function seedLegacyVault(
  appDataDir: string,
  opts: Omit<SeedOptions, "count"> = {},
): SeededVault {
  const seeded = seedVault(appDataDir, opts);
  const modern = vaultMetaPath(appDataDir, seeded.vaultId);
  const legacyDir = join(appDataDir, "vault");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "vault.meta"), readFileSync(modern));
  // Remove the modern layout so ONLY the legacy dir exists pre-boot.
  rmSync(join(appDataDir, "vaults"), { recursive: true, force: true });
  return seeded;
}
