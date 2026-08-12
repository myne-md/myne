// The published legal documents, and the one place that decides which language
// a client links to (operations#15).
//
// The texts live in the website repo and are served from myne.md; every client
// links to the same pages rather than embedding a copy, so there is exactly one
// text per document and no way for an app build to ship a stale one.
//
// LANGUAGE. Each document exists in English and German, at different slugs
// (`/privacy` vs `/datenschutz`), because the German version is not a
// translation of the English one — it is the same document written twice, and
// the German text is the one a German authority would read. The interface
// language picks between them: German UI gets the German slugs, the other 31
// locales get English. That is a deliberate two-way choice rather than a full
// locale matrix, because only those two texts exist.
//
// The Impressum is the exception and takes no locale: it is a German statutory
// instrument (§ 5 DDG) published only in German. Publishing an "English
// version" of it would raise the question of which one is binding.

/** A published legal document. */
export type LegalDoc = "privacy" | "terms" | "lawEnforcement" | "notice" | "impressum";

/** The two slugs each bilingual document is published under. */
const SLUGS: Record<Exclude<LegalDoc, "impressum">, { en: string; de: string }> = {
  privacy: { en: "privacy", de: "datenschutz" },
  terms: { en: "terms", de: "nutzungsbedingungen" },
  lawEnforcement: { en: "law-enforcement", de: "behoerdenanfragen" },
  notice: { en: "notice", de: "meldung" },
};

/**
 * The canonical URL for a legal document in the language matching `locale`.
 *
 * `locale` is an i18next language tag (`"en"`, `"de"`, `"de-DE"`, `"pt-BR"`) —
 * matched on its primary subtag, so a regional German still lands on the German
 * text. Anything that is not German gets English.
 *
 * Trailing slash is deliberate: it is the canonical form the site publishes in
 * its sitemap, so linking without one costs a redirect.
 */
export function legalUrl(doc: LegalDoc, locale: string): string {
  if (doc === "impressum") return "https://myne.md/impressum/";
  const german = locale.toLowerCase().startsWith("de");
  return `https://myne.md/${SLUGS[doc][german ? "de" : "en"]}/`;
}
