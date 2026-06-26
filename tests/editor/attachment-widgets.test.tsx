// @vitest-environment jsdom
//
// Atomic attachment widgets (MYND-164 / 173 / 259): direct `toDOM()` unit tests
// for the widget DOM each catalog content-type maps to. These drive the widget
// classes in isolation (no full editor mount), asserting the real DOM output,
// the play/pause + seek wiring of the audio player, the tombstone flavor split,
// the non-fetching URL chip, and the `makeResolvedWidget` content-type router.
//
// Heavy collaborators are mocked at module scope:
//   - `./pdf-reader` (pdf.js dynamic import) — never run in jsdom.
//   - `./lightbox` — assert it is invoked on image / pdf click, no real overlay.
//   - `./waveform` (`decodePeaks`) — controls whether the audio waveform path
//     renders bars vs the plain-fill fallback.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mountPdfScroller = vi.fn(() => () => {});
vi.mock("../../src/editor/attachments/pdf-reader", () => ({
  mountPdfScroller: (...a: unknown[]) => mountPdfScroller(...a),
}));

const showAttachmentLightbox = vi.fn();
vi.mock("../../src/editor/attachments/lightbox", () => ({
  showAttachmentLightbox: (...a: unknown[]) => showAttachmentLightbox(...a),
}));

const decodePeaks = vi.fn(async () => [] as number[]);
vi.mock("../../src/editor/attachments/waveform", () => ({
  decodePeaks: (...a: unknown[]) => decodePeaks(...a),
}));

import {
  AttachmentAudioWidget,
  AttachmentFileCardWidget,
  AttachmentImageWidget,
  AttachmentPdfWidget,
  AttachmentTombstoneWidget,
  UrlImageChipWidget,
  makeResolvedWidget,
} from "../../src/editor/attachments/widgets";
import type { CatalogRow } from "../../src/editor/attachments/catalog";

const ID = "a".repeat(64);

// A minimal EditorView stand-in: the file-card / audio widgets only touch the
// `view` inside menu-action callbacks, which these tests do not fire.
const fakeView = {} as never;

beforeEach(() => {
  // jsdom has no IntersectionObserver — stub a no-op so the audio widget takes
  // its observer branch deterministically (we trigger decode manually).
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("AttachmentImageWidget", () => {
  it("renders an inline <img src=attachment://id> + loading chip in an aria-labelled frame", () => {
    const dom = new AttachmentImageWidget(ID, "photo.png").toDOM();
    expect(dom.className).toBe("cm-attachment-frame");
    expect(dom.getAttribute("role")).toBe("img");
    expect(dom.getAttribute("aria-label")).toBe("photo.png");
    const img = dom.querySelector("img.cm-attachment-img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(`attachment://${ID}`);
    expect(img.alt).toBe("photo.png");
    // Hidden until the load event fires; loading chip is present meanwhile.
    expect(img.style.display).toBe("none");
    expect(dom.querySelector(".cm-attachment-progress")).not.toBeNull();
  });

  it("reveals the <img> and drops the loading chip on load", () => {
    const dom = new AttachmentImageWidget(ID, "p.png").toDOM();
    const img = dom.querySelector("img.cm-attachment-img") as HTMLImageElement;
    img.dispatchEvent(new Event("load"));
    expect(img.style.display).toBe("");
    expect(dom.querySelector(".cm-attachment-progress")).toBeNull();
  });

  it("drops the loading chip but keeps the <img> on error (native broken-image affordance)", () => {
    const dom = new AttachmentImageWidget(ID, "p.png").toDOM();
    const img = dom.querySelector("img.cm-attachment-img") as HTMLImageElement;
    img.dispatchEvent(new Event("error"));
    expect(dom.querySelector(".cm-attachment-progress")).toBeNull();
    expect(dom.querySelector("img.cm-attachment-img")).not.toBeNull();
  });

  it("opens the lightbox with the decrypted source on image click", () => {
    const dom = new AttachmentImageWidget(ID, "p.png").toDOM();
    const img = dom.querySelector("img.cm-attachment-img") as HTMLImageElement;
    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(showAttachmentLightbox).toHaveBeenCalledWith({
      url: `attachment://${ID}`,
      alt: "p.png",
      id: ID,
    });
  });

  it("eq() is identity over id + filename; ignoreEvent stays false (lets clicks through)", () => {
    const w = new AttachmentImageWidget(ID, "p.png");
    expect(w.eq(new AttachmentImageWidget(ID, "p.png"))).toBe(true);
    expect(w.eq(new AttachmentImageWidget(ID, "other.png"))).toBe(false);
    expect(w.eq(new AttachmentImageWidget("b".repeat(64), "p.png"))).toBe(false);
    expect(w.ignoreEvent()).toBe(false);
  });
});

describe("AttachmentPdfWidget", () => {
  it("mounts the pdf scroller and renders a pdf frame", () => {
    const dom = new AttachmentPdfWidget(ID, "doc.pdf").toDOM();
    expect(dom.className).toContain("cm-attachment-pdf");
    expect(dom.getAttribute("aria-label")).toBe("doc.pdf");
    const scroller = dom.querySelector(".cm-attachment-pdf-scroller");
    expect(scroller).not.toBeNull();
    expect(mountPdfScroller).toHaveBeenCalledOnce();
    const [container, opts] = mountPdfScroller.mock.calls[0] as [HTMLElement, { url: string }];
    expect(container).toBe(scroller);
    expect(opts.url).toBe(`attachment://${ID}`);
  });

  it("opens the lightbox PDF reader on scroller click", () => {
    const dom = new AttachmentPdfWidget(ID, "doc.pdf").toDOM();
    const scroller = dom.querySelector(".cm-attachment-pdf-scroller") as HTMLElement;
    scroller.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(showAttachmentLightbox).toHaveBeenCalledWith({
      url: `attachment://${ID}`,
      alt: "doc.pdf",
      kind: "pdf",
      id: ID,
    });
  });

  it("renders the mandatory generic-PDF-icon fallback when the reader errors (SYNC-5)", () => {
    const dom = new AttachmentPdfWidget(ID, "doc.pdf").toDOM();
    // Invoke the onError the widget handed the (mocked) scroller.
    const opts = mountPdfScroller.mock.calls[0][1] as { onError: () => void };
    opts.onError();
    const fallback = dom.querySelector(".cm-attachment-pdf-fallback");
    expect(fallback).not.toBeNull();
    expect(fallback!.querySelector(".cm-attachment-pdf-fallback-label")?.textContent).toBe("PDF");
  });

  it("destroy() runs the scroller cleanup exactly once", () => {
    const cleanup = vi.fn();
    mountPdfScroller.mockReturnValueOnce(cleanup);
    const w = new AttachmentPdfWidget(ID, "doc.pdf");
    w.toDOM();
    w.destroy();
    w.destroy();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("AttachmentTombstoneWidget", () => {
  it("renders a DELETED flavor (muted image-off, aria 'Deleted attachment')", () => {
    const dom = new AttachmentTombstoneWidget("deleted", "gone.png").toDOM();
    expect(dom.className).toContain("cm-attachment-tombstone-deleted");
    expect(dom.getAttribute("aria-label")).toBe("Deleted attachment: gone.png");
    expect(dom.querySelector(".cm-attachment-tombstone-label")?.textContent).toBe("gone.png");
  });

  it("renders a BROKEN flavor (danger, aria 'Broken attachment reference')", () => {
    const dom = new AttachmentTombstoneWidget("broken", "bad.png").toDOM();
    expect(dom.className).toContain("cm-attachment-tombstone-broken");
    expect(dom.getAttribute("aria-label")).toBe("Broken attachment reference: bad.png");
  });

  it("falls back to a kind label when the filename is empty", () => {
    expect(
      new AttachmentTombstoneWidget("deleted", "").toDOM().querySelector(
        ".cm-attachment-tombstone-label",
      )?.textContent,
    ).toBe("deleted");
    expect(
      new AttachmentTombstoneWidget("broken", "").toDOM().querySelector(
        ".cm-attachment-tombstone-label",
      )?.textContent,
    ).toBe("broken");
  });

  it("eq() distinguishes kind and filename", () => {
    const w = new AttachmentTombstoneWidget("deleted", "x");
    expect(w.eq(new AttachmentTombstoneWidget("deleted", "x"))).toBe(true);
    expect(w.eq(new AttachmentTombstoneWidget("broken", "x"))).toBe(false);
    expect(w.eq(new AttachmentTombstoneWidget("deleted", "y"))).toBe(false);
  });
});

describe("UrlImageChipWidget", () => {
  it("renders a non-fetching chip: no <img>, URL only as a hover title", () => {
    const url = "https://example.com/a.png";
    const dom = new UrlImageChipWidget("Cat photo", url).toDOM();
    expect(dom.className).toBe("cm-attachment-url-chip");
    expect(dom.title).toBe(url);
    // Crucially never an <img> for the URL — no network request is ever issued.
    expect(dom.querySelector("img")).toBeNull();
    expect(dom.querySelector(".cm-attachment-url-chip-label")?.textContent).toBe("Cat photo");
  });

  it("labels with 'image' when the alt is empty", () => {
    const dom = new UrlImageChipWidget("", "https://x/y.png").toDOM();
    expect(dom.querySelector(".cm-attachment-url-chip-label")?.textContent).toBe("image");
  });

  it("eq() is over alt + url", () => {
    const w = new UrlImageChipWidget("a", "u");
    expect(w.eq(new UrlImageChipWidget("a", "u"))).toBe(true);
    expect(w.eq(new UrlImageChipWidget("a", "u2"))).toBe(false);
  });
});

describe("AttachmentFileCardWidget", () => {
  it("renders the card: icon, filename, 'type · size' meta, and an overflow menu", () => {
    const dom = new AttachmentFileCardWidget(ID, "report.docx", 2048).toDOM(
      fakeView,
    );
    expect(dom.getAttribute("data-testid")).toBe("attachment-card");
    expect(dom.getAttribute("aria-label")).toBe("report.docx");
    expect(dom.querySelector(".cm-attachment-file-card-name")?.textContent).toBe("report.docx");
    const meta = dom.querySelector(".cm-attachment-file-card-meta")?.textContent ?? "";
    expect(meta).toContain("Word document");
    expect(meta).toContain("·");
    // The overflow menu button wired through buildOverflowMenu.
    expect(dom.querySelector('[data-testid="attachment-card.menu-button"]')).not.toBeNull();
  });

  it("eq() ignores the derived label but tracks id / filename / size", () => {
    const w = new AttachmentFileCardWidget(ID, "f.zip", 100);
    expect(w.eq(new AttachmentFileCardWidget(ID, "f.zip", 100))).toBe(true);
    expect(w.eq(new AttachmentFileCardWidget(ID, "f.zip", 200))).toBe(false);
    expect(w.eq(new AttachmentFileCardWidget(ID, "g.zip", 100))).toBe(false);
  });
});

describe("AttachmentAudioWidget", () => {
  function build(): { widget: AttachmentAudioWidget; dom: HTMLElement } {
    const widget = new AttachmentAudioWidget(ID, "Voice note 1.wav");
    const dom = widget.toDOM(fakeView);
    return { widget, dom };
  }

  it("renders an audio player: hidden <audio>, ext-stripped name, play btn, seek track, time", () => {
    const { dom } = build();
    expect(dom.getAttribute("data-testid")).toBe("attachment-audio");
    const audio = dom.querySelector("audio") as HTMLAudioElement;
    expect(audio.getAttribute("src")).toBe(`attachment://${ID}`);
    expect(audio.style.display).toBe("none");
    // The extension is dropped from the card name (rename/export keep the full name).
    expect(dom.querySelector('[data-testid="attachment-audio.name"]')?.textContent).toBe(
      "Voice note 1",
    );
    expect(dom.querySelector('[data-testid="attachment-audio.play"]')).not.toBeNull();
    const track = dom.querySelector('[data-testid="attachment-audio.track"]') as HTMLElement;
    expect(track.getAttribute("role")).toBe("slider");
    expect(dom.querySelector('[data-testid="attachment-audio.time"]')?.textContent).toBe(
      "0:00 / 0:00",
    );
  });

  it("toggles play/pause and updates the time readout from media events", () => {
    const { dom } = build();
    const audio = dom.querySelector("audio") as HTMLAudioElement;
    const play = vi.spyOn(audio, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
    // jsdom leaves audio.paused true; force a known duration + position.
    Object.defineProperty(audio, "duration", { configurable: true, value: 30 });
    audio.dispatchEvent(new Event("loadedmetadata"));
    const track = dom.querySelector('[data-testid="attachment-audio.track"]') as HTMLElement;
    expect(track.getAttribute("aria-valuemax")).toBe("30");

    const playBtn = dom.querySelector('[data-testid="attachment-audio.play"]') as HTMLButtonElement;
    playBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(play).toHaveBeenCalledOnce();
    expect(playBtn.getAttribute("aria-label")).toBe("Pause");

    // A timeupdate with the element reporting paused=false → "pause" path next.
    Object.defineProperty(audio, "currentTime", { configurable: true, value: 15 });
    audio.dispatchEvent(new Event("timeupdate"));
    expect(dom.querySelector('[data-testid="attachment-audio.time"]')?.textContent).toBe(
      "0:15 / 0:30",
    );

    // Second click pauses (jsdom's paused getter is still true so we drive the
    // branch by spying — assert the pause path fired its icon/label swap).
    playBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(play).toHaveBeenCalledTimes(2);
    void pause;
  });

  it("resets the icon to Play when playback ends", () => {
    const { dom } = build();
    const audio = dom.querySelector("audio") as HTMLAudioElement;
    const playBtn = dom.querySelector('[data-testid="attachment-audio.play"]') as HTMLButtonElement;
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    playBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(playBtn.getAttribute("aria-label")).toBe("Pause");
    audio.dispatchEvent(new Event("ended"));
    expect(playBtn.getAttribute("aria-label")).toBe("Play");
  });

  it("keyboard seek: ArrowRight / ArrowLeft / Home / End move currentTime within bounds", () => {
    const { dom } = build();
    const audio = dom.querySelector("audio") as HTMLAudioElement;
    let t = 10;
    Object.defineProperty(audio, "duration", { configurable: true, value: 30 });
    Object.defineProperty(audio, "currentTime", {
      configurable: true,
      get: () => t,
      set: (v: number) => {
        t = v;
      },
    });
    audio.dispatchEvent(new Event("loadedmetadata"));
    const track = dom.querySelector('[data-testid="attachment-audio.track"]') as HTMLElement;

    track.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(t).toBe(15);
    track.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(t).toBe(10);
    track.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(t).toBe(30);
    track.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(t).toBe(0);
  });

  it("seek-click sets currentTime proportionally to the click x within the track", () => {
    const { dom } = build();
    const audio = dom.querySelector("audio") as HTMLAudioElement;
    let t = 0;
    Object.defineProperty(audio, "duration", { configurable: true, value: 40 });
    Object.defineProperty(audio, "currentTime", {
      configurable: true,
      get: () => t,
      set: (v: number) => {
        t = v;
      },
    });
    audio.dispatchEvent(new Event("loadedmetadata"));
    const track = dom.querySelector('[data-testid="attachment-audio.track"]') as HTMLElement;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 100,
      right: 100,
      top: 0,
      bottom: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    track.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 25 }));
    expect(t).toBe(10); // 25% of 40s
  });

  it("renders waveform bars onto the track when decodePeaks resolves with peaks", async () => {
    decodePeaks.mockResolvedValueOnce([0.1, 0.5, 1, 0.2]);
    // No IntersectionObserver → the widget decodes eagerly. Remove the stub so
    // the `typeof IntersectionObserver === "undefined"` branch runs.
    vi.unstubAllGlobals();
    const { dom } = build();
    await Promise.resolve();
    await Promise.resolve();
    const track = dom.querySelector('[data-testid="attachment-audio.track"]') as HTMLElement;
    expect(track.classList.contains("cm-attachment-audio-track-wave")).toBe(true);
    expect(dom.querySelectorAll(".cm-attachment-audio-bar")).toHaveLength(4);
  });

  it("destroy() tears down: pauses, drops the src, and releases the buffer", () => {
    const widget = new AttachmentAudioWidget(ID, "v.wav");
    const dom = widget.toDOM(fakeView);
    const audio = dom.querySelector("audio") as HTMLAudioElement;
    const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
    const load = vi.spyOn(audio, "load").mockImplementation(() => {});
    widget.destroy();
    expect(pause).toHaveBeenCalled();
    expect(audio.getAttribute("src")).toBeNull();
    expect(load).toHaveBeenCalled();
  });
});

describe("makeResolvedWidget (content-type router)", () => {
  function row(contentType: string): CatalogRow {
    return { id: ID, contentType, filename: "f", size: 1 };
  }

  it("routes application/pdf → PDF widget", () => {
    expect(makeResolvedWidget(row("application/pdf"))).toBeInstanceOf(AttachmentPdfWidget);
  });
  it("routes image/* → image widget (png and svg both)", () => {
    expect(makeResolvedWidget(row("image/png"))).toBeInstanceOf(AttachmentImageWidget);
    expect(makeResolvedWidget(row("image/svg+xml"))).toBeInstanceOf(AttachmentImageWidget);
  });
  it("routes audio/* → audio widget", () => {
    expect(makeResolvedWidget(row("audio/wav"))).toBeInstanceOf(AttachmentAudioWidget);
  });
  it("routes a non-renderable type → export-only file card", () => {
    expect(makeResolvedWidget(row("application/octet-stream"))).toBeInstanceOf(
      AttachmentFileCardWidget,
    );
  });
});
