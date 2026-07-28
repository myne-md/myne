// desktop-ingest task 6 — the host→WebView dispatch listener
// (MYND-442/MYND-445, browser-extension epic, sub-feature `desktop-ingest`).
//
// WHAT THIS IS
// ------------
// The WebView half of the clipper's host→WebView dispatch seam. The Rust relay
// re-validates every ext→host frame (token / caps / rate-limit / locked), then
// FORWARDS the validated envelope to the WebView over a Tauri event
// (`clipper://dispatch`). This component listens for that event, runs the
// already-built `assembleClip` (the importer-reusing assembly pipeline) + seals
// via the normal `note_create`, then replies with a TINY outcome via the
// `clip_dispatch_complete` command — closing the round-trip.
//
// THE CONTRACT (verbatim — the Rust half emits/expects EXACTLY this)
// ------------------------------------------------------------------
//   - Inbound event:  `listen("clipper://dispatch")`, payload =
//     `{ requestId, markdownBody, captureKind, sourceUrl, clipDate, imageBytes }`
//     (`imageBytes` is an array of byte-arrays — bytes only, NO filename).
//   - Outbound cmd:   `invoke("plugin:clipper-pairing|clip_dispatch_complete", { requestId, outcome })`
//     where `outcome ∈ {"accepted","locked","error"}` — the outcome STRING only.
//
// THE TINY-REPLY / NO-LEAK RULE
// -----------------------------
// Only the outcome string crosses back. The note id + media counts stay
// WebView-local (held in `lastResult` for the toast) and NEVER ride the reply —
// the browser extension never learns the sealed note's id or image tally.
//
// LOCKED-VAULT SELF-GUARD
// -----------------------
// Mounting this always is safe: when the vault is locked, `assembleClip`'s own
// `isVaultUnlocked` gate returns `{ kind: "locked" }` and writes NOTHING (and in
// practice the Rust relay short-circuits a locked vault before it even emits).
//
// STRICT-MODE SAFETY
// ------------------
// The `listen` setup is async; React 19 strict-mode double-mounts effects. We
// use the standard `let active = true` / cancel pattern so a fast unmount before
// the listen resolves immediately tears the handle down (no leaked listener) —
// mirrors `Editor.tsx`'s `vault-lock-imminent` listen/unlisten idiom.

import { useEffect, useRef, useState } from "react";
import { listen } from "../platform/event";
import { invoke } from "../platform/core";

import { Toast } from "../components/Toast";
import {
  assembleClip,
  defaultClipAssemblyDeps,
  type ClipPlaintextComposer,
  type ClipIngestResult,
} from "./assembleClip";
import { buildClipNotice, type ClipNotice } from "./buildClipNotice";
import { composeBookmarkPlaintext } from "./composeBookmarkPlaintext";
import {
  buildRawEnvelopeFromDispatch,
  type ClipDispatchPayload,
} from "./clipDispatchEnvelope";
import { mapResultToOutcome } from "./clipDispatchReply";

/** Props — the listener mounts INSIDE the workspace providers (in `Editor.tsx`)
 *  so the notice's "view" affordance can open the newly-clipped note. */
interface ClipDispatchListenerProps {
  /** Open the clipped note (the "view" affordance). Wired to the workspace
   *  note-open (`onSelectNote` → `ctx.open`). Optional so the component still
   *  mounts in a context without a note-open (the action no-ops then). */
  readonly onViewNote?: (noteId: string) => void;
  /** Fired after a clip seals a NEW note, so the host can refresh the sidebar
   *  (a programmatic clip note_create otherwise never triggers the list reload
   *  the normal "+ New Note" flow does). Optional. */
  readonly onNoteCreated?: () => void;
}

/**
 * The host→WebView clip-dispatch listener. Mounted once inside the workspace
 * providers (`Editor.tsx`), where the note-open is in scope. It wires itself to
 * the `clipper://dispatch` event on mount and tears the handle down on unmount.
 */
export function ClipDispatchListener({
  onViewNote,
  onNoteCreated,
}: ClipDispatchListenerProps) {
  // Keep the latest `onNoteCreated` in a ref so the (long-lived) `listen` effect
  // closure calls the current callback without re-subscribing every render.
  const onNoteCreatedRef = useRef(onNoteCreated);
  onNoteCreatedRef.current = onNoteCreated;

  // The last accepted clip's NOTICE — held WebView-local for the success toast.
  // Built from the WebView-local result (note id + counts); NEVER crosses back
  // to the relay (no-leak rule). `null` ⇒ no toast showing.
  const [notice, setNotice] = useState<ClipNotice | null>(null);

  useEffect(() => {
    // Strict-mode / fast-unmount guard: the `listen` setup is async, so a quick
    // unmount before it resolves must still tear down the handle. Mirrors
    // `Editor.tsx`'s `vault-lock-imminent` cancelled-guard shape.
    let active = true;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const handle = await listen<ClipDispatchPayload>(
          "clipper://dispatch",
          (event) => {
            if (!active) return;
            void handleDispatch(event.payload);
          },
        );
        if (!active) {
          handle();
        } else {
          unlisten = handle;
        }
      } catch {
        // Not inside Tauri (browser dev shim) → no-op.
      }
    })();

    async function handleDispatch(payload: ClipDispatchPayload): Promise<void> {
      // Build the RAW (hostile) envelope from the wire payload — byte lift +
      // synthesized per-image filenames. `assembleClip` owns the boundary gate.
      const rawEnvelope = buildRawEnvelopeFromDispatch(payload);

      // The captureKind decision lives HERE (the caller), never inside
      // `assembleClip` (which must not branch on captureKind). A bookmark
      // (sub-feature 5, MYND-447) is a SYNC-16 content-light note: swap in a
      // content-light body (the bare-autolink source URL) + the bookmark composer
      // (managed `title:` + `source:`/`clipped:`). The title folds into the wire
      // `markdownBody` (`# <title>\n\n<url>`, `buildBookmarkEnvelope` — the Rust
      // envelope has no `page_title` field), so extract it here. A clip leaves the
      // body = `markdownBody` and the composer defaulted (byte-for-byte unchanged).
      const isBookmark = payload.captureKind === "bookmark";
      const body = isBookmark ? payload.sourceUrl + "\n" : payload.markdownBody;
      // The bookmark composer re-derives the body line from `url`, so it ignores
      // the resolved-body arg the seam passes (the content-light bare URL has no
      // wikilinks / images to splice). Title is lifted from the wire `markdownBody`.
      const composePlaintext: ClipPlaintextComposer | undefined = isBookmark
        ? (envelope) =>
            composeBookmarkPlaintext({
              url: envelope.sourceUrl,
              title: bookmarkTitleFromBody(payload.markdownBody),
              clippedDate: envelope.clipDate,
            })
        : undefined;

      // Assemble + seal. The body is the caller-supplied param; the composer is
      // the caller-supplied seam (defaulted for a clip). On a locked vault this
      // returns `{ kind: "locked" }` and writes nothing.
      // Guard the whole assembly. assembleClip try/catches its noteCreate seal
      // internally, but its earlier awaits (isVaultUnlocked / loadResolverNotes
      // IPC) can still reject; an unguarded throw here would skip the reply below,
      // hanging the relay to its 30 s timeout (+ an unhandled rejection). Map any
      // throw to an error result so a reply is ALWAYS sent.
      let result: ClipIngestResult;
      try {
        result = await assembleClip(
          rawEnvelope,
          body,
          defaultClipAssemblyDeps(),
          composePlaintext,
        );
      } catch {
        result = { kind: "error", reason: "assembly-threw" };
      }

      // Reply with the TINY outcome string ONLY (no note id, no counts).
      const outcome = mapResultToOutcome(result);
      try {
        // The command lives on the `clipper-pairing` plugin (same bundle as
        // `pairing_dispatch_complete`), so it MUST carry the `plugin:` prefix —
        // a bare name does not route, throws, and (swallowed below) leaves the
        // relay to time out at 30 s with the note already sealed ("couldn't clip"
        // while it actually saved). Keep in step with the Rust registration.
        await invoke("plugin:clipper-pairing|clip_dispatch_complete", {
          requestId: payload.requestId,
          outcome,
        });
      } catch {
        // Reply delivery is best-effort from the WebView's side; a failed reply
        // does not undo the seal. Swallow so a relay hiccup can't throw here.
      }

      // On success, build the success NOTICE (root message + omitted-by-type
      // tally + the note id the "view" affordance opens) from the WebView-local
      // result and surface it. Drop if the component unmounted mid-assembly.
      if (active && result.kind === "accepted") {
        setNotice(buildClipNotice(result));
        // Refresh the sidebar so the just-clipped note appears live (the
        // programmatic note_create doesn't go through the "+ New Note" reload).
        onNoteCreatedRef.current?.();
      }
    }

    return () => {
      active = false;
      if (unlisten !== undefined) unlisten();
    };
  }, []);

  // The "clipped to root — view" notice. Non-blocking (no confirm/preview gate):
  // the toast auto-dismisses like every other toast and the user keeps working.
  // The "view" action opens the new note via `onViewNote` (→ workspace note-
  // open) and clears the notice. When media degraded, the omitted-by-type tally
  // renders PROMINENTLY by riding on the message line (one entry per omitted
  // class) — a single clip losing its hero image is surprising, so it is not
  // tucked away. `null` notice ⇒ nothing renders.
  return (
    <Toast
      message={notice === null ? null : composeNoticeMessage(notice)}
      onDone={() => setNotice(null)}
      action={
        notice === null
          ? undefined
          : {
              label: notice.viewLabel,
              onAction: () => {
                const id = notice.noteId;
                setNotice(null);
                onViewNote?.(id);
              },
            }
      }
    />
  );
}

/**
 * Compose the toast's displayed line: the root message, then — when media was
 * omitted — the per-type tally appended PROMINENTLY (each entry's load-bearing
 * line, separated by a middot). No tally ⇒ the bare root line. Pure; the parts
 * are the load-bearing constants `buildClipNotice` resolved.
 */
function composeNoticeMessage(notice: ClipNotice): string {
  if (notice.tally === null) return notice.message;
  const tally = notice.tally.map((entry) => entry.line).join(" · ");
  return `${notice.message} ${tally}`;
}

/**
 * Recover the page TITLE the extension folded into the bookmark's wire
 * `markdown_body`. The Rust handoff envelope has NO `page_title` field, so
 * `buildBookmarkEnvelope` (myne-clipper) emits the body as `# <title>\n\n<url>`
 * (or the bare `<url>` alone when the title is empty). The desktop composer wants
 * the title as the managed `title:`, so lift it from the leading `# ` heading.
 *
 * Returns `""` when there is no leading-heading title (an empty / heading-less
 * body) — the composer then writes an empty managed `title:` (which the dialect
 * renders as "Untitled", the correct degenerate). Pure; the URL is taken from
 * `envelope.sourceUrl`, never re-parsed out of the body.
 */
function bookmarkTitleFromBody(markdownBody: string): string {
  const firstLine = markdownBody.split("\n", 1)[0] ?? "";
  const headingMatch = /^#\s+(.*)$/.exec(firstLine);
  return headingMatch !== null ? (headingMatch[1] ?? "").trim() : "";
}
