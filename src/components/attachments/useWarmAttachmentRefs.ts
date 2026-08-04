// Prepare attachment blob URLs for the surfaces that render thumbnails (#263).
//
// On the web client an `AttachmentThumbnail` renders from a blob URL the host
// has already minted; it does not fetch. Only `AttachmentsLibrary` warmed the
// ids it was about to show, so every OTHER thumbnail surface painted blank
// boxes:
//
//   - `CoverPicker` — identical blank boxes with the filename only as a `title`
//     tooltip, so the user picks a cover blind;
//   - `CleanUnusedAttachmentsDialog` — where the thumbnails exist specifically
//     so the user sees what is about to be erased, before an irreversible
//     cryptographic erase.
//
// The rule the hook encodes: a surface that renders thumbnails warms the ids it
// renders.
//
// # What "the ids it renders" had to become (myne#388)
//
// That sentence used to read "scoped to what is on screen after filtering,
// never the whole catalog", and it described nothing. All three callers derived
// their ids from a catalog query — `AttachmentsLibrary`'s `visible` is a filter
// plus a sort over the whole catalog with both filters inert at their defaults,
// so on first open it IS the entire catalog. Opening the library therefore
// decrypted every attachment in the vault and pinned each as a `blob:` URL, a
// GC root, for the rest of the unlocked session. Resident decrypted plaintext
// scaled with vault size rather than with what was on screen.
//
// The invariant was asserted at three call sites and enforced at none, so it
// lives here now: the window is what an `IntersectionObserver` reports on
// screen, and `MAX_WARMED_IDS` is the ceiling that holds when there is no
// observer. A fourth caller is safe by construction.
//
// The byte ceiling is elsewhere and is the one that actually holds —
// `MAX_PINNED_BYTES` in `web/wasm/src/attachment_url.rs`, which is the only side
// that knows the sizes. This window is what keeps eviction rare.
//
// A no-op on desktop, where the URL builder needs no IO at all.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ATTACHMENT_REFS_NEED_WARMING,
  warmAttachmentUrls,
} from "../../platform/attachments";

/**
 * The ceiling on how many ids one warm may ask for.
 *
 * A COUNT, not a byte budget, because a count is what a caller can cheaply
 * enforce — the bytes are bounded in the Worker, which is the only side that
 * knows them. 128 is roughly twice the largest plausible screenful: at the
 * 160 px minimum tile a wide pane fits ~40 tiles, and the observer's prefetch
 * margin adds about half that again. It is a BACKSTOP — a windowed caller never
 * reaches it — and it exists so a fourth thumbnail surface cannot re-open this
 * hole by construction.
 */
export const MAX_WARMED_IDS = 128;

export interface WarmedRefs {
  /**
   * React `key` for the element rendering `id`. Changes exactly once per
   * cold→warm transition of THAT id, so a tile remounts when its own URL
   * arrives and not when a neighbour's does.
   *
   * Per-id rather than one shared nonce because a moving window plus a global
   * nonce would remount the whole grid on every scroll step — aborting and
   * re-rasterizing every PDF thumbnail, stopping any playing audio tile, and
   * throwing away text typed into an inline rename.
   */
  warmKey(id: string): string;
  /**
   * Ref callback for the element rendering `id`, so the hook learns when it is
   * on screen. A stable no-op unless the surface opted into windowing.
   */
  observeItem(id: string): (el: Element | null) => void;
}

/** Prefetch margin: start warming a tile a little before it scrolls into view. */
const ROOT_MARGIN = "200px 0px";

const NOOP_REF = (): void => {};

/**
 * Warm the attachment ids a surface renders, and report which have arrived.
 *
 * The array is read by VALUE (joined into the effect key), so a caller may pass
 * a freshly-mapped array each render without re-warming on every one.
 *
 * `opts.windowed` opts a scrollable surface into `IntersectionObserver`-driven
 * warming. A surface whose whole point is that every row is visible at once —
 * the erase-confirmation dialog — leaves it off deliberately.
 */
export function useWarmAttachmentRefs(
  ids: readonly string[],
  opts?: { readonly windowed?: boolean },
): WarmedRefs {
  const key = ids.join(",");
  const windowed = opts?.windowed === true;

  // Per-id cold→warm counter. A `Map` in state rather than a nonce, so a tile's
  // key changes only when its own URL arrives.
  const [warmed, setWarmed] = useState<ReadonlyMap<string, number>>(new Map());

  // Ids the observer currently reports on screen. Empty (and unused) when the
  // surface is not windowed.
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());

  // One observer for the hook's lifetime, and one ref callback per id — both
  // memoised, or React detaches and reattaches every element on every render.
  const observerRef = useRef<IntersectionObserver | null>(null);
  const refCallbacks = useRef(new Map<string, (el: Element | null) => void>());
  const elementIds = useRef(new WeakMap<Element, string>());

  const hasObserver = windowed && typeof IntersectionObserver !== "undefined";

  useEffect(() => {
    if (!ATTACHMENT_REFS_NEED_WARMING || !hasObserver) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const id = elementIds.current.get(entry.target);
            if (id === undefined) continue;
            if (entry.isIntersecting) {
              if (!next.has(id)) {
                next.add(id);
                changed = true;
              }
            } else if (next.delete(id)) {
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      // Viewport-rooted is correct even inside an `overflow:auto` pane —
      // ancestor clipping is applied to the intersection.
      { root: null, rootMargin: ROOT_MARGIN },
    );
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [hasObserver]);

  const observeItem = useCallback(
    (id: string) => {
      if (!ATTACHMENT_REFS_NEED_WARMING || !hasObserver) return NOOP_REF;
      const existing = refCallbacks.current.get(id);
      if (existing !== undefined) return existing;
      const cb = (el: Element | null): (() => void) | undefined => {
        if (el === null) return undefined;
        elementIds.current.set(el, id);
        observerRef.current?.observe(el);
        // React 19 ref cleanup: stop watching, and stop claiming it is on
        // screen — otherwise an unmounted tile keeps its id in the warm set.
        return () => {
          observerRef.current?.unobserve(el);
          setVisible((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        };
      };
      refCallbacks.current.set(id, cb);
      return cb;
    },
    [hasObserver],
  );

  // What to ask for: the observer's answer where there is one, else the capped
  // prefix. The fallback is load-bearing rather than defensive — jsdom has no
  // `IntersectionObserver`, and neither does a browser that lacks the API, and
  // "warm nothing" there would ship blank thumbnails.
  const wanted = useMemo(() => {
    if (!ATTACHMENT_REFS_NEED_WARMING || key === "") return [];
    const all = key.split(",");
    if (!hasObserver) return all.slice(0, MAX_WARMED_IDS);
    return all.filter((id) => visible.has(id)).slice(0, MAX_WARMED_IDS);
  }, [key, hasObserver, visible]);

  const wantedKey = wanted.join(",");

  useEffect(() => {
    if (wantedKey === "") return;
    let cancelled = false;
    void warmAttachmentUrls(wantedKey.split(","))
      .then((changed) => {
        if (cancelled || changed.length === 0) return;
        setWarmed((prev) => {
          const next = new Map(prev);
          for (const id of changed) next.set(id, (next.get(id) ?? 0) + 1);
          return next;
        });
      })
      .catch(() => {
        // Best-effort, and per-id inside the seam: one attachment that will not
        // decrypt must not blank the rest. Anything unwarmed keeps the pending
        // placeholder, which is what a failed desktop fetch shows too.
      });
    return () => {
      cancelled = true;
    };
  }, [wantedKey]);

  const warmKey = useCallback(
    (id: string) => {
      const n = warmed.get(id);
      return n === undefined ? id : `${id}:${n}`;
    },
    [warmed],
  );

  return { warmKey, observeItem };
}
