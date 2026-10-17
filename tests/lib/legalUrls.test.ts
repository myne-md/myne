// The per-language legal slug, as a pure-function table — myne-md/myne#557,
// the `settings.panel.about` bullet ("the per-language legal slug is a pure
// function").
//
// `tests/components/AboutPanel.test.tsx` already drives these through
// the panel, which is the right test for the panel and the wrong one for the
// mapping: it exercises one document per language. A slug typo in `terms.de` or
// `privacy.de` passes it. This file pins the whole matrix — three documents by
// two languages — plus the three properties the mapping's own header states and
// nothing checks:
//
//  * the primary subtag decides, so a regional German lands on German;
//  * the Impressum takes no locale at all, because it is a German statutory
//    instrument and an "English version" would raise which one is binding;
//  * every URL is the canonical trailing-slash form the site publishes, so a
//    link costs no redirect.
//
// And one cross-client claim the module's own doc comment makes and nothing
// verifies: the same documents, in the same order, under the same test
// ids, on every client. `LEGAL_LINKS` is imported by the desktop AboutPanel and
// by `mobile/src/app/flows/SettingsSheet.tsx` — the shared list is what stops a
// client quietly offering a different set.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL_LINKS, legalUrl, type LegalDoc } from "../../src/lib/legal-urls";

const REPO_ROOT = process.cwd();

/**
 * The published address of every document, in both editions.
 *
 * Written out rather than derived from `SLUGS`, deliberately: deriving it would
 * compare the module against itself and pass on any typo. These are the strings
 * the website publishes.
 */
const EXPECTED: Record<LegalDoc, { en: string; de: string }> = {
  privacy: { en: "https://myne.md/privacy/", de: "https://myne.md/datenschutz/" },
  terms: { en: "https://myne.md/terms/", de: "https://myne.md/nutzungsbedingungen/" },
  // Takes no locale: one German text, both ways.
  impressum: { en: "https://myne.md/impressum/", de: "https://myne.md/impressum/" },
};

const ALL_DOCS = Object.keys(EXPECTED) as LegalDoc[];

describe("legalUrl: the whole document by language matrix", () => {
  it.each(ALL_DOCS)("%s resolves to its English edition on an English UI", (doc) => {
    expect(legalUrl(doc, "en")).toBe(EXPECTED[doc].en);
  });

  it.each(ALL_DOCS)("%s resolves to its German edition on a German UI", (doc) => {
    expect(legalUrl(doc, "de")).toBe(EXPECTED[doc].de);
  });

  it("the two editions differ for every bilingual document", () => {
    // Otherwise a copy-paste in `SLUGS` would make the pair above pass twice
    // over the same string. The Impressum is the deliberate exception.
    for (const doc of ALL_DOCS) {
      if (doc === "impressum") continue;
      expect(
        EXPECTED[doc].en,
        `${doc} publishes the same slug in both languages, which means one of ` +
          `the two editions is unreachable`,
      ).not.toBe(EXPECTED[doc].de);
    }
  });
});

describe("legalUrl: which locale counts as German", () => {
  const GERMAN = ["de", "de-DE", "de-AT", "de-CH", "DE", "De-de"];
  const NOT_GERMAN = ["en", "en-GB", "tr", "fr", "pt-BR", "nl", "da", "sv", "zh-Hans"];

  it.each(GERMAN)("%s gets the German text", (locale) => {
    expect(legalUrl("privacy", locale)).toBe(EXPECTED.privacy.de);
  });

  it.each(NOT_GERMAN)("%s falls back to the English text", (locale) => {
    // Two texts exist, not a locale matrix. `nl` and `da` are the ones worth
    // naming: near neighbours of German that must NOT be routed to it.
    expect(legalUrl("privacy", locale)).toBe(EXPECTED.privacy.en);
  });

  it("matches on the primary subtag, not on a substring", () => {
    // A `startsWith("de")` on the whole tag would send Danish (`da`) nowhere
    // wrong, but a naive `includes("de")` would route `sv-SE` and `en-DE`
    // oddly. Pin the shape rather than assume it.
    expect(legalUrl("privacy", "sv-SE")).toBe(EXPECTED.privacy.en);
    expect(legalUrl("privacy", "en-DE")).toBe(EXPECTED.privacy.en);
  });
});

describe("legalUrl: the canonical form", () => {
  it.each(ALL_DOCS)("%s is published with a trailing slash in both languages", (doc) => {
    // The sitemap's canonical form. Linking without one costs a redirect, and a
    // redirect on a legal link is a request to a third party's edge that the
    // page did not need to make.
    for (const locale of ["en", "de"]) {
      const url = legalUrl(doc, locale);
      expect(url.endsWith("/"), `${url} is not the canonical trailing-slash form`).toBe(
        true,
      );
      expect(url.startsWith("https://myne.md/")).toBe(true);
      // No double slash from a slug that already carried one.
      expect(url.slice("https://".length)).not.toContain("//");
    }
  });
});

describe("LEGAL_LINKS: one list, every client", () => {
  it("offers exactly the privacy policy", () => {
    // One entry, not four: terms, the DSA notice route and the law-enforcement
    // page described an offering Myne no longer makes, and all four of those
    // pages are now deleted from the site rather than merely unlinked
    // (`docs/decisions/sync/0696`).
    expect(LEGAL_LINKS.map((l) => l.doc)).toEqual(["privacy"]);
  });

  it("does not list the Impressum while its address is unpublished", () => {
    // myne-ops#9. `legalUrl` can produce it and the page exists; in Germany an
    // incomplete Impressum reads as compliant, which is a worse position than
    // none. This assertion is what makes the omission deliberate rather than
    // forgotten, on every client at once rather than on the one panel a
    // component test happens to render.
    expect(LEGAL_LINKS.some((l) => l.doc === "impressum")).toBe(false);
  });

  it("carries a distinct testid and label key per entry", () => {
    const ids = LEGAL_LINKS.map((l) => l.testId);
    const keys = LEGAL_LINKS.map((l) => l.labelKey);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(keys).size).toBe(keys.length);
    for (const l of LEGAL_LINKS) {
      expect(l.testId.startsWith("about.legal-")).toBe(true);
      expect(l.labelKey.startsWith("settings.about.legal")).toBe(true);
    }
  });

  it("is the list BOTH clients render, not a desktop-only copy", () => {
    // The module's header claims the desktop, web and mobile clients show the
    // same documents because they share this list. The way that claim
    // breaks is a client growing its own array, which no compiler and no other
    // test would notice — so assert the import is still there.
    const mobileSheet = readFileSync(
      join(REPO_ROOT, "mobile/src/app/flows/SettingsSheet.tsx"),
      "utf8",
    );
    expect(
      mobileSheet.includes("LEGAL_LINKS"),
      "mobile stopped consuming the shared list; a second copy is how one " +
        "client ends up offering three documents",
    ).toBe(true);
    const desktopPanel = readFileSync(
      join(REPO_ROOT, "src/components/settings/AboutPanel.tsx"),
      "utf8",
    );
    expect(desktopPanel.includes("LEGAL_LINKS")).toBe(true);
  });
});
