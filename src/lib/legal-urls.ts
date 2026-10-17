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

/**
 * A published legal document.
 *
 * **Two documents left the union on 2026-10-17**: `lawEnforcement` and `notice`.
 * They were the DSA contact/notice pages and the law-enforcement inventory, and
 * both were published to describe a server Myne operated and offered. Myne
 * operates none (`design-notes/sync/0696`), the pages are deleted from the
 * website, and a slug that resolves to a deleted page is worse than no entry:
 * the app would link a 404 and claim a document that does not exist. The
 * "never have" inventory the law-enforcement page carried has moved to
 * `docs/self-host-policy.md`, where it belongs — it is a statement about a
 * server, and the reader who runs one is the operator.
 */
export type LegalDoc = "privacy" | "terms" | "impressum";

/** The two slugs each bilingual document is published under. */
const SLUGS: Record<Exclude<LegalDoc, "impressum">, { en: string; de: string }> = {
  privacy: { en: "privacy", de: "datenschutz" },
  terms: { en: "terms", de: "nutzungsbedingungen" },
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

/**
 * The documents a client offers, in the order a reader is likeliest to want
 * them, with their label key and test id.
 *
 * Shared rather than declared per client so the desktop, the web client and
 * mobile show the same documents in the same order under the same test
 * ids — a second copy is how one client quietly ends up offering three.
 *
 * **One document, and it is the only one left that a client links.** The list
 * carried four until 2026-10-16: privacy, the beta terms, the DSA notice route
 * and the law-enforcement page. The other three describe a service Myne was
 * offering to the public, and Myne offers none (`design-notes/sync/0696`), so
 * a client linking them was pointing readers at documents about an offering
 * that no longer exists. All four pages are now gone from the website, and
 * `legalUrl` can no longer produce their slugs at all: a type that names a
 * document the site does not publish is a link to a 404 wearing a legal label.
 *
 * **The Impressum is deliberately not in this list.** `legalUrl` can still
 * produce it and the page exists, but nothing links it until its address is
 * filled in (operations#9): in Germany an incomplete Impressum is a worse
 * position than none, because it reads as compliant. Adding the entry here is
 * all it takes the day that closes — and it lands on all three clients at once.
 *
 * **`terms` is still in `LegalDoc` and still not in this list.** The page is
 * published and the German twin links it, but it is the beta terms of the
 * closed offering, nothing in the app points at it, and the pre-sync dialog
 * stopped opening it on 2026-10-16 (`design-notes/sync/0696`). It stays
 * reachable by URL until the offering's paperwork is settled, and an entry here
 * would advertise it again.
 */
export const LEGAL_LINKS: ReadonlyArray<{
  doc: LegalDoc;
  labelKey: string;
  testId: string;
}> = [
  { doc: "privacy", labelKey: "settings.about.legalPrivacy", testId: "about.legal-privacy" },
];
