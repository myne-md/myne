// Body rewrite for the Myne vault import source (myne-md/myne#464).
//
// Two swaps, applied once per note between `load()` and `note_create`. Both are
// sanctioned import transforms (`markdown-dialect.md` §6): the body is otherwise
// preserved byte-for-byte, and nothing here touches a byte it did not have to.
//
// 1. **Attachment embed ids.** `protocol.md` §9.9 derives an attachment id as
//    `HMAC-SHA-256(DeriveSubkey(root_key, "attachments-id-hmac"), plaintext)`,
//    keyed under the VAULT's own `root_key`. A source id is therefore
//    meaningless in the target, so every `![[att:<id>|…]]` has to be rewritten
//    or it renders as a tombstone. The re-seal returns the target id, and this
//    swaps it in.
//
// 2. **Wikilinks to renamed notes.** Resolution is title-keyed
//    (`wikilink.md` §5.3), so when the conflict layer renames an incoming note,
//    every imported link that pointed at its OLD title must be moved to the new
//    one. Without this the link resolves to the target's own note of that name,
//    which is the exact silent mis-link the rename exists to prevent.
//
// **Both halves go through `extractWikilinks`, not a regular expression.** An
// earlier version matched `/(!?)\[\[([^\]\n]*)\]\]/g` over the raw source, and
// that is wrong in a way a test over ordinary notes never shows: a `[[Title]]`
// written INSIDE a fenced code block is not a wikilink, and rewriting it edits
// the user's documented example. `extractWikilinks` is the lezer extension the
// editor itself resolves through, registered `before: "Link"`, so it sees
// exactly the links the resolver sees and nothing else.
//
// The title half delegates to `planInboundRewrites`, the same §8.2 planner the
// rename action uses. That buys the alias rule for free, and the alias rule is
// not cosmetic: Myne's own picker emits `[[<path>.md|<Title>]]`, so an alias
// that MIRRORS the renamed title is an auto-emitted display rather than a
// deliberate label. Leaving it alone would point the link at the renamed note
// while the chip kept rendering the OLD name, which is most of what the rename
// was for.
//
// One id is deliberately NOT rewritten: an embed whose id the SOURCE catalog no
// longer resolves. §5.1 says such an id renders as a tombstone, distinguishing
// an attachment that was deleted from a reference that was never valid, and that
// "the note bytes are never rewritten in either case". Keeping the source id
// preserves that distinction exactly; flattening it to text would destroy a
// distinction the spec went out of its way to build. The cost is one foreign
// identifier surviving in the target's content, which is an HMAC under a key the
// target does not hold and so says nothing to anyone reading it.

import { extractWikilinks } from "../../../dialect/visitors/wikilinks";
import { planInboundRewrites } from "../../renameWikilinks";
import type { InboundRewrite } from "../../renameWikilinks";

/** How to rewrite one note's body. Both maps may be empty. */
export interface MyneRewritePlan {
  /** Source attachment id (64 lowercase hex) to the id it has in the target. */
  readonly attachmentIds: ReadonlyMap<string, string>;
  /** OLD title to the NEW title the conflict layer assigned. */
  readonly renamedTitles: ReadonlyMap<string, string>;
  /**
   * Source attachment ids the TARGET refused (a size cap, an IO failure, an
   * unreadable blob). Optional, and absent means "none".
   *
   * They are excluded from `tombstonedEmbeds` rather than merged into it. Both
   * classes leave the embed pointing at a source id, so the BODY is identical
   * and only the cause differs, but the report's two rows say different things:
   * one says the file was already deleted in the source vault, which for a
   * refusal is false. The caller counts a refusal once, as a refusal.
   */
  readonly refusedAttachmentIds?: ReadonlySet<string>;
}

/** What a rewrite changed, for the import report. */
export interface MyneRewriteResult {
  readonly markdown: string;
  /** Embeds whose attachment id was swapped for the target's. */
  readonly attachmentsRewritten: number;
  /** Wikilinks moved to a renamed note's new title. */
  readonly linksRetargeted: number;
  /**
   * Embeds left pointing at a source id, because the source catalog no longer
   * resolved it. They render as tombstones in the target exactly as they did in
   * the source. Reported so the count is stated rather than discovered.
   */
  readonly tombstonedEmbeds: number;
}

/** `att:<64 hex>` — the attachment-embed target (form 12). */
const ATT_TARGET = /^att:([0-9a-f]{64})$/;

/**
 * Apply the byte-range splices back-to-front, so an earlier range's offsets are
 * still valid when it is spliced.
 *
 * Written here rather than imported from `renameInbound.ts`, which owns the
 * identical eight lines: that module also imports `vaultIndices` and `readNote`,
 * so importing it would pull the IPC surface into a pure transform. The planner
 * it shares, which is the load-bearing half, is imported.
 */
function splice(body: string, rewrites: readonly InboundRewrite[]): string {
  if (rewrites.length === 0) return body;
  const ordered = [...rewrites].sort(
    (a, b) => b.byteRange.start - a.byteRange.start,
  );
  let out = body;
  for (const r of ordered) {
    out = out.slice(0, r.byteRange.start) + r.after + out.slice(r.byteRange.end);
  }
  return out;
}

/**
 * Apply a rewrite plan to one note's markdown.
 *
 * Idempotent: running it on its own output changes nothing, because a target id
 * is not a key in `attachmentIds` and a new title is not a key in
 * `renamedTitles`. That property is what makes the rewrite safe to apply on a
 * re-import without compounding.
 */
export function rewriteMyneBody(
  markdown: string,
  plan: MyneRewritePlan,
): MyneRewriteResult {
  let attachmentsRewritten = 0;
  let tombstonedEmbeds = 0;

  // Pass one: the attachment ids, over the extracted links so a `![[att:…]]`
  // inside a code fence is left alone.
  const attachmentSplices: InboundRewrite[] = [];
  for (const ref of extractWikilinks(markdown)) {
    const att = ATT_TARGET.exec(ref.target.trim());
    if (att === null) continue;
    const mapped = plan.attachmentIds.get(att[1]);
    if (mapped === undefined) {
      // No target id, and there are two ways to get here. The target REFUSED
      // this attachment, in which case the caller has already counted it and
      // counting it again here would attribute it to a deletion that never
      // happened. Otherwise the source catalog did not resolve it, which is the
      // real tombstone: leave the id, so it renders as the tombstone it already
      // was in the source.
      if (plan.refusedAttachmentIds?.has(att[1]) !== true) tombstonedEmbeds += 1;
      continue;
    }
    // The alias is carried through VERBATIM, layout segments and unrecognised
    // keys included (§5.1). Rebuilding it through the emitter would normalise
    // exactly the bytes the spec requires be passed over untouched, so the swap
    // is done on the raw text of the link and nothing else.
    const after = ref.raw.replace(`att:${att[1]}`, `att:${mapped}`);
    if (after === ref.raw) continue;
    attachmentSplices.push({ byteRange: ref.byteRange, before: ref.raw, after });
    attachmentsRewritten += 1;
  }
  let out = splice(markdown, attachmentSplices);

  // Pass two: the renamed titles. EVERY rename is planned against the same
  // body, and the splices are applied together, once.
  //
  // Applying them one at a time over the already-spliced text compounds, and
  // the case is not exotic. Suppose the source holds both `Beta` and
  // `Beta (Eski laptop)`, both collide and both are linked. The map then
  // carries `Beta -> Beta (Eski laptop)` and
  // `Beta (Eski laptop) -> Beta (Eski laptop) (Eski laptop)`. A sequential
  // application rewrites `[[Beta]]` on the first iteration and then MATCHES ITS
  // OWN OUTPUT on the second, landing the link on the other note's renamed
  // title. `decisions/editor/0543` states both transforms are idempotent and
  // cannot compound; for the title half that held only against a single pass,
  // which this now is.
  //
  // Planning against `out` (post-attachment-splice) rather than against
  // `markdown` is deliberate and safe: the attachment pass only ever rewrites
  // the 64-hex id inside an `att:` target, which is not a title and cannot
  // appear in a rename map. So every range planned here is still valid when
  // `splice` applies them back-to-front.
  //
  // Overlaps between two renames' ranges are impossible for the same reason
  // they are impossible within one rename: a wikilink occupies one range, and
  // its target folds to exactly one title, so at most one rename can claim it.
  let linksRetargeted = 0;
  const titleSplices: InboundRewrite[] = [];
  for (const [oldTitle, newTitle] of plan.renamedTitles) {
    const rewrites = planInboundRewrites(out, { oldTitle, newTitle });
    linksRetargeted += rewrites.length;
    titleSplices.push(...rewrites);
  }
  out = splice(out, titleSplices);

  return { markdown: out, attachmentsRewritten, linksRetargeted, tombstonedEmbeds };
}
