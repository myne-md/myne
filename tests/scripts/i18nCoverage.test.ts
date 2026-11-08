// Break tests for `scripts/check-i18n-coverage.mjs` (myne-md/myne#589).
//
// Root `AGENTS.md`: "Verifying a guard means breaking it, not running it. Inject
// the exact defect the guard now claims to catch, watch it name that defect,
// then restore." Running the guard on the real tree proves only that the real
// tree is currently clean, which is what the two documents this guard replaces
// already claimed while keys were missing from every catalog.
//
// `analyse(io)` takes its whole world as an argument, so every case below is a
// synthetic file set rather than a mutation of `locales/`: no `git restore`,
// no half-restored working copy, and the injections run on every commit.
//
// Four cases are the ones nobody thinks to try, and they are the reason the
// guard is shaped the way it is:
//
//   - a plural base the locale has NONE of must NOT fail. That is an
//     untranslated key, which is the normal state between an English string
//     landing and it being translated in-repo. A guard that failed there would block
//     every English copy edit, which is the trade `check-i18n.mjs` already
//     refused; the distinction between "no categories" and "some categories"
//     is what makes check 2 gate-able at all.
//   - a locale whose catalog carries a key English no longer has must not be
//     placeholder-checked against nothing. Fourteen of the shipped catalogs
//     carry 26 to 29 such orphans (`myne-agents/docs/decisions/storage/0411`), so treating
//     `undefined` as an empty placeholder set would fail the guard on every
//     run against the real tree.
//   - EVERY group in a locale losing the SAME category must still fail. That is
//     the case that distinguishes CLDR from the catalog's own majority, and the
//     first version of the guard reported ok on it while being wrong.
//   - an English COPY EDIT must NOT move the generated record. A `--check`
//     gate on a document that churns for edits its subject does not cover is
//     the failure root `AGENTS.md` records twin-inventory having shipped.

import { describe, expect, it } from "vitest";

import {
  CONFIG_PATH,
  EXTRACTOR_PATH,
  LOCALES_DIR,
  NAMESPACE,
  RECORD_PATH,
  analyse,
  gate,
} from "../../scripts/check-i18n-coverage.mjs";

type Files = Record<string, string>;
type Row = {
  code: string;
  translated: number;
  missing: number;
  coverage: string;
  categories: string;
  required: string;
};
type Result = {
  failures: string[];
  halted: boolean;
  rows: Row[];
  overall: string;
  complete: number;
  record: string;
};

const config = (codes: string[]) =>
  `export const SUPPORTED_LANGUAGES = [\n${codes
    .map((c) => `  { code: "${c}", label: "${c}" },`)
    .join("\n")}\n] as const;\n`;

const extractor = (codes: string[]) =>
  `export default defineConfig({\n  locales: [${codes.map((c) => `"${c}"`).join(",")}],\n});\n`;

const catalog = (obj: unknown) => `${JSON.stringify(obj, null, 2)}\n`;

/**
 * A file set that passes every rule, as the baseline each defect mutates.
 * `ru` deliberately carries TWO plural bases: with one, stripping a category
 * from it also strips it from the locale's own majority, so a modal-set check
 * would catch the break for the wrong reason and the test could not tell the
 * two designs apart.
 */
function healthy(): Files {
  return {
    [CONFIG_PATH]: config(["en", "tr", "ru"]),
    [EXTRACTOR_PATH]: extractor(["en", "tr", "ru"]),
    [`${LOCALES_DIR}/en/${NAMESPACE}`]: catalog({
      common: { save: "Save", moved: "Moved {{count}} note to {{folder}}" },
      notes: {
        count_one: "{{count}} note",
        count_other: "{{count}} notes",
        tag_one: "{{count}} tag",
        tag_other: "{{count}} tags",
      },
    }),
    [`${LOCALES_DIR}/tr/${NAMESPACE}`]: catalog({
      common: { save: "Kaydet", moved: "{{count}} not {{folder}} klasörüne taşındı" },
      notes: {
        count_one: "{{count}} not",
        count_other: "{{count}} not",
        tag_one: "{{count}} etiket",
        tag_other: "{{count}} etiket",
      },
    }),
    [`${LOCALES_DIR}/ru/${NAMESPACE}`]: catalog({
      common: { save: "Сохранить", moved: "{{count}} заметки перемещено в {{folder}}" },
      notes: {
        count_one: "{{count}} заметка",
        count_few: "{{count}} заметки",
        count_many: "{{count}} заметок",
        count_other: "{{count}} заметки",
        tag_one: "{{count}} метка",
        tag_few: "{{count}} метки",
        tag_many: "{{count}} меток",
        tag_other: "{{count}} метки",
      },
    }),
  };
}

function run(files: Files): Result {
  return analyse(io(files)) as Result;
}

const row = (r: Result, code: string) => r.rows.find((x) => x.code === code)!;

type Gate = { exitCode: number; emit: string | null; out: string[]; err: string[] };

const io = (files: Files) => ({
  readFile: (rel: string) => (rel in files ? files[rel] : null),
  localeDirs: () => [
    ...new Set(
      Object.keys(files)
        .filter((f) => f.startsWith(`${LOCALES_DIR}/`))
        .map((f) => f.split("/")[1]),
    ),
  ],
});

const runGate = (files: Files, argv: string[] = []): Gate => gate(io(files), argv) as Gate;

/** The file set plus a correct, current record, which is the tree's normal state. */
function withRecord(files: Files = healthy()): Files {
  return { ...files, [RECORD_PATH]: run(files).record };
}

/** Rewrite one dotted key inside one catalog; `undefined` deletes it. */
function patch(files: Files, code: string, dotted: string, value: string | undefined): Files {
  const path = `${LOCALES_DIR}/${code}/${NAMESPACE}`;
  const obj = JSON.parse(files[path]);
  const segs = dotted.split(".");
  let node = obj;
  for (const s of segs.slice(0, -1)) node = node[s];
  if (value === undefined) delete node[segs[segs.length - 1]];
  else node[segs[segs.length - 1]] = value;
  return { ...files, [path]: catalog(obj) };
}

/** A fourth locale, for the cases that need one beyond the baseline three. */
function withLocale(code: string, cat: unknown): Files {
  const files: Files = { ...healthy() };
  files[CONFIG_PATH] = config(["en", "tr", "ru", code]);
  files[EXTRACTOR_PATH] = extractor(["en", "tr", "ru", code]);
  files[`${LOCALES_DIR}/${code}/${NAMESPACE}`] = catalog(cat);
  return files;
}

const JA_CATALOG = {
  common: { save: "保存", moved: "{{count}} 件のノートを {{folder}} に移動しました" },
  notes: {
    count_one: "{{count}} 件",
    count_other: "{{count}} 件",
    tag_one: "{{count}} 個",
    tag_other: "{{count}} 個",
  },
};

describe("check-i18n-coverage: the healthy tree", () => {
  it("passes, and reports the coverage it measured", () => {
    const r = run(healthy());
    expect(r.failures).toEqual([]);
    expect(r.rows.map((x) => x.code)).toEqual(["ru", "tr"]);
    expect(r.complete).toBe(2);
    expect(r.overall).toBe("100.00");
  });

  it("reports the catalog's own categories and the CLDR set it is held to, separately", () => {
    const r = run(healthy());
    expect(row(r, "tr").categories).toBe("one/other");
    expect(row(r, "tr").required).toBe("one/other");
    expect(row(r, "ru").categories).toBe("one/few/many/other");
    expect(row(r, "ru").required).toBe("one/few/many/other");
  });
});

describe("check-i18n-coverage: check 1, roster parity across three files", () => {
  it("fails BY NAME when SUPPORTED_LANGUAGES has been renamed away", () => {
    const files: Files = { ...healthy() };
    files[CONFIG_PATH] = config(["en", "tr", "ru"]).replace("SUPPORTED_LANGUAGES", "LOCALES");
    const r = run(files);
    expect(r.halted).toBe(true);
    expect(r.failures.join("\n")).toMatch(/SUPPORTED_LANGUAGES not found/);
  });

  it("fails BY NAME when the config module is gone, instead of reporting ok on nothing", () => {
    const files: Files = { ...healthy() };
    delete files[CONFIG_PATH];
    const r = run(files);
    expect(r.halted).toBe(true);
    expect(r.failures.join("\n")).toMatch(/src\/i18n\/config\.ts is missing/);
  });

  it("fails BY NAME when the extractor config is gone", () => {
    const files: Files = { ...healthy() };
    delete files[EXTRACTOR_PATH];
    const r = run(files);
    expect(r.halted).toBe(true);
    expect(r.failures.join("\n")).toMatch(/i18next\.config\.js is missing/);
  });

  it("fails BY NAME when the extractor's `locales:` array has been renamed away", () => {
    const files: Files = { ...healthy() };
    files[EXTRACTOR_PATH] = extractor(["en", "tr", "ru"]).replace("locales:", "languages:");
    const r = run(files);
    expect(r.halted).toBe(true);
    expect(r.failures.join("\n")).toMatch(/No `locales:` array found/);
  });

  it("names a language the picker offers with no catalog on disk", () => {
    const files: Files = { ...healthy() };
    files[CONFIG_PATH] = config(["en", "tr", "ru", "de"]);
    files[EXTRACTOR_PATH] = extractor(["en", "tr", "ru", "de"]);
    const r = run(files);
    expect(r.failures.join("\n")).toMatch(/offered by the picker with no catalog on disk: de/);
  });

  it("names a catalog on disk the picker never offers", () => {
    const files: Files = { ...healthy() };
    files[`${LOCALES_DIR}/de/${NAMESPACE}`] = catalog({ common: { save: "Speichern" } });
    const r = run(files);
    expect(r.failures.join("\n")).toMatch(/SUPPORTED_LANGUAGES does not offer: de/);
  });

  // The third roster, and the failure it hides: `pnpm i18n:extract` writes new
  // keys only into the locales `i18next.config.js` lists, so a language missing
  // there stops receiving them while the picker keeps offering it. Nothing
  // errors; the coverage row simply decays with every English string added,
  // which is myne-md/myne#589's own shape one file over.
  it("names a language SUPPORTED_LANGUAGES offers that the extractor does not list", () => {
    const files: Files = { ...healthy() };
    files[EXTRACTOR_PATH] = extractor(["en", "tr"]);
    const r = run(files);
    expect(r.failures.join("\n")).toMatch(/i18next\.config\.js does not list: ru/);
  });

  it("names a language the extractor lists that the picker does not offer", () => {
    const files: Files = { ...healthy() };
    files[EXTRACTOR_PATH] = extractor(["en", "tr", "ru", "de"]);
    const r = run(files);
    expect(r.failures.join("\n")).toMatch(/SUPPORTED_LANGUAGES does not offer: de/);
  });

  it("names a roster with no source language, so the fallback is gone", () => {
    const files: Files = { ...healthy() };
    files[CONFIG_PATH] = config(["tr", "ru"]);
    const r = run(files);
    expect(r.failures.join("\n")).toMatch(/does not carry the source language/);
  });
});

describe("check-i18n-coverage: check 2, partial plural groups", () => {
  it("names the missing category when a group is half filled", () => {
    const r = run(patch(healthy(), "ru", "notes.count_few", undefined));
    expect(r.failures.join("\n")).toMatch(/partial plural group/);
    expect(r.failures.join("\n")).toMatch(/ru: notes\.count → _few/);
  });

  // The regression this file exists for. The check originally compared a group
  // against the MODAL suffix set of the locale's own groups. Strip `_few` from
  // EVERY group and the majority becomes one/many/other, so each broken group is
  // measured against a baseline the breakage itself defined and the guard
  // reports ok. It is `Intl.PluralRules` now, which no amount of broken data can
  // move. The single-group case above cannot tell the two designs apart.
  it("still names it when EVERY group loses the same category, which a majority cannot see", () => {
    let files = patch(healthy(), "ru", "notes.count_few", undefined);
    files = patch(files, "ru", "notes.tag_few", undefined);
    const r = run(files);
    expect(r.failures.join("\n")).toMatch(/2 partial plural group/);
    expect(r.failures.join("\n")).toMatch(/ru: notes\.count → _few/);
    expect(r.failures.join("\n")).toMatch(/ru: notes\.tag → _few/);
  });

  it("does NOT fail when the locale has none of a group: that is untranslated, not broken", () => {
    let files = patch(healthy(), "ru", "notes.count_one", undefined);
    files = patch(files, "ru", "notes.count_few", undefined);
    files = patch(files, "ru", "notes.count_many", undefined);
    files = patch(files, "ru", "notes.count_other", undefined);
    const r = run(files);
    expect(r.failures).toEqual([]);
    expect(row(r, "ru").missing).toBe(2); // count_one and count_other, the two English carries
  });

  it("ignores a plural group English no longer has, which 14 shipped catalogs carry", () => {
    const r = run(patch(healthy(), "ru", "notes.legacy_one", "старое"));
    expect(r.failures).toEqual([]);
  });

  // The deliberate blind spot, stated as a test so it is a decision rather than
  // an oversight: `ja` carries English's `one` where CLDR gives it only `other`.
  // Intl.PluralRules("ja") never returns `one`, so a group that lacks it cannot
  // produce the English fallthrough this check is about.
  it("does not require a category beyond CLDR, and counts the absent one as coverage instead", () => {
    const files = withLocale("ja", {
      ...JA_CATALOG,
      notes: { count_other: "{{count}} 件", tag_one: "{{count}} 個", tag_other: "{{count}} 個" },
    });
    const r = run(files);
    expect(r.failures).toEqual([]);
    expect(row(r, "ja").missing).toBe(1); // notes.count_one: untranslated, not broken
    expect(row(r, "ja").required).toBe("other");
    expect(row(r, "ja").categories).toBe("one/other");
  });

  it("fails by name for a locale the runtime has no plural data for, instead of requiring nothing", () => {
    const files = withLocale("zz", {
      common: { save: "Zz", moved: "{{count}} {{folder}}" },
      notes: { count_one: "{{count}}", count_other: "{{count}}", tag_one: "{{count}}", tag_other: "{{count}}" },
    });
    const r = run(files);
    expect(r.failures.join("\n")).toMatch(/Intl\.PluralRules\("zz"\) did not yield a usable category set/);
  });
});

describe("check-i18n-coverage: check 3, placeholder parity", () => {
  it("names a dropped placeholder", () => {
    const r = run(patch(healthy(), "tr", "common.moved", "{{count}} not taşındı"));
    expect(r.failures.join("\n")).toMatch(/placeholders do not match English/);
    expect(r.failures.join("\n")).toMatch(/tr: common\.moved/);
  });

  it("names an invented placeholder", () => {
    const r = run(patch(healthy(), "tr", "common.save", "Kaydet {{name}}"));
    expect(r.failures.join("\n")).toMatch(/tr: common\.save/);
  });

  it("compares a category English lacks against English's `other`, not against nothing", () => {
    const bad = run(patch(healthy(), "ru", "notes.count_many", "заметок"));
    expect(bad.failures.join("\n")).toMatch(/ru: notes\.count_many/);
    const good = run(patch(healthy(), "ru", "notes.count_many", "{{count}} заметок!"));
    expect(good.failures).toEqual([]);
  });

  it("does not placeholder-check an orphan key English no longer has", () => {
    const r = run(patch(healthy(), "tr", "common.legacy", "eski {{gone}}"));
    expect(r.failures).toEqual([]);
  });
});

describe("check-i18n-coverage: check 4, the generated record", () => {
  it("counts an absent key as missing", () => {
    const r = run(patch(healthy(), "tr", "common.save", undefined));
    expect(row(r, "tr").missing).toBe(1);
    expect(r.complete).toBe(1);
  });

  it("counts an EMPTY value as missing, because the UI renders English either way", () => {
    const r = run(patch(healthy(), "tr", "common.save", ""));
    expect(row(r, "tr").missing).toBe(1);
  });

  it("moves when a translation goes missing, which is what --check gates on", () => {
    const before = run(healthy()).record;
    const after = run(patch(healthy(), "tr", "common.save", undefined)).record;
    expect(after).not.toBe(before);
    expect(after).toMatch(/\| `tr` \| 5 \| 1 \|/);
  });

  // The inverse, and the one that would have made the gate unusable: an English
  // COPY EDIT changes a value without changing the key set, so coverage is
  // untouched and the record must not churn. Root AGENTS.md records a generated
  // document that failed exactly this way, reddening pre-commit on any one-line
  // edit under a message claiming the file had been hand-edited.
  it("does NOT move when an English value is reworded but no key set changes", () => {
    const before = run(healthy()).record;
    const files: Files = { ...healthy() };
    const en = JSON.parse(files[`${LOCALES_DIR}/en/${NAMESPACE}`]);
    en.common.save = "Save it";
    files[`${LOCALES_DIR}/en/${NAMESPACE}`] = catalog(en);
    expect(run(files).record).toBe(before);
  });

  // The record must hand-carry no roster: it is the one document whose whole
  // point is that no figure in it is maintained by a person.
  it("derives the beyond-CLDR locale list rather than naming it in prose", () => {
    expect(run(healthy()).record).not.toMatch(/carry English's `one` that way/);
    expect(run(withLocale("ja", JA_CATALOG)).record).toMatch(/`ja` carry English's `one` that way/);
  });

  it("states the staleness limit beside the coverage figure, not below the table", () => {
    const record = run(healthy()).record;
    expect(record.slice(0, record.indexOf("| Locale |"))).toMatch(/check-i18n-stale\.mjs/);
  });

  it("names an unparseable catalog rather than skipping it", () => {
    const files: Files = { ...healthy() };
    files[`${LOCALES_DIR}/tr/${NAMESPACE}`] = "{ not json";
    const r = run(files);
    expect(r.failures.join("\n")).toMatch(/could not be parsed/);
  });

  // Rounding is FLOOR, not nearest. The document exists because two files said
  // 100% while 215 keys were untranslated, and `toFixed` reprints that sentence:
  // one key missing out of thousands still rounds to 100.00%. A figure here may
  // understate what shipped, never overstate it.
  it("never rounds an incomplete catalog up to 100%", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 4000; i++) big[`k${i}`] = `v${i}`;
    const files: Files = { ...healthy() };
    files[`${LOCALES_DIR}/en/${NAMESPACE}`] = catalog({ bulk: big });
    files[`${LOCALES_DIR}/tr/${NAMESPACE}`] = catalog({ bulk: { ...big, k0: undefined } });
    files[`${LOCALES_DIR}/ru/${NAMESPACE}`] = catalog({ bulk: big });
    const r = run(files);
    expect(row(r, "tr").missing).toBe(1);
    expect(row(r, "tr").coverage).not.toBe("100.00");
    expect(r.overall).not.toBe("100.00");
    expect(r.record).not.toMatch(/Overall: \*\*100\.00%\*\*/);
  });
});

// The gate is the only part of this file that `lefthook.yml` and the CI step
// actually invoke, and until it was extracted from the direct-invocation block
// no test could reach it: deleting the whole staleness comparison left every
// other case passing, pre-commit printing ok and CI green, with the record free
// to drift from the catalogs indefinitely. That is myne-md/myne#589 restored
// inside the guard written to end it.
describe("check-i18n-coverage: the CLI gate", () => {
  it("passes with no flags on a healthy tree, and writes nothing", () => {
    const g = runGate(healthy());
    expect(g.exitCode).toBe(0);
    expect(g.emit).toBeNull();
    expect(g.out.join("\n")).toMatch(/ok \(2 locales, 2 complete/);
  });

  it("--check passes when the record matches", () => {
    expect(runGate(withRecord(), ["--check"]).exitCode).toBe(0);
  });

  it("--check FAILS on a stale record, and says how to fix it", () => {
    const files = withRecord();
    files[RECORD_PATH] = files[RECORD_PATH].replace("100.00%", "42.00%");
    const g = runGate(files, ["--check"]);
    expect(g.exitCode).toBe(1);
    expect(g.err.join("\n")).toMatch(/is stale/);
    expect(g.err.join("\n")).toMatch(/--emit/);
  });

  it("--check FAILS when the record is absent, rather than treating nothing as current", () => {
    const g = runGate(healthy(), ["--check"]);
    expect(g.exitCode).toBe(1);
    expect(g.err.join("\n")).toMatch(/is stale/);
  });

  it("--check FAILS when a coverage row moved, which is the drift it exists for", () => {
    const files = withRecord();
    const stale = patch(files, "tr", "common.save", undefined);
    expect(runGate(stale, ["--check"]).exitCode).toBe(1);
  });

  it("--emit produces the record and exits 0", () => {
    const g = runGate(healthy(), ["--emit"]);
    expect(g.exitCode).toBe(0);
    expect(g.emit).toBe(run(healthy()).record);
  });

  // The ordering lesson `check-twin-inventory.mjs` already records: with the
  // gate exit first, an author whose tree is red for any unrelated reason is
  // told by a `--check` failure to run `--emit`, and that command then prints
  // the failure and writes nothing. The advice has to work in the state that
  // triggers it.
  it("--emit still writes the record while a hard check is failing", () => {
    const files = patch(healthy(), "tr", "common.moved", "{{count}} not taşındı");
    const g = runGate(files, ["--emit"]);
    expect(g.exitCode).toBe(1);
    expect(g.err.join("\n")).toMatch(/placeholders do not match English/);
    expect(g.emit).not.toBeNull();
    expect(g.emit).toBe(run(files).record);
  });

  // The exception, and the reason the emit is keyed on `halted` rather than on
  // the failure count: a run whose roster never parsed has no record, so
  // emitting would blank the document rather than update it.
  it("--emit writes NOTHING when the roster never parsed", () => {
    const files: Files = { ...healthy() };
    delete files[CONFIG_PATH];
    const g = runGate(files, ["--emit"]);
    expect(g.exitCode).toBe(1);
    expect(g.emit).toBeNull();
  });

  it("a hard failure exits 1 with no flags at all, so the hook catches it", () => {
    const g = runGate(patch(healthy(), "ru", "notes.count_few", undefined));
    expect(g.exitCode).toBe(1);
    expect(g.err.join("\n")).toMatch(/partial plural group/);
  });
});

// The header claims both rosters "fail BY NAME when a list cannot be found
// rather than reporting ok on an input it never read". Renamed and missing are
// covered above; this is the third shape, where the regex still matches and
// captures nothing, which is what a future edit to the `code:` pattern produces.
describe("check-i18n-coverage: roster parse backstops", () => {
  it("names a SUPPORTED_LANGUAGES block that parsed to one entry", () => {
    const files: Files = { ...healthy() };
    files[CONFIG_PATH] = config(["en"]);
    const r = run(files);
    expect(r.halted).toBe(true);
    expect(r.failures.join("\n")).toMatch(/SUPPORTED_LANGUAGES parsed to 1 language\(s\)/);
  });

  it("names an extractor `locales:` array that parsed to one entry", () => {
    const files: Files = { ...healthy() };
    files[EXTRACTOR_PATH] = extractor(["en"]);
    const r = run(files);
    expect(r.halted).toBe(true);
    expect(r.failures.join("\n")).toMatch(/i18next\.config\.js parsed to 1 locale\(s\)/);
  });

  // The blindness both readers shipped with. `[a-z-]+` matches `pt` and stops
  // at the hyphen-uppercase boundary, so `pt-BR` was captured as neither
  // `pt-BR` nor `pt`: the whole quoted string failed to match and the code
  // vanished from the roster. It vanished from BOTH rosters identically, which
  // is what made it silent, because the parity check then compared two lists
  // that were wrong in the same way and agreed.
  it.each(["pt-BR", "zh-Hant", "sr-Latn"])(
    "sees %s in both rosters rather than dropping it from both alike",
    (code) => {
      const files: Files = { ...healthy() };
      files[CONFIG_PATH] = config(["en", "tr", "ru", code]);
      files[EXTRACTOR_PATH] = extractor(["en", "tr", "ru", code]);
      // No catalog on disk for it, so a reader that SEES the code must say so.
      const r = run(files);
      expect(r.halted).toBe(true);
      expect(r.failures.join("\n")).toContain(code);
    },
  );

  it("carries a region-subtag locale all the way to a coverage row", () => {
    const files = withLocale("pt-BR", {
      common: { save: "Salvar", moved: "{{count}} nota movida para {{folder}}" },
      notes: {
        count_one: "{{count}} nota",
        count_many: "{{count}} de notas",
        count_other: "{{count}} notas",
        tag_one: "{{count}} etiqueta",
        tag_many: "{{count}} de etiquetas",
        tag_other: "{{count}} etiquetas",
      },
    });
    const r = run(files);
    expect(r.halted).toBe(false);
    expect(r.record).toContain("pt-BR");
  });

  // The other half of the fix, and the reason widening the pattern alone was
  // not enough: a quoted value that is not a language tag is now named rather
  // than skipped, so the next shape nobody anticipated fails loudly.
  it("names a quoted roster entry it cannot classify instead of walking past it", () => {
    const files: Files = { ...healthy() };
    files[EXTRACTOR_PATH] =
      `export default defineConfig({\n  locales: ["en","tr","ru","en_US_POSIX_and_then_some"],\n});\n`;
    const r = run(files);
    expect(r.halted).toBe(true);
    expect(r.failures.join("\n")).toMatch(/not language tags/);
    expect(r.failures.join("\n")).toContain("en_US_POSIX_and_then_some");
  });
});
