// Atomic widgets for the editor attachment render path (epic MYND-164 + 147/149).
//
// Four widget families, all `Decoration.replace({ widget, atomic: true })`:
//   - `AttachmentImageWidget` — a resolved raster/SVG attachment, inline image
//     via `<img src="attachment://<id>">`. SVG renders ONLY through `<img>`
//     (secure static mode) — its markup is NEVER inlined into the DOM.
//   - `AttachmentPdfWidget` — a resolved PDF, rendered as a bounded scrollable
//     multi-page reader via pdf.js (lazy per-page render), with a MANDATORY
//     generic-PDF-icon fallback (SYNC-5). Clicking opens the bigger lightbox
//     reader (parallels the image click→lightbox).
//   - `AttachmentTombstoneWidget` — an unresolved `att:` id: "deleted" (was in
//     the catalog once → muted image-off) vs "broken" (never existed / malformed
//     → danger-tinted). Note bytes are NEVER rewritten.
//   - `UrlImageChipWidget` — a NON-FETCHING placeholder chip for `![](url)` /
//     `![][ref]`: icon + alt label, URL on hover-tooltip, click-through
//     suppressed. Never issues a network request, never an `<img>` for the URL.
//
// All visible text is set via `textContent` (never `innerHTML`) per TB2.

import { type EditorView, WidgetType } from "@codemirror/view";
import i18n from "@myne/editor/i18n";
import { attachmentUrl } from "@myne/editor/host/notes/attachmentRef";
import { makeAttachmentIcon } from "./icons";
import type { CatalogRow } from "./catalog";
import { mountPdfScroller } from "./pdf-reader";
import { makeProgressChip } from "./progress";
import { showAttachmentLightbox } from "./lightbox";
import { fileTypeLabel } from "./fileKind";
import { formatBytes, formatClock } from "@myne/editor/host/components/attachments/format";
import {
  exportAttachment,
  removeFileCard,
  renameFileCard,
  revealFileCard,
} from "./fileCardActions";
import { buildOverflowMenu } from "./actionMenu";
import { decodePeaks } from "./waveform";

/** Width (CSS px) the inline image / PDF frame renders at. */
const FRAME_WIDTH = 320;

/** Tombstone flavor: a deleted attachment (id was once in the catalog) vs a
 *  broken reference (malformed `att:` target — never a valid id). */
export type TombstoneKind = "deleted" | "broken";

// --- resolved raster / SVG -------------------------------------------------

export class AttachmentImageWidget extends WidgetType {
  constructor(
    private readonly id: string,
    private readonly filename: string,
  ) {
    super();
  }

  eq(other: AttachmentImageWidget): boolean {
    return other.id === this.id && other.filename === this.filename;
  }

  toDOM(): HTMLElement {
    const frame = document.createElement("span");
    frame.className = "cm-attachment-frame";
    frame.setAttribute("role", "img");
    frame.setAttribute("aria-label", this.filename);

    const url = attachmentUrl(this.id);

    // Clean progress chip ("Loading…") until the first decrypt+decode paints —
    // NOT the struck/tombstone style. Removed once the <img> fires `load`.
    const loading = makeProgressChip("loading");
    frame.appendChild(loading);

    const img = document.createElement("img");
    img.className = "cm-attachment-img";
    // attachment://<id> — the Rust handler decrypts in-memory + re-sniffs +
    // allowlists. SVG is served as image/svg+xml and rendered here ONLY through
    // the `<img>` element (secure static mode); its markup never enters the DOM.
    img.src = url;
    img.alt = this.filename;
    img.style.maxWidth = `${FRAME_WIDTH}px`;
    // Hidden until decoded so the progress chip is the only thing visible while
    // the bytes decrypt; swap on load (or drop the chip on error so a genuine
    // broken-image affordance still surfaces).
    img.style.display = "none";
    img.addEventListener("load", () => {
      img.style.display = "";
      loading.remove();
    });
    img.addEventListener("error", () => {
      loading.remove();
    });
    // Click the rendered image → full-size lightbox preview (same decrypted
    // source). Cursor + title hint the affordance.
    img.style.cursor = "zoom-in";
    img.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showAttachmentLightbox({ url, alt: this.filename, id: this.id });
    });
    frame.appendChild(img);

    return frame;
  }

  // Let the click reach the <img> handler (lightbox) rather than being
  // swallowed as a CM event; the widget stays atomic (no source-lift) because
  // it never mutates the document or selection.
  ignoreEvent(): boolean {
    return false;
  }
}

// --- resolved PDF (pdf.js first page, icon fallback) -----------------------

export class AttachmentPdfWidget extends WidgetType {
  constructor(
    private readonly id: string,
    private readonly filename: string,
  ) {
    super();
  }

  eq(other: AttachmentPdfWidget): boolean {
    return other.id === this.id && other.filename === this.filename;
  }

  toDOM(): HTMLElement {
    const frame = document.createElement("span");
    frame.className = "cm-attachment-frame cm-attachment-pdf";
    frame.setAttribute("role", "img");
    frame.setAttribute("aria-label", this.filename);

    // The bounded, scrollable reader: the visible scroll container the pages
    // stack in + the IntersectionObserver roots against. It is NEVER hidden —
    // a `display:none` container has no layout, so the observer rooted at it
    // would never fire (the old hidden-until-first-paint deadlock). The reader
    // shows its own small "Loading…" chip inside until the first page paints.
    const scroller = document.createElement("div");
    scroller.className = "cm-attachment-pdf-scroller";
    // Clicking the inline reader opens the BIGGER lightbox reader (parallels the
    // image click→lightbox). zoom-in cursor hints the affordance.
    scroller.style.cursor = "zoom-in";
    scroller.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showAttachmentLightbox({
        url: attachmentUrl(this.id),
        alt: this.filename,
        kind: "pdf",
        id: this.id,
      });
    });
    frame.appendChild(scroller);

    this.cleanup = mountPdfScroller(scroller, {
      url: attachmentUrl(this.id),
      pageWidth: FRAME_WIDTH,
      onError: () => {
        // MANDATORY generic-PDF-icon fallback (SYNC-5): pdf.js absent / failed.
        // Already warned (DENY-list-safe) inside the scroller, which has cleared
        // the scroll container. Swap the whole reader for the generic PDF icon.
        const fallback = document.createElement("span");
        fallback.className = "cm-attachment-pdf-fallback";
        fallback.appendChild(makeAttachmentIcon("file"));
        const label = document.createElement("span");
        label.className = "cm-attachment-pdf-fallback-label";
        label.textContent = i18n.t("editor.attachment.widget.pdfFallback");
        fallback.appendChild(label);
        scroller.replaceChildren(fallback);
        scroller.style.cursor = "default";
      },
    });

    return frame;
  }

  // Tear the reader down (pdf.js task.destroy + observer disconnect) if CM
  // discards this widget's DOM.
  private cleanup: (() => void) | null = null;
  destroy(): void {
    this.cleanup?.();
    this.cleanup = null;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// --- tombstone (deleted / broken) ------------------------------------------

export class AttachmentTombstoneWidget extends WidgetType {
  constructor(
    private readonly kind: TombstoneKind,
    private readonly filename: string,
  ) {
    super();
  }

  eq(other: AttachmentTombstoneWidget): boolean {
    return other.kind === this.kind && other.filename === this.filename;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement("span");
    chip.className =
      this.kind === "deleted"
        ? "cm-attachment-tombstone cm-attachment-tombstone-deleted"
        : "cm-attachment-tombstone cm-attachment-tombstone-broken";
    chip.setAttribute("role", "img");
    chip.setAttribute(
      "aria-label",
      this.kind === "deleted"
        ? i18n.t("editor.attachment.widget.tombstone.deletedAria", { filename: this.filename })
        : i18n.t("editor.attachment.widget.tombstone.brokenAria", { filename: this.filename }),
    );

    chip.appendChild(
      makeAttachmentIcon(this.kind === "deleted" ? "image-off" : "file-warning"),
    );

    const label = document.createElement("span");
    label.className = "cm-attachment-tombstone-label";
    label.textContent =
      this.filename ||
      (this.kind === "deleted"
        ? i18n.t("editor.attachment.widget.tombstone.deletedLabel")
        : i18n.t("editor.attachment.widget.tombstone.brokenLabel"));
    chip.appendChild(label);

    return chip;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// --- non-fetching `![](url)` / `![][ref]` chip -----------------------------

export class UrlImageChipWidget extends WidgetType {
  constructor(
    private readonly alt: string,
    private readonly url: string,
  ) {
    super();
  }

  eq(other: UrlImageChipWidget): boolean {
    return other.alt === this.alt && other.url === this.url;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement("span");
    // NEUTRAL chip family (not accent) per the design pass.
    chip.className = "cm-attachment-url-chip";
    chip.setAttribute("role", "img");
    // The raw URL is exposed only as a non-navigating hover tooltip; the chip
    // never fetches it and never offers an "open in browser" affordance.
    chip.title = this.url;

    chip.appendChild(makeAttachmentIcon("image"));

    const label = document.createElement("span");
    label.className = "cm-attachment-url-chip-label";
    // "image (not loaded)" reads at a glance; the alt (if any) names it.
    label.textContent = this.alt !== "" ? this.alt : i18n.t("editor.attachment.widget.urlImageFallback");
    chip.appendChild(label);

    return chip;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// --- resolved generic file (export-only file-card, MYND-173) ---------------

/**
 * A resolved NON-renderable attachment (a generic file — `.docx`, `.zip`,
 * etc., stored as `application/octet-stream`). Renders as a compact card:
 * a file-type icon, the filename, a "type · size" line, and a "⋯" overflow
 * menu (Export / Rename / Remove / Reveal in library). The file content is
 * never rendered inline — "using" the file means Export (MYND-173). The widget
 * is self-contained: CM6 hands it the `EditorView` in `toDOM`, so its menu
 * actions resolve the live document position themselves.
 */
export class AttachmentFileCardWidget extends WidgetType {
  /** Tear-down for the body-mounted overflow menu, so `destroy()` can close it
   *  (and remove its document listener) if CM6 discards the widget while it's
   *  open. */
  private menuTeardown: (() => void) | null = null;

  constructor(
    private readonly id: string,
    private readonly filename: string,
    private readonly size: number,
  ) {
    super();
  }

  eq(other: AttachmentFileCardWidget): boolean {
    return (
      other.id === this.id &&
      other.filename === this.filename &&
      other.size === this.size
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement("span");
    card.className = "cm-attachment-file-card";
    card.setAttribute("data-testid", "attachment-card");
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", this.filename);

    const icon = makeAttachmentIcon("file");
    icon.classList.add("cm-attachment-file-card-icon");
    card.appendChild(icon);

    const text = document.createElement("span");
    text.className = "cm-attachment-file-card-text";

    const name = document.createElement("span");
    name.className = "cm-attachment-file-card-name";
    name.textContent = this.filename;
    text.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "cm-attachment-file-card-meta";
    // textContent (never innerHTML) per TB2. The type label is resolved here
    // (at render) rather than cached in the constructor, so it tracks a
    // language switch.
    meta.textContent = `${fileTypeLabel(this.filename)} · ${formatBytes(this.size)}`;
    text.appendChild(meta);

    card.appendChild(text);

    const menu = buildOverflowMenu(
      [
        { label: i18n.t("editor.attachment.widget.menu.export"), testid: "attachment-card.export", run: () => void exportAttachment(this.id, this.filename) },
        { label: i18n.t("editor.attachment.widget.menu.rename"), testid: "attachment-card.rename", run: () => void renameFileCard(view, this.id, this.filename) },
        { label: i18n.t("editor.attachment.widget.menu.remove"), testid: "attachment-card.remove", run: () => removeFileCard(view, card, this.id) },
        { label: i18n.t("editor.attachment.widget.menu.reveal"), testid: "attachment-card.reveal", run: () => revealFileCard(view, this.id) },
      ],
      { buttonTestId: "attachment-card.menu-button", menuTestId: "attachment-card.menu" },
    );
    this.menuTeardown = menu.teardown;
    card.appendChild(menu.wrap);
    return card;
  }

  // If CM6 discards the widget while its menu is open, tear the menu down so its
  // document `mousedown` listener cannot outlive the DOM.
  destroy(): void {
    this.menuTeardown?.();
    this.menuTeardown = null;
  }

  // Let clicks reach the menu button / items rather than being swallowed as a
  // CM event; the widget stays atomic (it never mutates doc/selection itself —
  // the actions do, through their own dispatches).
  ignoreEvent(): boolean {
    return false;
  }
}

// --- resolved audio (inline voice-note / audio-file player, MYND-259) ------

/**
 * A resolved audio attachment (a recorded voice note or an imported audio
 * file, served as `audio/wav`). Renders as an inline player: a circular
 * play/pause button, a seek track (the waveform overlays this in a later
 * slice), a `0:00 / 0:00` mono time readout, and the shared "⋯" overflow menu
 * (Export / Rename / Remove / Reveal). Playback runs a hidden `<audio>`
 * element fed from `attachment://<id>` (decrypted in-memory + re-sniffed +
 * allowlisted Rust-side). All visible text is set via `textContent` per TB2.
 */
export class AttachmentAudioWidget extends WidgetType {
  private teardown: (() => void) | null = null;

  constructor(
    private readonly id: string,
    private readonly filename: string,
  ) {
    super();
  }

  eq(other: AttachmentAudioWidget): boolean {
    return other.id === this.id && other.filename === this.filename;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("span");
    root.className = "cm-attachment-audio";
    root.setAttribute("data-testid", "attachment-audio");
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", this.filename);

    // The playback engine: a hidden media element. `attachment://<id>` is
    // decrypted in-memory, re-sniffed, and allowlist-fenced (audio/wav) by the
    // Rust handler — no plaintext on disk, no network.
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = attachmentUrl(this.id);
    audio.style.display = "none";
    root.appendChild(audio);

    // Filename — top-left of the card.
    const name = document.createElement("span");
    name.className = "cm-attachment-audio-name";
    name.setAttribute("data-testid", "attachment-audio.name");
    // Display the name without its extension — the name is enough on the card
    // (rename/export still use the full filename).
    name.textContent = stripFileExtension(this.filename);
    root.appendChild(name);

    // Middle row: play button + waveform track + overflow menu, vertically
    // centered together (the play button aligns with the waveform line).
    const row = document.createElement("span");
    row.className = "cm-attachment-audio-row";

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "cm-attachment-audio-play";
    playBtn.setAttribute("data-testid", "attachment-audio.play");
    playBtn.setAttribute("aria-label", i18n.t("editor.attachment.widget.audio.play"));
    playBtn.appendChild(makeAttachmentIcon("play"));
    row.appendChild(playBtn);

    const track = document.createElement("span");
    track.className = "cm-attachment-audio-track";
    track.setAttribute("data-testid", "attachment-audio.track");
    track.setAttribute("role", "slider");
    track.setAttribute("aria-label", i18n.t("editor.attachment.widget.audio.seek"));
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "0");
    track.setAttribute("aria-valuenow", "0");
    track.tabIndex = 0;
    const fill = document.createElement("span");
    fill.className = "cm-attachment-audio-fill";
    track.appendChild(fill);
    const thumb = document.createElement("span");
    thumb.className = "cm-attachment-audio-thumb";
    track.appendChild(thumb);
    // Waveform bars are rendered into this container once peaks decode; until
    // then the plain fill/thumb above act as the seek bar.
    const wave = document.createElement("span");
    wave.className = "cm-attachment-audio-wave";
    track.appendChild(wave);
    row.appendChild(track);

    const menu = buildOverflowMenu(
      [
        { label: i18n.t("editor.attachment.widget.menu.export"), testid: "attachment-audio.export", run: () => void exportAttachment(this.id, this.filename) },
        { label: i18n.t("editor.attachment.widget.menu.rename"), testid: "attachment-audio.rename", run: () => void renameFileCard(view, this.id, this.filename) },
        { label: i18n.t("editor.attachment.widget.menu.remove"), testid: "attachment-audio.remove", run: () => removeFileCard(view, root, this.id) },
        { label: i18n.t("editor.attachment.widget.menu.reveal"), testid: "attachment-audio.reveal", run: () => revealFileCard(view, this.id) },
      ],
      { buttonTestId: "attachment-audio.menu-button", menuTestId: "attachment-audio.menu" },
    );
    row.appendChild(menu.wrap);

    root.appendChild(row);

    // Time — bottom row, left-most.
    const time = document.createElement("span");
    time.className = "cm-attachment-audio-time";
    time.setAttribute("data-testid", "attachment-audio.time");
    time.textContent = "0:00 / 0:00";
    root.appendChild(time);

    // --- playback wiring ---
    let duration = 0;
    let bars: HTMLElement[] = [];
    const setPaused = (paused: boolean) => {
      playBtn.replaceChildren(makeAttachmentIcon(paused ? "play" : "pause"));
      playBtn.setAttribute(
        "aria-label",
        paused
          ? i18n.t("editor.attachment.widget.audio.play")
          : i18n.t("editor.attachment.widget.audio.pause"),
      );
    };
    const render = () => {
      const cur = audio.currentTime || 0;
      const ratio = duration > 0 ? Math.min(1, cur / duration) : 0;
      if (bars.length > 0) {
        // Waveform mode: color the played-through bars accent, the rest muted.
        const played = Math.round(ratio * bars.length);
        for (let i = 0; i < bars.length; i++) {
          bars[i].classList.toggle("cm-attachment-audio-bar-played", i < played);
        }
      } else {
        // Plain-fill fallback (pre-decode / decode failed).
        fill.style.width = `${ratio * 100}%`;
        thumb.style.left = `${ratio * 100}%`;
      }
      time.textContent = `${formatClock(cur)} / ${formatClock(duration)}`;
      track.setAttribute("aria-valuenow", String(Math.floor(cur)));
    };
    const toggle = () => {
      if (audio.paused) {
        void audio.play();
        setPaused(false);
      } else {
        audio.pause();
        setPaused(true);
      }
    };

    audio.addEventListener("loadedmetadata", () => {
      duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      track.setAttribute("aria-valuemax", String(Math.floor(duration)));
      render();
    });
    audio.addEventListener("timeupdate", render);
    audio.addEventListener("ended", () => setPaused(true));

    playBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });

    track.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (duration <= 0) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * duration;
      render();
    });
    track.addEventListener("keydown", (e) => {
      let handled = true;
      switch (e.key) {
        case "ArrowRight":
          if (duration > 0) audio.currentTime = Math.min(duration, audio.currentTime + 5);
          break;
        case "ArrowLeft":
          if (duration > 0) audio.currentTime = Math.max(0, audio.currentTime - 5);
          break;
        case "Home":
          audio.currentTime = 0;
          break;
        case "End":
          if (duration > 0) audio.currentTime = duration;
          break;
        case " ":
        case "Enter":
          toggle();
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        render();
      }
    });

    // Lazy waveform: decode peaks only once the player scrolls into view, then
    // render bars onto the track (replacing the plain progress fill). decodePeaks
    // caches by id, so a re-render or a second embed of the same clip never
    // re-decodes. A decode failure leaves the plain fill in place.
    let observer: IntersectionObserver | null = null;
    const renderWaveform = async () => {
      try {
        const peaks = await decodePeaks(attachmentUrl(this.id), WAVEFORM_BUCKETS);
        if (peaks.length === 0) return;
        bars = peaks.map((p) => {
          const bar = document.createElement("span");
          bar.className = "cm-attachment-audio-bar";
          bar.style.height = `${Math.max(MIN_BAR_PCT, p * 100)}%`;
          return bar;
        });
        wave.replaceChildren(...bars);
        track.classList.add("cm-attachment-audio-track-wave");
        render();
      } catch {
        // Decode unavailable / failed → keep the plain progress fill (graceful).
      }
    };
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer?.disconnect();
            observer = null;
            void renderWaveform();
            break;
          }
        }
      });
      observer.observe(root);
    } else {
      void renderWaveform();
    }

    this.teardown = () => {
      observer?.disconnect();
      observer = null;
      menu.teardown();
      audio.pause();
      audio.removeAttribute("src");
      audio.load(); // release the decoded buffer
    };
    return root;
  }

  // Stop playback + tear the menu down if CM6 discards the widget's DOM.
  destroy(): void {
    this.teardown?.();
    this.teardown = null;
  }

  // Let clicks reach the play button / track / menu rather than being swallowed
  // as a CM event; the widget stays atomic (it never mutates doc/selection).
  ignoreEvent(): boolean {
    return false;
  }
}

/** Number of waveform bars rendered across the seek track. */
const WAVEFORM_BUCKETS = 48;
/** Minimum bar height (% of track) so a near-silent bucket still reads. */
const MIN_BAR_PCT = 8;

/** Drop a trailing file extension for the card label ("…29.wav" → "…29"). */
function stripFileExtension(filename: string): string {
  return filename.replace(/\.[A-Za-z0-9]{1,8}$/, "");
}

/** Build the appropriate resolved-attachment widget for a content-type. SVG +
 *  raster share the `<img>` path; PDF takes the pdf.js path; audio takes the
 *  inline player (MYND-259). A generic (non-renderable) attachment —
 *  `application/octet-stream`, MYND-173 — takes the export-only file-card path. */
export function makeResolvedWidget(row: CatalogRow): WidgetType {
  if (row.contentType === "application/pdf") {
    return new AttachmentPdfWidget(row.id, row.filename);
  }
  if (isRenderableImageType(row.contentType)) {
    return new AttachmentImageWidget(row.id, row.filename);
  }
  if (isPlayableAudioType(row.contentType)) {
    return new AttachmentAudioWidget(row.id, row.filename);
  }
  // Generic / non-renderable → export-only file-card.
  return new AttachmentFileCardWidget(row.id, row.filename, row.size);
}

/** The raster/SVG content-types the `attachment://` handler serves inline. */
function isRenderableImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

/** The audio content-types served inline as a player (v0.1: WAV only). */
function isPlayableAudioType(contentType: string): boolean {
  return contentType.startsWith("audio/");
}
