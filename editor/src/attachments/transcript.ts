// Inline transcript UI for the audio-attachment widget (voice-to-text MYND-552).
//
// Owns the per-audio-note transcript surface that lives UNDER the player: the
// in-flight progress affordance (busy chrome + live partial-transcript preview +
// a Stop button that drives the SYNC-V5 cancel), the completed READ-ONLY
// transcript expander (TB2 — `textContent` only, never interpreted), the
// load-bearing transcript-fallibility honesty note (SYNC-V8, rendered VERBATIM
// via the host, never i18n'd), and the explicit "Insert transcript into note"
// action that writes the text into the note body through the ordinary editor
// dispatch / autosave (MY01) path (SYNC-V1 hybrid + SYNC-17 explicit-action).
//
// The section calls ONLY the `EditorHost.transcribe` slot (SYNC-V7) — never
// Tauri directly — so `@myne/editor` stays platform-agnostic. A completed
// transcript is cached per-attachment for the session so the expander re-renders
// synchronously when CM6 rebuilds the widget on a viewport change (mirrors the
// text-preview cache); the cached copy is free to be re-derived on re-transcribe
// and never clobbers an already-inserted, possibly user-edited note-body copy.

import type { EditorView } from "@codemirror/view";
import i18n from "@myne/editor/i18n";
import { getHost, type TranscribeHandle, type TranscribeErrorKind } from "../host";
import { showAttachmentToast } from "./toast";
import { ensureAttachmentInsertStyles } from "./styles";
import { isCurrentGeneration, sessionGeneration, transcriptStore } from "./session-caches";

// The session cache of the last completed transcript per attachment id lets the
// expander re-render synchronously when the widget's DOM is rebuilt on scroll
// (same posture as the text-preview cache). It holds the user's own decrypted
// content, so it lives in `./session-caches` with the vault-leaving reset beside
// it.
//
// Its comment here used to end "dropped when the module unloads (lock/quit tears
// down the editor)", and that is what kept it off the teardown roster. A JS
// module never unloads: the idle auto-lock path reloads the WebView, the manual
// Lock button and the vault SWITCH do not, so one vault's transcript text was
// still resident in the next vault's session.

/** i18n key for each actionable transcription-failure cause (MYND-591). Keyed by
 *  the normalized {@link TranscribeErrorKind} minus `"failed"` (which is a
 *  transient toast, not a persistent hint). */
const HINT_KEY: Record<Exclude<TranscribeErrorKind, "failed">, string> = {
  feature_off: "editor.attachment.widget.transcribe.cause.featureOff",
  vault_locked: "editor.attachment.widget.transcribe.cause.vaultLocked",
  no_model: "editor.attachment.widget.transcribe.cause.noModel",
  model_load_failed: "editor.attachment.widget.transcribe.cause.modelLoadFailed",
  too_long: "editor.attachment.widget.transcribe.cause.tooLong",
};

export interface TranscriptSection {
  /** The container appended under the audio player's time row. */
  readonly container: HTMLElement;
  /** Begin a transcription run (the ⋮ "Transcribe" row calls this). */
  start(): void;
  /** Tear down: cancel any in-flight run so a torn-down widget cannot leave the
   *  backend transcribing into a dead channel. */
  teardown(): void;
}

/**
 * Build the transcript section for one audio attachment. On construction it
 * renders the cached transcript expander if the note was already transcribed
 * this session; otherwise the container starts empty until `start()` runs.
 */
export function createTranscriptSection(opts: {
  view: EditorView;
  id: string;
}): TranscriptSection {
  const { view, id } = opts;

  ensureAttachmentInsertStyles(); // the busy-meter @keyframes live in the global sheet

  const container = document.createElement("span");
  container.className = "cm-attachment-audio-transcript-section";

  let handle: TranscribeHandle | null = null;
  let stopped = false;

  const clear = (): void => {
    container.replaceChildren();
  };

  // ---- completed read-only expander (TB2 textContent) ----------------------
  const renderExpander = (transcript: string): void => {
    clear();

    const wrap = document.createElement("span");
    wrap.className = "cm-attachment-audio-transcript";

    // Expander toggle (heading) — collapses the read-only body.
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "cm-attachment-audio-transcript-toggle";
    toggle.setAttribute("aria-expanded", "true");
    toggle.textContent = i18n.t("editor.attachment.widget.transcribe.heading");
    wrap.appendChild(toggle);

    const bodyWrap = document.createElement("span");
    bodyWrap.className = "cm-attachment-audio-transcript-bodywrap";

    // The read-only transcript text. `data-testid` targets exactly the text so a
    // test/E2E assertion reads the transcript, not the surrounding chrome.
    const body = document.createElement("span");
    body.className = "cm-attachment-audio-transcript-body";
    body.setAttribute("data-testid", "attachment-audio.transcript");
    body.setAttribute("role", "region");
    body.setAttribute("aria-label", i18n.t("editor.attachment.widget.transcribe.heading"));
    // textContent only — an ASR transcript is inert text, never interpreted (TB2).
    body.textContent = transcript;
    bodyWrap.appendChild(body);

    // Load-bearing transcript-fallibility honesty note (SYNC-V8), rendered
    // VERBATIM from the host (never i18n'd). Skipped if the host omits it.
    const honesty = getHost().transcriptHonestyNote;
    if (honesty !== undefined && honesty !== "") {
      const note = document.createElement("span");
      note.className = "cm-attachment-audio-transcript-note";
      note.textContent = honesty;
      bodyWrap.appendChild(note);
    }

    // Explicit "Insert transcript into note" (SYNC-V1 hybrid / SYNC-17): writes
    // the transcript into the note body through the ordinary dispatch/autosave
    // (MY01) path — never a silent auto-write. Non-destructive: it APPENDS at the
    // note end, so re-transcription never clobbers an already-inserted copy.
    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "cm-attachment-audio-transcript-insert";
    insert.setAttribute("data-testid", "attachment-audio.transcript-edit");
    insert.textContent = i18n.t("editor.attachment.widget.transcribe.insert");
    insert.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      insertTranscript(view, transcript);
    });
    bodyWrap.appendChild(insert);

    wrap.appendChild(bodyWrap);

    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = toggle.getAttribute("aria-expanded") !== "false";
      toggle.setAttribute("aria-expanded", open ? "false" : "true");
      bodyWrap.hidden = open;
      // The inline half of the pair, for the reason `base.css` documents: this
      // element's class carries `display: block` (theme.ts), which outranked the
      // attribute and left `aria-expanded="false"` describing a body that was
      // still on screen — a collapse that lied to assistive technology as well
      // as to the eye. Clearing the value restores the stylesheet's `block`.
      bodyWrap.style.display = open ? "none" : "";
    });

    container.appendChild(wrap);
  };

  // ---- per-cause hint (feature off / vault locked / no model / load fail) ----
  const renderCause = (kind: Exclude<TranscribeErrorKind, "failed">): void => {
    clear();
    const hint = document.createElement("span");
    hint.className = "cm-attachment-audio-transcript-hint";
    hint.setAttribute("data-testid", "attachment-audio.transcript-hint");
    hint.textContent = i18n.t(HINT_KEY[kind]);
    container.appendChild(hint);
  };

  // ---- in-flight progress affordance + Stop --------------------------------
  const renderProgress = (): { onSegment: (segment: string) => void } => {
    clear();
    const progress = document.createElement("span");
    progress.className = "cm-attachment-audio-transcript-progress";
    progress.setAttribute("data-testid", "attachment-audio.transcript-progress");
    progress.setAttribute("role", "status");

    const label = document.createElement("span");
    label.className = "cm-attachment-audio-transcript-progress-label";
    label.textContent = i18n.t("editor.attachment.widget.transcribe.progress");
    progress.appendChild(label);

    // Indeterminate busy meter — a small animated bar row echoing the recording
    // bar's VU chrome (no live level to drive here, so it is CSS-animated).
    const meter = document.createElement("span");
    meter.className = "cm-attachment-audio-transcript-meter";
    for (let i = 0; i < TRANSCRIPT_METER_BARS; i++) {
      const bar = document.createElement("span");
      bar.className = "cm-attachment-audio-transcript-bar";
      // State-carrying motion, so it opts IN to the reduced-motion exemption
      // (MYND-630, reaffirmed by `myne-agents/docs/decisions/ui/0632`): the blanket
      // `animation-duration: 0ms` would freeze a busy meter mid-cycle, which
      // reads as hung rather than as calm. The exemption slows it to half speed
      // instead. The default for any new animation stays suppressed — this is
      // an opt-in, and a decorative one must not take it.
      bar.setAttribute("data-motion", "essential");
      // The stagger index only. `animation-delay` is computed in CSS from
      // `--stagger-step` / `--stagger-max`, so the canon's stagger tokens are the
      // single source and this loop stays free of `getComputedStyle`.
      bar.style.setProperty("--stagger-index", String(i));
      meter.appendChild(bar);
    }
    progress.appendChild(meter);

    // Live partial-transcript preview — the SYNC-V5 segments concatenated as they
    // arrive. textContent only (TB2).
    const preview = document.createElement("span");
    preview.className = "cm-attachment-audio-transcript-preview";
    progress.appendChild(preview);

    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "cm-attachment-audio-transcript-stop";
    stop.setAttribute("data-testid", "attachment-audio.transcript-stop");
    stop.textContent = i18n.t("editor.attachment.widget.transcribe.stop");
    stop.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // User Stop: cancel the run and commit NO partial transcript — drop back to
      // the prior state (a cached expander if one exists, else empty).
      stopped = true;
      handle?.stop();
      handle = null;
      const cached = transcriptStore.get(id);
      if (cached !== undefined) renderExpander(cached);
      else clear();
    });
    progress.appendChild(stop);

    container.appendChild(progress);

    let partial = "";
    return {
      onSegment: (segment: string) => {
        partial += segment;
        preview.textContent = partial;
      },
    };
  };

  const start = (): void => {
    const host = getHost();
    if (host.transcribe === undefined) return; // slot absent → nothing to run
    if (handle !== null) return; // already running

    stopped = false;
    const { onSegment } = renderProgress();
    // Captured at ISSUE and compared before the store below. `stopped` covers a
    // user cancel; it does not cover a LOCK or a vault switch, which clear the
    // store without cancelling a transcription already running, so a late
    // resolution wrote the previous vault's transcript text into the next
    // session's cache. `resetTranscripts` bumps this.
    const issuedAt = sessionGeneration();
    handle = host.transcribe(view, id, { onSegment });

    handle.done
      .then((transcript) => {
        handle = null;
        if (stopped) return; // user cancelled — ignore any late resolution
        // The vault this read belongs to is no longer open. Dropping it is the
        // right answer: there is nothing to render into and nowhere to store it.
        if (!isCurrentGeneration(issuedAt)) return;
        transcriptStore.set(id, transcript);
        renderExpander(transcript);
      })
      .catch((err: unknown) => {
        handle = null;
        if (stopped) return; // user cancelled — no error surfaced
        const kind = (err as { kind?: TranscribeErrorKind } | null)?.kind ?? "failed";
        if (kind !== "failed") {
          // Actionable cause (MYND-591): a persistent inline hint naming the
          // truthful reason (feature off / vault locked / no model / load fail).
          renderCause(kind);
          return;
        }
        // Any other failure: a transient toast, then drop back to the prior
        // state (cached expander if present, else empty).
        showAttachmentToast(i18n.t("editor.attachment.widget.transcribe.failed"), "error");
        const cached = transcriptStore.get(id);
        if (cached !== undefined) renderExpander(cached);
        else clear();
      });
  };

  const teardown = (): void => {
    if (handle !== null) {
      stopped = true;
      handle.stop();
      handle = null;
    }
  };

  // Re-render the cached transcript synchronously on a viewport rebuild.
  const cached = transcriptStore.get(id);
  if (cached !== undefined) renderExpander(cached);

  return { container, start, teardown };
}

/** Append the transcript to the note body via the ordinary editor dispatch —
 *  the same `note_save`/MY01 path a manual edit takes (SYNC-17). Appends at the
 *  document end with a blank-line separator so it never overwrites existing note
 *  content (non-destructive re-transcription). A detached view is a no-op. */
function insertTranscript(view: EditorView, transcript: string): void {
  if (!view.dom.isConnected) return;
  const at = view.state.doc.length;
  const insert = (at > 0 ? "\n\n" : "") + transcript;
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor: at + insert.length },
    userEvent: "input.transcript-insert",
  });
  view.focus();
}

/** Bars in the indeterminate transcription busy meter. */
const TRANSCRIPT_METER_BARS = 5;
