// MYND-124 — vault-creation flow scenarios (e2e-vault-creation).
//
// Creation is the highest-stakes onboarding flow: it mints the only
// credentials that can ever open the vault. VC-1 runs the ONE live
// full-production-KDF creation of the epic and doubles as the
// realistic-fixture capture (SYNC-2). Vault-count preconditions are
// declared per scenario (SYNC-6).
//
// SYNC-13: assertion shapes never print credentials; the scraped
// phrase/password land only in the gitignored fixture artifact.

import { expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import {
  dismissImporterOffer,
  pageSeatInvoke,
  selectPickerRow,
  switchToVault,
  unlockToEditor,
  waitForBannerText,
} from "./support/flows";
import { seedVault, vaultMetaPath, type SeededVault } from "./support/fixtures";
import { saveRealisticFixture } from "./support/realistic-fixture";
import { scanForPlaintext } from "./support/plaintext-scan";
import { testIdSelector, type Session } from "./support/webdriver";

const VC1_PASSWORD = "Tk9#mQ4!wX7&zR2p-vc1";
/** 11 chars — under the 12-char protocol floor AND zxcvbn-weak. */
const WEAK_PASSWORD = "weakweak123";

/** Crockford base32 (no I/L/O/U) — `account-number.md` §3 display form:
 *  `MY-` + five dash-separated 4-char groups (27 chars total). */
const ACCOUNT_DISPLAY_RE = /^MY(-[0-9A-HJKMNP-TV-Z]{4}){5}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The name typed on the flow's first step (myne-md/myne#468). Deliberately
 *  not a plain ASCII word: the value is written as the vault's label through
 *  `prefs|vault_set_label` after the auto-unlock, and it is the header of the
 *  recovery kit and of the file the kit saves. */
const VC_VAULT_NAME = "E2E Kasa";

/** Step over the vault-name step, which is the flow's first screen since
 *  myne-md/myne#468 (pre-KDF, so this spends no Argon2id). */
async function nameVaultStep(session: Session, name = VC_VAULT_NAME): Promise<void> {
  await (await session.byTestId("create.name-input", { timeoutMs: 15_000 })).sendKeys(name);
  await (await session.byTestId("create.name-continue")).click();
  await session.byTestId("create.password-input", { timeoutMs: 10_000 });
}

/** Fill + submit the password step and wait for the recovery kit — i.e.
 *  run ONE production-Argon2id `begin`. The session is live afterwards
 *  (kit step mounted). */
async function submitPasswordStep(session: Session, password: string): Promise<void> {
  await (await session.byTestId("create.password-input")).sendKeys(password);
  await (await session.byTestId("create.confirm-input")).sendKeys(password);
  const submit = await session.byTestId("create.submit");
  await session.waitUntil(() => submit.enabled(), {
    label: "password submit enabled",
    timeoutMs: 15_000,
  });
  await submit.click();
  await session.byTestId("create.phrase-grid", { timeoutMs: 120_000 });
}

/** Traverse the first-run safety briefing (MYND-114): tick all three
 *  acknowledgements and continue to the password step. Pre-KDF — the
 *  briefing sits ahead of `begin`, so this spends no Argon2id. Only the
 *  welcome (first-run) entry shows it; picker/switcher creates skip it.
 *
 *  Lands on the NAME step, which is what follows the briefing since
 *  myne-md/myne#468, and walks it, so every caller reaches the password step
 *  exactly as it did before. */
async function acknowledgeBriefing(session: Session): Promise<void> {
  await session.byTestId("create.briefing", { timeoutMs: 15_000 });
  const cont = await session.byTestId("create.briefing-continue");
  expect(await cont.enabled()).toBe(false); // gated until all three ticked
  const acks = await session.byTestIdAll("create.briefing-ack");
  expect(acks.length).toBe(3);
  for (const ack of acks) {
    await ack.click();
  }
  await session.waitUntil(() => cont.enabled(), {
    label: "briefing continue enabled (3/3 acknowledged)",
    timeoutMs: 10_000,
  });
  await cont.click();
  await nameVaultStep(session);
}

/** Scrape the 24 revealed phrase words in data-index order (single
 *  in-page pass — 1 round-trip instead of 48). The word is the LAST
 *  span of each cell (the first is the index numeral). */
async function scrapePhrase(session: Session): Promise<string[]> {
  const words = await session.execute<string[]>(
    "var words = [];" +
      "for (var i = 1; i <= 24; i++) {" +
      "  var el = document.querySelector(" +
      "    '[data-testid=\"create.phrase-word\"][data-index=\"' + i + '\"] span:last-child');" +
      "  words.push(el ? el.textContent || '' : '');" +
      "}" +
      "return words;",
  );
  // Shape-only check (SYNC-13: never print the words themselves).
  expect(words.length).toBe(24);
  expect(words.every((w) => w.length > 0)).toBe(true);
  return words;
}

/** Fill the 4-of-24 confirm challenge: each input declares its 1-based
 *  position via data-index; type that word from the scraped phrase. */
async function fillConfirmChallenge(session: Session, words: string[]): Promise<void> {
  const cells = await session.byTestIdAll("create.confirm-input");
  // Length-only compare (SYNC-13 shape; 4 cells by §2.3 challenge design).
  expect(cells.length).toBe(4);
  for (const cell of cells) {
    const pos = Number(await cell.attribute("data-index"));
    expect(pos).toBeGreaterThanOrEqual(1);
    expect(pos).toBeLessThanOrEqual(24);
    await cell.sendKeys(words[pos - 1]);
  }
}

describeE2E("VC-1 creation happy path at production KDF (MYND-124 task 1)", () => {
  it("creates a vault end-to-end, lands in the editor, captures the realistic fixture", async () => {
    // Vault-count precondition: 0. Full production KDF — creation params
    // are pinned in the binary (SYNC-9: no weak-KDF shortcut exists for
    // creation, by design).
    await scenario("vc1-happy-path", {}, async (app) => {
      // Welcome → create → first-run safety briefing (MYND-114) → password.
      await (await app.session.byTestId("welcome.create-cta", { timeoutMs: 20_000 })).click();
      await acknowledgeBriefing(app.session);

      // Password step — zxcvbn gate first (story 1): a matching but
      // weak/short password keeps Continue disabled.
      const pwInput = await app.session.byTestId("create.password-input");
      const confirmInput = await app.session.byTestId("create.confirm-input");
      const submit = await app.session.byTestId("create.submit");
      await pwInput.sendKeys(WEAK_PASSWORD);
      await confirmInput.sendKeys(WEAK_PASSWORD);
      expect(await submit.enabled()).toBe(false);

      // Strong password → gate opens (zxcvbn evaluates async — poll).
      // replaceText, NOT clear(): W3C clear bypasses React's value
      // tracker on the Input primitive — a silent no-op here would
      // seal the vault under the CONCATENATED weak+strong string and
      // poison the captured fixture (found the hard way: VU-1 red).
      await pwInput.replaceText(VC1_PASSWORD);
      await confirmInput.replaceText(VC1_PASSWORD);
      await app.session.waitUntil(() => submit.enabled(), {
        label: "password submit enabled (zxcvbn ≥3)",
        timeoutMs: 15_000,
      });
      await submit.click();

      // BEGIN runs the production Argon2id pair — budget generously.
      const grid = await app.session.byTestId("create.phrase-grid", { timeoutMs: 120_000 });
      expect(await grid.attribute("data-revealed")).toBe("false");

      // The kit shows the account number BESIDE the phrase, in the same sheet,
      // which is the merge this flow gained (myne-md/myne#468). 27-char §3
      // display form. Asserted here rather than one step later because there is
      // no later step to assert it on.
      await app.session.byTestId("create.kit-sheet", { timeoutMs: 10_000 });
      const accountEl = await app.session.byTestId("create.account-number", {
        timeoutMs: 10_000,
      });
      const account = (await accountEl.text()).trim();
      expect(account).toHaveLength(27);
      expect(ACCOUNT_DISPLAY_RE.test(account)).toBe(true);
      // The vault's own name heads its kit, which is half of why the name step
      // exists. Its other half — the label reaching `vault.prefs` — is asserted
      // after the unlock, further down.
      //
      // Polled through `textContent()`, NOT read once with `text()`. A one-shot
      // `GET /text` on a node the render tree has only just received can answer
      // `""` while the DOM is already correct (the trap `waitForBannerText`'s
      // header documents, measured on a just-inserted banner), and `kit-meta` is
      // exactly that case: it mounts with the kit sheet.
      await app.session.waitUntil(
        async () => {
          const el = await app.session.byTestId("create.kit-meta");
          const text = (await el.textContent()) ?? "";
          return text.includes(VC_VAULT_NAME) ? true : null;
        },
        { label: "the kit names the vault", timeoutMs: 15_000 },
      );

      // Reveal + scrape the 24 words (the fixture's ONLY capture point —
      // the phrase is never re-displayed).
      await (await app.session.byTestId("create.phrase-reveal")).click();
      await app.session.waitUntil(
        async () => (await grid.attribute("data-revealed")) === "true" || null,
        { label: "phrase revealed", timeoutMs: 10_000 },
      );
      const words = await scrapePhrase(app.session);
      await (await app.session.byTestId("create.phrase-continue")).click();

      // 4-of-24 type-back confirm.
      await app.session.byTestId("create.confirm-input", { timeoutMs: 10_000 });
      await fillConfirmChallenge(app.session, words);
      const confirmContinue = await app.session.byTestId("create.confirm-continue");
      await app.session.waitUntil(() => confirmContinue.enabled(), {
        label: "confirm continue enabled (4/4 match)",
        timeoutMs: 10_000,
      });
      // This click COMMITS: the confirm step is the last one now
      // (myne-md/myne#468 — the account number moved back into the recovery kit
      // and its acknowledgement checkbox was deleted rather than moved, because
      // `protocol.md` §7.1.3 says a bare checkbox is not evidence and the
      // type-back this button is gated on already is).
      await confirmContinue.click();

      // Ready step. Do NOT click "Show vault folder" (MYND-219 pending —
      // it still opens the legacy `vault/` path).
      const done = await app.session.byTestId("create.ready-done", { timeoutMs: 60_000 });

      // Disk contract BEFORE Done (commit already wrote the layout):
      // hard-assert the canonical meta; soft-check optional siblings.
      const vaultsDir = join(app.appDataDir, "vaults");
      const ids = readdirSync(vaultsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      expect(ids).toHaveLength(1);
      const vaultId = ids[0];
      expect(UUID_RE.test(vaultId)).toBe(true);
      const metaPath = join(vaultsDir, vaultId, "vault.meta");
      const metaBytes = readFileSync(metaPath);
      expect(metaBytes).toHaveLength(345);
      // `NTV5`, not `MYV1`: a vault created today is born v0.2
      // (`decisions.md` 2026-08-13 — the birth-format entry; `protocol.md`
      // §10.3.1). The layout is the same 345 bytes; only bytes 0..5 differ.
      // This assertion IS the birth format's end-to-end proof — it runs against
      // the production binary through the real creation UI, so nothing about it
      // is mocked or seeded.
      expect(metaBytes.subarray(0, 4).toString("latin1")).toBe("NTV5");

      // Soft checks: format-verified when present, warned when absent
      // (these artifacts are creation-version-dependent).
      // The two singletons the creation path seeds eagerly carry the SAME
      // generation as the meta above — `MYP5`/`MYC5`, not `MYP1`/`MYC1`. A
      // mismatch here is the hybrid-vault shape §10.3.1 forbids, and it is
      // invisible at runtime because every decoder detects its own magic.
      const soft: Array<[string, (buf: Buffer) => boolean]> = [
        ["vault.prefs", (b) => b.subarray(0, 4).toString("latin1") === "MYP5"],
        ["vault.attachments", (b) => b.subarray(0, 4).toString("latin1") === "MYC5"],
      ];
      for (const [name, check] of soft) {
        const p = join(vaultsDir, vaultId, name);
        if (existsSync(p)) {
          expect(check(readFileSync(p))).toBe(true);
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[vc1] soft disk-check: ${name} absent (accepted)`);
        }
      }
      // Registry is a LAZY cache (SYNC-10: the disk-scan is the
      // authority; the file rebuilds on the next vault_list). At this
      // point it may predate the commit, so the soft check is FORMAT
      // only — membership is asserted by the boot-routing suite.
      const registryPath = join(vaultsDir, "registry.json");
      if (existsSync(registryPath)) {
        const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
          version: number;
          vaults: unknown;
        };
        expect(registry.version).toBe(1);
        expect(Array.isArray(registry.vaults)).toBe(true);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[vc1] soft disk-check: registry.json absent (accepted)");
      }

      // Done → auto-unlock chain (production Argon2id again) → editor.
      await done.click();
      await app.session.byTestId("editor.root", { timeoutMs: 120_000 });

      // Capture the epic's realistic fixture (credentials + meta bytes)
      // BEFORE teardown removes the data dir.
      saveRealisticFixture(
        { vaultId, password: VC1_PASSWORD, phrase: words.join(" "), account },
        metaBytes,
      );

      // Plaintext-never-on-disk: neither credential persisted anywhere
      // under the session's filesystem surface (needle indices only).
      const hits = scanForPlaintext(app.dataHome, [words.join(" "), VC1_PASSWORD]);
      expect(hits).toEqual([]);

      // #393 — a freshly-created vault is seeded with a small EXAMPLE VAULT:
      // five ordinary notes under one "Getting started" folder, with the index
      // note ("Start here") auto-opened in the editor via the pre-seeded
      // workspace descriptor. A vault with no seed would show zero folders AND
      // zero tabs, so the folder's presence plus a note tab opened on the index
      // proves the whole chain: created → foldered → listed → restored open.
      // (Lives on VC-1 — the epic's one production-KDF creation that lands in
      // the editor — rather than a second multi-minute creation.)
      await dismissImporterOffer(app.session);
      // The example folder is in the tree (its label is the frontmatter `folder:`).
      const exampleFolder = await app.session.byTestId("notes.folder-row", {
        timeoutMs: 15_000,
      });
      expect(await exampleFolder.textContent()).toContain("Getting started");
      // A note tab is open — the index note, keyed `note:<id>` in `data-tab-id`
      // (Saved Views #4 generalized tabs to `note | view` items). Its title is
      // frontmatter-`title:` driven (no body-H1 fallback), so it reads
      // "Start here", never the "Untitled" placeholder.
      const indexTab = await app.session.byTestId("editor.tab", { timeoutMs: 15_000 });
      expect(await indexTab.attribute("data-tab-id")).toMatch(/^note:/);
      expect(await indexTab.textContent()).toContain("Start here");
    });
  });
});

describeE2E("VC-2 confirm gating + VC-3 blur cover (MYND-124 task 2)", () => {
  it("wrong word gates Continue per-cell; NFKD/case-folded input matches; cover re-arms only via Reveal", async () => {
    // Vault-count precondition: 0. ONE creation session past `begin`
    // (single production-Argon2id spend) chains both scenarios.
    await scenario("vc2-vc3-confirm-and-cover", {}, async (app) => {
      // Reach the phrase step.
      await (await app.session.byTestId("welcome.create-cta", { timeoutMs: 20_000 })).click();
      await acknowledgeBriefing(app.session);
      await (await app.session.byTestId("create.password-input")).sendKeys(VC1_PASSWORD);
      await (await app.session.byTestId("create.confirm-input")).sendKeys(VC1_PASSWORD);
      const submit = await app.session.byTestId("create.submit");
      await app.session.waitUntil(() => submit.enabled(), {
        label: "password submit enabled",
        timeoutMs: 15_000,
      });
      await submit.click();
      await app.session.byTestId("create.phrase-grid", { timeoutMs: 120_000 });
      await (await app.session.byTestId("create.phrase-reveal")).click();
      const words = await scrapePhrase(app.session);
      await (await app.session.byTestId("create.phrase-continue")).click();

      // ── VC-2: per-cell mismatch gating on the confirm step ──
      await app.session.byTestId("create.confirm-input", { timeoutMs: 10_000 });
      const cells = await app.session.byTestIdAll("create.confirm-input");
      expect(cells.length).toBe(4);
      const firstPos = Number(await cells[0].attribute("data-index"));

      // Wrong word (not in any BIP-39 list) → the per-cell error with
      // its position-addressed literal copy + Continue disabled.
      await cells[0].sendKeys("zzzzzz");
      const cellError = await app.session.waitForElement(
        testIdSelector("create.confirm-error", { "data-index": String(firstPos) }),
      );
      expect(await cellError.text()).toBe(`Doesn't match word ${firstPos}.`);
      const confirmContinue = await app.session.byTestId("create.confirm-continue");
      expect(await confirmContinue.enabled()).toBe(false);

      // No autocomplete/typeahead surface on confirm cells (§2.3: the
      // type-back must PROVE recall, not assist it).
      for (const cell of cells) {
        expect(await cell.attribute("autocomplete")).toBe("off");
        expect(await cell.attribute("spellcheck")).toBe("false");
        expect(await cell.attribute("list")).toBeNull();
      }
      expect(await app.session.findElements("[role='listbox'], datalist")).toHaveLength(0);

      // Correct the cell with UPPERCASE input — `normalizeWord` (NFKD +
      // case-fold) must accept it; error clears. (`replaceText`: W3C
      // clear bypasses React's value tracker on the Input primitive.)
      await cells[0].replaceText(words[firstPos - 1].toUpperCase());
      await app.session.waitForGone(
        testIdSelector("create.confirm-error", { "data-index": String(firstPos) }),
      );

      // Fill the remaining three correctly → Continue arms.
      for (const cell of cells.slice(1)) {
        const pos = Number(await cell.attribute("data-index"));
        await cell.sendKeys(words[pos - 1]);
      }
      await app.session.waitUntil(() => confirmContinue.enabled(), {
        label: "confirm continue enabled (4/4 match)",
        timeoutMs: 10_000,
      });

      // ── VC-3: blur cover on the phrase step (walk-away guard) ──
      // CONFIRM_BACK remounts PhraseStep — re-fetch the grid handle
      // (the pre-confirm one is a stale element reference).
      await (await app.session.byTestId("create.confirm-back")).click();
      const gridBack = await app.session.byTestId("create.phrase-grid", { timeoutMs: 10_000 });

      // Ensure revealed, then blur the window: the cover must drop.
      if ((await gridBack.attribute("data-revealed")) !== "true") {
        await (await app.session.byTestId("create.phrase-reveal")).click();
        await app.session.waitUntil(
          async () => (await gridBack.attribute("data-revealed")) === "true" || null,
          { label: "phrase revealed pre-blur", timeoutMs: 10_000 },
        );
      }
      // The production listener is `window.addEventListener("blur")` —
      // fire the same event the OS does on Cmd-Tab (no hook; DOM-level).
      await app.session.execute("window.dispatchEvent(new Event('blur'))");
      await app.session.waitUntil(
        async () => (await gridBack.attribute("data-revealed")) === "false" || null,
        { label: "cover dropped on blur", timeoutMs: 10_000 },
      );

      // Refocus does NOT restore — §2.2: re-reveal is explicit only.
      await app.session.execute("window.dispatchEvent(new Event('focus'))");
      expect(await gridBack.attribute("data-revealed")).toBe("false");

      // Explicit Reveal restores.
      await (await app.session.byTestId("create.phrase-reveal")).click();
      await app.session.waitUntil(
        async () => (await gridBack.attribute("data-revealed")) === "true" || null,
        { label: "re-revealed via button", timeoutMs: 10_000 },
      );
    });
  });
});

describeE2E("VC-4 back-navigation matrix (MYND-124 task 3, post-MYND-219)", () => {
  /** Drive Welcome → password → begin → revealed phrase; returns the
   *  scraped words. One production-Argon2id spend per call. */
  async function reachPhraseStep(session: Session): Promise<string[]> {
    await submitPasswordStep(session, VC1_PASSWORD);
    await (await session.byTestId("create.phrase-reveal")).click();
    return scrapePhrase(session);
  }

  it("Confirm↔Kit preserves state; ReadyStep is forward-only", async () => {
    // Vault-count precondition: 0. One begin chains arms 1+2+3.
    await scenario("vc4-mid-flow-backs", {}, async (app) => {
      await (await app.session.byTestId("welcome.create-cta", { timeoutMs: 20_000 })).click();
      await acknowledgeBriefing(app.session);
      const words = await reachPhraseStep(app.session);
      await (await app.session.byTestId("create.phrase-continue")).click();

      // Type ONE correct word, note its position…
      await app.session.byTestId("create.confirm-input", { timeoutMs: 10_000 });
      const cells = await app.session.byTestIdAll("create.confirm-input");
      const positionsBefore: number[] = [];
      for (const cell of cells) {
        positionsBefore.push(Number(await cell.attribute("data-index")));
      }
      await cells[0].sendKeys(words[positionsBefore[0] - 1]);

      // …Back to Phrase, Forward again: positions stable across
      // CONFIRM_BACK and the typed input preserved (arm 1).
      await (await app.session.byTestId("create.confirm-back")).click();
      await app.session.byTestId("create.phrase-grid", { timeoutMs: 10_000 });
      await (await app.session.byTestId("create.phrase-continue")).click();
      const cellsAfter = await app.session.waitUntil(
        async () => {
          const found = await app.session.byTestIdAll("create.confirm-input");
          return found.length === 4 ? found : null;
        },
        { label: "confirm cells remounted", timeoutMs: 10_000 },
      );
      const positionsAfter: number[] = [];
      for (const cell of cellsAfter) {
        positionsAfter.push(Number(await cell.attribute("data-index")));
      }
      expect(positionsAfter).toEqual(positionsBefore);
      expect(await cellsAfter[0].property<string>("value")).toBe(
        words[positionsBefore[0] - 1],
      );

      // Fill the rest. Arm 2 used to be Account→Confirm returning
      // already-passed; there is no account step to come back FROM since
      // myne-md/myne#468, so what replaces it is the second half of arm 1: a
      // round trip to the kit and back must leave the challenge already passed,
      // with Continue enabled and nothing retyped.
      for (const cell of cellsAfter.slice(1)) {
        const pos = Number(await cell.attribute("data-index"));
        await cell.sendKeys(words[pos - 1]);
      }
      const confirmContinue = await app.session.byTestId("create.confirm-continue");
      await app.session.waitUntil(() => confirmContinue.enabled(), {
        label: "confirm continue enabled",
        timeoutMs: 10_000,
      });
      await (await app.session.byTestId("create.confirm-back")).click();
      await app.session.byTestId("create.phrase-grid", { timeoutMs: 10_000 });
      await (await app.session.byTestId("create.phrase-continue")).click();
      const continueBack = await app.session.byTestId("create.confirm-continue", {
        timeoutMs: 10_000,
      });
      await app.session.waitUntil(() => continueBack.enabled(), {
        label: "confirm continue still enabled after a kit round trip",
        timeoutMs: 10_000,
      });

      // Forward to Ready: no Back affordance anywhere (arm 3). One click, because
      // this control is the commit as well as the Continue.
      await continueBack.click();
      await app.session.byTestId("create.ready-done", { timeoutMs: 60_000 });
      for (const backId of [
        "create.confirm-back",
        "create.phrase-back",
        "create.secondary",
      ]) {
        expect(await app.session.byTestIdAll(backId)).toHaveLength(0);
      }
    });
  });

  it("Back-from-Phrase is a clean restart; Back-from-password steps back to the name step", async () => {
    // Vault-count precondition: 0. Two begins (the restart proof needs a
    // fresh begin to succeed — arm 4b).
    await scenario("vc4-clean-restart", {}, async (app) => {
      await (await app.session.byTestId("welcome.create-cta", { timeoutMs: 20_000 })).click();
      await acknowledgeBriefing(app.session);
      await reachPhraseStep(app.session);

      // Arm 4: Back from Phrase cancels the backend session and lands
      // on an EMPTY password form (password non-survival).
      await (await app.session.byTestId("create.phrase-back")).click();
      const pwInput = await app.session.byTestId("create.password-input", { timeoutMs: 10_000 });
      expect(await pwInput.property<string>("value")).toBe("");
      expect(await (await app.session.byTestId("create.confirm-input")).property<string>("value")).toBe("");
      expect(await (await app.session.byTestId("create.submit")).enabled()).toBe(false);

      // Arm 4b: a FRESH begin succeeds (no stale session blocks it).
      await reachPhraseStep(app.session);
      await (await app.session.byTestId("create.phrase-back")).click();
      await app.session.byTestId("create.password-input", { timeoutMs: 10_000 });

      // Arm 6: Back from the password step (entered from Welcome) → the NAME
      // step, one back-step rather than an exit, which is what myne-md/myne#468
      // made it ("One step BACK, to the vault-name step — not out of the flow"),
      // with the typed name kept. Then Back again → Welcome (MYND-219 reprobe:
      // 0 vaults on disk, so the entry surface is the welcome screen).
      await (await app.session.byTestId("create.secondary")).click();
      const backAtName = await app.session.byTestId("create.name-input", { timeoutMs: 15_000 });
      expect(
        await backAtName.property<string>("value"),
        "the back-step must keep the name the user already typed",
      ).toBe(VC_VAULT_NAME);
      await (await app.session.byTestId("create.name-back")).click();
      await app.session.byTestId("welcome.root", { timeoutMs: 15_000 });
    });
  });

  it("create entered from the picker returns to the picker on Back (MYND-219 reprobe)", async () => {
    // Vault-count precondition: 2 (weak KDF; Back fires BEFORE begin —
    // no Argon2id spend).
    await scenario(
      "vc4-back-to-picker",
      {
        seed: (appDataDir) => {
          seedVault(appDataDir, { password: "e2e-vc4-vault-a-pw" });
          seedVault(appDataDir, { password: "e2e-vc4-vault-b-pw" });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await (await app.session.byTestId("picker.create-cta")).click();
        // The NAME step first, on every entry (myne-md/myne#468): only the
        // safety briefing is first-run-only, so "create another" lands on the
        // name step and this walk reaches the password step.
        await nameVaultStep(app.session);

        // First-run-only scoping (MYND-114): the picker "create another"
        // entry shows NO safety briefing (a returning user has acknowledged
        // the recovery model once).
        expect(await app.session.byTestIdAll("create.briefing")).toHaveLength(0);

        // Arm 5: Back from the password step → the NAME step, which is the
        // back-step myne-md/myne#468 gave it ("One step BACK, to the vault-name
        // step — not out of the flow"), and then Back again → the entry surface,
        // which here is the picker (the pre-MYND-219 behavior stranded this path
        // on Welcome). Asserted in two hops rather than one, because a single
        // click that left creation entirely would satisfy the old form and
        // report nothing about the name step's existence.
        await (await app.session.byTestId("create.secondary")).click();
        await app.session.byTestId("create.name-input", { timeoutMs: 15_000 });
        await (await app.session.byTestId("create.name-back")).click();
        await app.session.byTestId("picker.root", { timeoutMs: 15_000 });
      },
    );
  });
});

/** Drive password → recovery kit → confirm (which commits) → ReadyStep through
 *  the real UI (one production begin). Caller decides what to do at Ready. */
async function createToReadyStep(session: Session, password: string): Promise<void> {
  await submitPasswordStep(session, password);
  await (await session.byTestId("create.phrase-reveal")).click();
  const words = await scrapePhrase(session);
  await (await session.byTestId("create.phrase-continue")).click();
  await session.byTestId("create.confirm-input", { timeoutMs: 10_000 });
  await fillConfirmChallenge(session, words);
  const confirmContinue = await session.byTestId("create.confirm-continue");
  await session.waitUntil(() => confirmContinue.enabled(), {
    label: "confirm continue enabled",
    timeoutMs: 10_000,
  });
  await confirmContinue.click();
  await session.byTestId("create.ready-done", { timeoutMs: 60_000 });
}

describeE2E("VC-5 VaultArtifactsPresent guard + same-token retry (MYND-124 task 4)", () => {
  it("override-commit at an existing vault fails closed; the restored session then commits normally", async () => {
    // Vault-count precondition: 2 (entry surface = picker; vault A is
    // the guard's collision target).
    let a!: SeededVault;
    await scenario(
      "vc5-artifacts-guard",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: "e2e-vc5-vault-a-pw" });
          seedVault(appDataDir, { password: "e2e-vc5-vault-b-pw" });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });

        // Run a REAL `begin` from the page seat (the production IPC
        // entry point — `__TAURI_INTERNALS__.invoke` is what the
        // bundled API calls; zero production change, SYNC-3 is a
        // production-code policy). The UI stays on the picker — the
        // backend session is what the guard contract is about.
        // Production Argon2id pair — budget generously.
        const begun = await pageSeatInvoke(
          app.session,
          "plugin:vault-creation|begin",
          { password: "e2e-vc5-new-vault-pw" },
          120_000,
        );
        expect(begun.err).toBeUndefined();
        const token = (begun.ok as { session_token: string }).session_token;

        // Guard trigger: the documented `vault_id` override escape
        // hatch pointed at EXISTING vault A.
        const metaBefore = readFileSync(vaultMetaPath(app.appDataDir, a.vaultId));
        const guarded = await pageSeatInvoke(
          app.session,
          "plugin:vault-creation|commit",
          { vaultId: a.vaultId, sessionToken: token },
          30_000,
        );
        expect(guarded.err).toEqual({ kind: "VaultArtifactsPresent" });

        // Non-destructive: A's bytes are byte-identical.
        expect(readFileSync(vaultMetaPath(app.appDataDir, a.vaultId)).equals(metaBefore)).toBe(
          true,
        );

        // Same-token retry WITHOUT the override: the restored session
        // commits to its own freshly-minted vaults/<id2>/.
        const retried = await pageSeatInvoke(
          app.session,
          "plugin:vault-creation|commit",
          { sessionToken: token },
          30_000,
        );
        expect(retried.err).toBeUndefined();
        const newId = retried.ok as string;
        expect(typeof newId).toBe("string");
        expect(newId).not.toBe(a.vaultId);
        expect(statSync(vaultMetaPath(app.appDataDir, newId)).size).toBe(345);
      },
    );
  });
});

describeE2E("VC-6 auto-unlock-failure fallback (MYND-124 task 5)", () => {
  it("Done with a vanished vault.meta lands on unlock targeting the just-created vault", async () => {
    // Vault-count precondition: 0 → 1 (the created vault).
    await scenario("vc6-auto-unlock-fallback", {}, async (app) => {
      await (await app.session.byTestId("welcome.create-cta", { timeoutMs: 20_000 })).click();
      await acknowledgeBriefing(app.session);
      await createToReadyStep(app.session, VC1_PASSWORD);

      // At-rest fault injection BEFORE Done: delete the just-committed
      // vault.meta so the chained auto-unlock rejects naturally.
      const ids = readdirSync(join(app.appDataDir, "vaults"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      expect(ids).toHaveLength(1);
      const createdId = ids[0];
      rmSync(vaultMetaPath(app.appDataDir, createdId));

      // Done → vault_unlock rejects → create-vault.commit-success
      // fallback → unlock(Exists) TARGETING the created vault (not the
      // sole-vault fallback).
      await (await app.session.byTestId("create.ready-done")).click();
      const form = await app.session.byTestId("unlock.form", { timeoutMs: 60_000 });
      expect(await form.attribute("data-vault-id")).toBe(createdId);

      // The targeted manual retry proves the address end-to-end: the
      // vault.meta is gone, so the unlock surfaces the VaultNotFound
      // banner (full literal) rather than a wrong-vault attempt.
      await (await app.session.byTestId("unlock.password-input")).sendKeys(VC1_PASSWORD);
      await (await app.session.byTestId("unlock.submit")).click();
      // Full-literal equality, POLLED (`waitForBannerText`): a one-shot
      // `GET /text` on a banner the render tree has just received can answer
      // `""` while the DOM already holds the copy (that helper's header records
      // the measurement), and the failure then reads as a wrong banner.
      await waitForBannerText(
        app.session,
        "unlock.error-banner",
        "Vault file not found. Please restart the app.",
      );
    });
  });
});

describeE2E("VC-9/VC-10 create-second-vault entries (MYND-124 task 6)", () => {
  const PASSWORD_A = "e2e-vc9-vault-a-pw";
  const PASSWORD_B = "e2e-vc9-vault-b-pw";
  const PASSWORD_NEW = "Tk9#mQ4!wX7&zR2p-vc9";

  it("picker entry: Create-another mints a fresh vault, no guard trip, prior vaults untouched", async () => {
    // Vault-count precondition: 2 → 3.
    let a!: SeededVault;
    await scenario(
      "vc9-picker-entry",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: PASSWORD_A });
          seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        const metaBefore = readFileSync(vaultMetaPath(app.appDataDir, a.vaultId));
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await (await app.session.byTestId("picker.create-cta")).click();
        // Name step first: only the briefing is first-run-only (myne-md/myne#468).
        await nameVaultStep(app.session);
        await createToReadyStep(app.session, PASSWORD_NEW);
        await (await app.session.byTestId("create.ready-done")).click();
        await app.session.byTestId("editor.root", { timeoutMs: 120_000 });

        // Fresh vaults/<id3>/ minted; no VaultArtifactsPresent trip
        // (we reached the editor); prior vault bytes untouched.
        const ids = readdirSync(join(app.appDataDir, "vaults"), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        expect(ids).toHaveLength(3);
        expect(readFileSync(vaultMetaPath(app.appDataDir, a.vaultId)).equals(metaBefore)).toBe(
          true,
        );
      },
    );
  });

  it("editor entry: Create-another locks the prior vault (sole-Unlocked) and lands in the new one", async () => {
    // Vault-count precondition: 2 → 3 (A unlocked at entry).
    let a!: SeededVault;
    await scenario(
      "vc10-editor-entry",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: PASSWORD_A });
          seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        // Unlock A from the picker.
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await selectPickerRow(app.session, a.vaultId);
        await unlockToEditor(app.session, PASSWORD_A);
        await dismissImporterOffer(app.session);

        // Account-chip → "Create another vault" → full create → editor
        // of the NEW vault (auto-unlock evicts A per SYNC-1).
        await (await app.session.byTestId("switcher.chip")).click();
        await (await app.session.byTestId("switcher.create-cta")).click();
        // Same name step as the picker entry (myne-md/myne#468).
        await nameVaultStep(app.session);
        await createToReadyStep(app.session, PASSWORD_NEW);
        await (await app.session.byTestId("create.ready-done")).click();
        await app.session.byTestId("editor.root", { timeoutMs: 120_000 });

        // Sole-Unlocked invariant: routing back to A re-challenges with
        // the password form (A was locked during the flow).
        await switchToVault(app.session, a.vaultId);
        const formA = await app.session.byTestId("unlock.form", { timeoutMs: 15_000 });
        expect(await formA.attribute("data-vault-id")).toBe(a.vaultId);
        await app.session.byTestId("unlock.password-input");
      },
    );
  });
});

describeE2E("MYND-114 first-run safety briefing (pre-vault-create contract)", () => {
  it("gates Continue on three acknowledgements, expands Why? inline, and Back returns to Welcome", async () => {
    // Vault-count precondition: 0. Entirely pre-KDF — the briefing sits
    // ahead of `begin`, so this scenario spends no Argon2id.
    await scenario("mynd114-safety-briefing", {}, async (app) => {
      // Welcome → create: the briefing gates the flow — no password yet.
      await (await app.session.byTestId("welcome.create-cta", { timeoutMs: 20_000 })).click();
      await app.session.byTestId("create.briefing", { timeoutMs: 15_000 });
      expect(await app.session.byTestIdAll("create.password-input")).toHaveLength(0);

      // Back → Welcome: the contract is declinable, not a trap.
      await (await app.session.byTestId("create.briefing-back")).click();
      await app.session.byTestId("welcome.root", { timeoutMs: 15_000 });

      // Re-enter: a fresh mount re-arms the gate (acknowledgements reset).
      await (await app.session.byTestId("welcome.create-cta")).click();
      await app.session.byTestId("create.briefing", { timeoutMs: 15_000 });
      const cont = await app.session.byTestId("create.briefing-continue");
      expect(await cont.enabled()).toBe(false);

      // "Why?" is opt-in: collapsed by default, expands inline, re-collapses.
      const why = (await app.session.byTestIdAll("create.briefing-why"))[1];
      const ackId = await why.attribute("data-ack-id");
      const whyText = testIdSelector("create.briefing-why-text", {
        "data-ack-id": ackId!,
      });
      expect(await why.attribute("aria-expanded")).toBe("false");
      expect(await app.session.findElements(whyText)).toHaveLength(0);
      await why.click();
      await app.session.waitForElement(whyText);
      expect(await why.attribute("aria-expanded")).toBe("true");
      await why.click();
      await app.session.waitForGone(whyText);

      // The gate opens only after ALL three are acknowledged — not before.
      const acks = await app.session.byTestIdAll("create.briefing-ack");
      expect(acks.length).toBe(3);
      await acks[0].click();
      expect(await cont.enabled()).toBe(false);
      await acks[1].click();
      expect(await cont.enabled()).toBe(false);
      await acks[2].click();
      await app.session.waitUntil(() => cont.enabled(), {
        label: "briefing continue enabled (3/3 acknowledged)",
        timeoutMs: 10_000,
      });

      // Continue → the NAME step, then the password step. Before myne-md/myne#468
      // the briefing was forward-only straight into the password; a name step
      // now sits between them, so the claim "Continue moves the flow on" is
      // asserted through the step that is actually next.
      await cont.click();
      await app.session.byTestId("create.name-input", { timeoutMs: 15_000 });
      await nameVaultStep(app.session);
    });
  });
});
