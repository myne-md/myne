// Write fixture bytes into a browser's OPFS before the app boots
// (phase3-web-client task 105, criterion 5).
//
// # Why this exists instead of a test hook
//
// The lane's second non-negotiable is **zero production test hooks**: no
// `window.__test`, no query-parameter backdoor. So at-rest state is arranged the
// same way the desktop lane arranges it — by writing the BYTES the app will
// read, before it reads them. There it is byte surgery on a seeded vault
// directory; here it is OPFS.
//
// # Why the bytes come from Rust
//
// Every fixture is produced by driving the real container writer with the same
// `Fault` injection its unit tests use (`core/src/double_buffer_fixtures.rs`,
// emitted by `core/examples/emit-double-buffer-fixtures.rs`). A fixture
// assembled in TypeScript would encode a SECOND opinion about the generation
// prefix and the slot suffixes, and the moment it drifted the lane would be
// testing recovery from a shape production never produces — which fails as a
// passing test.
//
// # The ordering constraint that makes this usable
//
// OPFS is origin-scoped, so the seed has to happen on the app's origin — but
// after the app has booted it has already read what it is going to read. The
// harness server therefore serves a blank page at `/__seed`, which exists only
// in the test server (`support/server.ts`), never in the production container.
// The sequence is: navigate to `/__seed` → write → navigate to `/` → the app
// boots onto a store that already looks crashed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "./session";

/** One slot file of a fixture, as the Rust generator emits it. */
export interface FixtureFile {
  /** Path relative to the vault root, e.g. `vault.meta.a`. */
  readonly name: string;
  /** Raw bytes — a plain number array, deliberately not base64. */
  readonly bytes: number[];
}

/** A named crash state. */
export interface Fixture {
  readonly name: string;
  readonly expectation: string;
  readonly files: FixtureFile[];
  /**
   * The intact payload that must be AMONG the candidates a reader gets, or
   * `null` where the scheme permits either answer.
   *
   * Among, not first: `double_buffer::candidates` ranks by generation stamp and
   * returns everything worth attempting; it does not decide which is intact,
   * because completeness is an AEAD property one layer up. A torn slot whose
   * stamp landed ranks first, correctly.
   */
  readonly recoverablePayload: number[] | null;
}

const FIXTURES_PATH = join("e2e-web", "fixtures", "double-buffer.json");

/** Load the emitted fixtures. Throws loudly if the file is absent or empty —
 *  a seeder that silently seeds nothing produces a scenario that passes on an
 *  empty store, which is the worst available outcome. */
export function loadFixtures(path = FIXTURES_PATH): Fixture[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Fixture[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `${path} carries no fixtures. Re-emit with:\n` +
        `  cargo run -p myne-core --features test-support --example emit-double-buffer-fixtures > ${path}`,
    );
  }
  return parsed;
}

/** Pick one fixture by name, failing with the available names rather than
 *  `undefined` — a typo'd fixture name would otherwise seed nothing and read as
 *  "the app handled it fine". */
export function fixture(name: string, all = loadFixtures()): Fixture {
  const found = all.find((f) => f.name === name);
  if (!found) {
    throw new Error(`no fixture named ${name}; have: ${all.map((f) => f.name).join(", ")}`);
  }
  return found;
}

/**
 * The OPFS path the web client keeps a vault under.
 *
 * A constant here rather than a parameter because it is a constant there:
 * `paths::web_single_vault_id()` is a fixed UUID, which is what makes
 * "exactly one vault per origin" a property by construction.
 */
export const VAULT_ROOT = "myne/vaults/00000000-0000-7000-8000-ebebebebebeb";

/**
 * Write a fixture's slot files into OPFS, replacing whatever is there.
 *
 * Runs in the page, so the session must already be ON the app's origin — OPFS
 * is origin-scoped and a seed written from anywhere else lands in a different
 * store. Use `/__seed` (see the header) rather than `/`, or the app will have
 * booted before the bytes exist.
 */
export async function seedFixture(session: Session, f: Fixture): Promise<void> {
  await seedFiles(session, VAULT_ROOT, f.files, f.name);
}

/**
 * An unlockable vault: real `vault.meta` bytes behind real container framing,
 * minted by `core/examples/emit-vault-fixture.rs`.
 *
 * The web client is sync-required for SIGN-IN but not for UNLOCK — unlocking
 * reads `vault.meta` and derives a key, and never touches a server. Seeding one
 * is therefore what lets a lane with NO sync server reach an unlocked vault,
 * which is the precondition for every post-unlock surface (task 87's conflict
 * and quarantine views among them).
 */
export interface VaultFixture {
  readonly password: string;
  readonly accountNumber: string;
  readonly files: FixtureFile[];
  /**
   * The device-identity half of an awaiting-approval state (`sync-state.json`),
   * relative to the vault root.
   *
   * Separate from `files` deliberately: `files` alone is a plain vault with sync
   * unconfigured, which is what every other scenario wants. Folding these in
   * would turn `unlock-from-fixture` into a pending scenario without anyone
   * editing it, so awaiting-approval is opted INTO rather than inherited.
   */
  readonly pendingFiles?: FixtureFile[];
  /**
   * The endpoint half (`sync-config.json`), relative to the CONFIG root — a
   * different OPFS directory from the vault (`app_config_dir`, device-scoped and
   * vault-independent).
   */
  readonly configFiles?: FixtureFile[];
}

/**
 * The OPFS path the web client keeps its device-scoped config under, the
 * counterpart to {@link VAULT_ROOT}.
 *
 * A constant for the same reason: `WebHost::app_config_dir` is fixed.
 */
export const CONFIG_ROOT = "myne-config";

export function loadVaultFixture(
  path = join("e2e-web", "fixtures", "unlockable-vault.json"),
): VaultFixture {
  const v = JSON.parse(readFileSync(path, "utf8")) as VaultFixture;
  if (!v.files?.length || !v.password) {
    throw new Error(
      `${path} is not a usable vault fixture. Re-emit with:\n` +
        `  cargo run --release -p myne-core --features test-support --example emit-vault-fixture > ${path}`,
    );
  }
  return v;
}

/** Seed an unlockable vault. Same writer as the crash fixtures — one path into
 *  OPFS, so a bug in it fails both rather than hiding in one. */
export async function seedVault(session: Session, v: VaultFixture): Promise<void> {
  await seedFiles(session, VAULT_ROOT, v.files, "unlockable-vault");
}

/**
 * Seed a vault whose device enrolled but is **awaiting approval** (MYND-635).
 *
 * The state is a triple the client reads from disk: a device identity
 * persisted, an endpoint configured, and **no token**. `sync_status` derives
 * `pending` from exactly that, which is what boot routing consults — so this is
 * how a lane with no sync server reproduces the state at all.
 *
 * The absent token is a positive part of the fixture, not an omission. Writing
 * one would describe an APPROVED device, and the scenario would pass while
 * testing nothing.
 *
 * The two extra arrays land in different OPFS roots (`sync-state.json` beside
 * the vault, `sync-config.json` under the config dir), which is why this cannot
 * be one `seedFiles` call.
 */
export async function seedPendingVault(session: Session, v: VaultFixture): Promise<void> {
  if (!v.pendingFiles?.length || !v.configFiles?.length) {
    throw new Error(
      "the vault fixture carries no pending state. Re-emit with:\n" +
        "  cargo run --release -p myne-core --features test-support --example emit-vault-fixture " +
        "> e2e-web/fixtures/unlockable-vault.json",
    );
  }
  // The vault root gets meta AND identity in one clearing write — `seedFiles`
  // wipes its root first, so two calls against the same root would leave only
  // the second.
  await seedFiles(
    session,
    VAULT_ROOT,
    [...v.files, ...v.pendingFiles],
    "unlockable-vault (pending)",
  );
  await seedFiles(session, CONFIG_ROOT, v.configFiles, "sync-config");
}

/** Write `files` under `root`, clearing `root` first. The shared body of both
 *  seeders — see `seedFixture` and `seedVault`. */
async function seedFiles(
  session: Session,
  root: string,
  fileList: FixtureFile[],
  label: string,
): Promise<void> {
  const f = { name: label, files: fileList };
  const files = f.files.map((file) => ({ name: file.name, bytes: file.bytes }));
  const wrote = await session.executeAsync<{ ok: true; wrote: string[] } | { ok: false; error: string }>(
    `
    const done = arguments[arguments.length - 1];
    const root = arguments[0];
    const files = arguments[1];
    (async () => {
      try {
        const opfs = await navigator.storage.getDirectory();
        // Resolve (creating) each path segment, so a fixture can name a file in
        // a directory the browser has never seen.
        async function dirFor(path) {
          const parts = path.split("/");
          const fileName = parts.pop();
          let dir = opfs;
          for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
          return [dir, fileName];
        }
        // Clear the vault root first: a fixture describes the WHOLE state, so a
        // slot left behind by a previous scenario would make this one read a
        // container NEITHER fixture describes — the hardest kind of false
        // result to attribute.
        {
          const parts = root.split("/");
          const last = parts.pop();
          let parent = opfs;
          let reachable = true;
          for (const p of parts) {
            try {
              parent = await parent.getDirectoryHandle(p);
            } catch {
              reachable = false; // nothing seeded yet — nothing to clear
              break;
            }
          }
          if (reachable) await parent.removeEntry(last, { recursive: true }).catch(() => {});
        }

        const wrote = [];
        for (const f of files) {
          const [dir, name] = await dirFor(root + "/" + f.name);
          const handle = await dir.getFileHandle(name, { create: true });
          const w = await handle.createWritable();
          await w.write(new Uint8Array(f.bytes));
          await w.close();
          wrote.push(f.name);
        }
        done({ ok: true, wrote });
      } catch (e) {
        done({ ok: false, error: String((e && e.stack) || e) });
      }
    })();
    `,
    [root, files],
  );
  if (!wrote.ok) throw new Error(`seeding ${f.name} failed: ${wrote.error}`);
  if (wrote.wrote.length !== f.files.length) {
    throw new Error(
      `seeded ${wrote.wrote.length} of ${f.files.length} files for ${f.name} — a partial seed ` +
        `describes a container the fixture does not`,
    );
  }
}

/** Read back what is under the vault root, as `name → bytes`. The scenarios use
 *  it to assert the seed landed; a seeder nobody verifies is a seeder that can
 *  silently write nothing. */
export async function readVaultRoot(session: Session): Promise<Record<string, number[]>> {
  return session.executeAsync<Record<string, number[]>>(
    `
    const done = arguments[arguments.length - 1];
    const root = arguments[0];
    (async () => {
      const opfs = await navigator.storage.getDirectory();
      let dir = opfs;
      try {
        for (const p of root.split("/")) dir = await dir.getDirectoryHandle(p);
      } catch { done({}); return; }
      const out = {};
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== "file") continue;
        const buf = await (await h.getFile()).arrayBuffer();
        out[name] = Array.from(new Uint8Array(buf));
      }
      done(out);
    })();
    `,
    [VAULT_ROOT],
  );
}
