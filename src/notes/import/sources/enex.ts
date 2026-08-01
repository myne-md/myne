// Evernote `.enex` import source (importer-breadth epic, MYND-581).
//
// THE ONE-FILE-MANY-NOTES SOURCE. A single `.enex` holds N `<note>` elements, a
// shape the original directory walk could not express at all — it is the reason the
// MYND-579 seam is a `plan()`/`load()` pair rather than a tree walk.
//
// HOW IT HOLDS THE D3 RULE. The host read-seam has NO ranged read
// (`import_read_file` returns the whole file as one `String`), so the file is in RAM
// in its entirety no matter what this adapter does. `plan()` therefore parses that
// one string ONCE and keeps only per-note element handles; `load()` converts one
// note at a time. Retaining a single file string is exactly what D3 already
// sanctions ("one file in RAM at a time" — there IS one file), and the size cap
// below bounds it.
//
// XXE. Every real `.enex` opens with an external-DTD doctype
// (`<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">`).
// Parsing goes through `parseMarkup(…, "xml")`, i.e. `DOMParser`, which loads no
// external DTD and resolves no external entity — see `html/parse.ts` for why that
// makes the no-remote-fetch anti-feature structural here rather than procedural.

import {
  tallyCompression,
  type CompressionTally,
  type ImportedAttachment,
} from "../../../editor/attachments/insert";
import { htmlToMarkdown } from "../html";
import { MarkupParseError, parseMarkup } from "../html/parse";
import { emptyIgnoreCounts } from "../skipPredicate";
import type {
  ImportItemRef,
  ImportPlan,
  ImportPorts,
  ImportSource,
  LoadedItem,
} from "../source";

/**
 * Size ceiling for a single `.enex`, with an honest refusal above it.
 *
 * Evernote inlines every attachment as base64, so a media-heavy export balloons
 * well past its note count. Because the seam cannot read a range, an uncapped read
 * puts the whole file in a Rust `String`, across IPC, and in V8 at once — an
 * unbounded OOM mid-migration, which is the worst failure mode for a one-shot
 * trust-building flow. The cap converts that into a bounded spike plus a clear
 * message. `import_read_file_range` is the tracked follow-up if real exports exceed
 * it. (Grill 2026-07-25 R4.)
 */
export const MAX_ENEX_BYTES = 256 * 1024 * 1024;

/** Raised when an `.enex` exceeds {@link MAX_ENEX_BYTES}. */
export class EnexTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`enex too large: ${bytes} bytes (cap ${MAX_ENEX_BYTES})`);
    this.name = "EnexTooLargeError";
  }
}

/** Ingest raw bytes as a vault attachment. Injected so this module needs no Tauri.
 *
 *  Returns the WHOLE stored attachment rather than the `{id, filename}` the
 *  rewrite needs: ingest-time image compression is gated in shared core, so a
 *  resource arriving here is downscaled and re-encoded exactly as a pasted image
 *  is, and the `original_size` that says so lives on the attachment. Narrowing
 *  the return type here is what previously made this — the one bulk route that
 *  ingests without a media path — compress in silence. */
export type BytesIngestor = (
  bytes: Uint8Array,
  filename: string,
  mime: string | null,
) => Promise<ImportedAttachment | null>;

export interface EnexSourceOptions {
  /** Wired in production to `attachment_import {kind:"bytes"}`. Omitted → resources
   *  become placeholder comments plus a reported loss, never silent drops. */
  ingestBytes?: BytesIngestor;
}

/** Decode a base64 payload, tolerating the newlines Evernote wraps `<data>` with. */
export function decodeBase64(payload: string): Uint8Array | null {
  const compact = payload.replace(/\s+/g, "");
  if (compact.length === 0) return null;
  try {
    const binary = atob(compact);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A filesystem-safe note title; `.enex` titles are free text and may be empty. */
export function enexNoteTitle(raw: string | null, index: number): string {
  const trimmed = (raw ?? "").replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return `Untitled note ${index + 1}`;
  // Path separators would forge folder structure through the display path.
  return trimmed.replace(/[/\\]/g, "-");
}

/**
 * Replace every `<en-crypt>` span with a fenced block that PRESERVES the
 * ciphertext verbatim, and report it.
 *
 * Evernote lets a user encrypt selected text under a separate passphrase Myne does
 * not hold and cannot derive. Dropping it would destroy precisely the content the
 * user chose to protect — the worst available outcome — so the bytes are kept as
 * inert text the user can decrypt elsewhere. Never decrypted, never executed.
 * (Grill 2026-07-25 Q10.)
 */
export function preserveEnCrypt(doc: Document): number {
  const nodes = Array.from(doc.querySelectorAll("en-crypt"));
  for (const el of nodes) {
    const cipher = el.getAttribute("cipher") ?? "unknown";
    const hint = el.getAttribute("hint");
    const body = (el.textContent ?? "").replace(/\s+/g, "");
    const pre = doc.createElement("pre");
    pre.textContent =
      `[Evernote encrypted block — cipher=${cipher}` +
      (hint !== null && hint.length > 0 ? ` hint=${hint}` : "") +
      `]\n${body}`;
    el.replaceWith(pre);
  }
  return nodes.length;
}

/**
 * An `ImportSource` over one picked `.enex` file.
 *
 * `plan()` reads + parses the file once and returns one item per `<note>`; `load()`
 * converts a single note's ENML body through the shared converter.
 */
export function createEnexSource(
  absPath: string,
  ports: ImportPorts,
  options: EnexSourceOptions = {},
): ImportSource {
  // Parsed once by plan(), then indexed by load(). Bounded by MAX_ENEX_BYTES.
  let notes: Element[] = [];

  return {
    id: "evernote",

    async plan(): Promise<ImportPlan> {
      const raw = await ports.readFile(absPath);
      // `String.length` is UTF-16 units, a lower bound on bytes — good enough for a
      // guard whose job is bounding RAM, and it avoids a second full encode.
      if (raw.length > MAX_ENEX_BYTES) throw new EnexTooLargeError(raw.length);

      let doc: Document;
      try {
        doc = parseMarkup(raw, "xml");
      } catch (e) {
        // A corrupt export fails loudly rather than importing as one garbage note.
        throw e instanceof MarkupParseError ? e : new MarkupParseError(String(e));
      }
      notes = Array.from(doc.querySelectorAll("note"));

      const items: ImportItemRef[] = notes.map((note, index) => {
        const title = enexNoteTitle(note.querySelector("title")?.textContent ?? null, index);
        // Display path drives folder + title derivation; `.md` so the shared
        // `deriveImportTitle` (which strips exactly one `.md`) reads it cleanly.
        return { relPath: `${title}.md`, handle: index };
      });

      return { items, dirs: [], ignore: emptyIgnoreCounts(), unfollowedLinks: [] };
    },

    async load(ref: ImportItemRef): Promise<LoadedItem> {
      const note = notes[ref.handle as number];
      if (note === undefined) return { markdown: "", lossy: ["enex-note-missing"] };

      const lossy = new Set<string>();

      // `<content>` carries ENML — an HTML dialect, usually inside CDATA. Parse it
      // as XML first so `<en-crypt>` / `<en-media>` are addressable elements.
      const enml = note.querySelector("content")?.textContent ?? "";
      let body = enml;
      let compression: CompressionTally | undefined;
      if (enml.trim().length > 0) {
        try {
          const inner = parseMarkup(enml, "xml");
          if (preserveEnCrypt(inner) > 0) lossy.add("evernote-encrypted-block");
          const stored = await rewriteResources(inner, note, options.ingestBytes, lossy);
          compression = tallyCompression(stored);
          body = inner.documentElement.innerHTML;
        } catch {
          // Malformed ENML: fall through to the lenient HTML path below rather than
          // losing the note. Recorded so the degradation is never silent.
          lossy.add("enex-malformed-enml");
        }
      }

      const converted = await htmlToMarkdown(body, "html");
      for (const l of converted.lossy) lossy.add(l);
      return { markdown: converted.markdown, lossy: [...lossy].sort(), compression };
    },
  };
}

/**
 * Turn each `<en-media>` into an attachment reference (when an ingestor is wired) or
 * a placeholder comment plus a reported loss.
 *
 * Evernote references a resource by the MD5 hash of its bytes, so the matching
 * `<resource>` is found by comparing hashes — and because the payload is base64
 * INLINE rather than a path, ingestion needs the bytes seam, not the media-path
 * resolver the Obsidian importer uses.
 *
 * Returns every attachment actually stored, so the caller can tally what
 * ingest-time compression did to them — the disclosure obligation the bytes seam
 * carries in place of the media port's.
 */
async function rewriteResources(
  inner: Document,
  note: Element,
  ingestBytes: BytesIngestor | undefined,
  lossy: Set<string>,
): Promise<ImportedAttachment[]> {
  const stored: ImportedAttachment[] = [];
  const medias = Array.from(inner.querySelectorAll("en-media"));
  if (medias.length === 0) return stored;

  const resources = Array.from(note.querySelectorAll("resource"));

  for (const media of medias) {
    const mime = media.getAttribute("type");
    const hash = media.getAttribute("hash");
    const resource = pickResource(resources, hash);
    const filename =
      resource?.querySelector("resource-attributes > file-name")?.textContent?.trim() ??
      `attachment-${hash ?? "unknown"}`;

    let replacement: string | null = null;
    if (ingestBytes !== undefined && resource !== undefined) {
      const bytes = decodeBase64(resource.querySelector("data")?.textContent ?? "");
      if (bytes !== null) {
        const ingested = await ingestBytes(bytes, filename, mime);
        if (ingested !== null) {
          replacement = `![[att:${ingested.id}|${ingested.filename}]]`;
          stored.push(ingested);
        }
      }
    }

    const node = inner.createElement("p");
    if (replacement !== null) {
      node.textContent = replacement;
    } else {
      // Same shape as the Obsidian importer's omitted-attachment placeholder, so the
      // two importers report an un-ingested resource identically.
      node.textContent = `<!-- omitted attachment: ${filename} -->`;
      lossy.add("evernote-attachment");
    }
    media.replaceWith(node);
  }

  return stored;
}

/** The `<resource>` whose data hash matches an `<en-media hash>`, if identifiable. */
function pickResource(resources: readonly Element[], hash: string | null): Element | undefined {
  if (hash !== null) {
    const byHash = resources.find(
      (r) => r.querySelector("data")?.getAttribute("hash")?.toLowerCase() === hash.toLowerCase(),
    );
    if (byHash !== undefined) return byHash;
  }
  // Evernote does not always emit a per-`<data>` hash. With exactly one resource the
  // association is unambiguous; with several it is not, so guessing is declined.
  return resources.length === 1 ? resources[0] : undefined;
}
