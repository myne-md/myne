// @vitest-environment jsdom
//
// Transcript UI on the audio-attachment widget (voice-to-text MYND-552). Drives
// AttachmentAudioWidget.toDOM directly (no full editor mount) and asserts the
// SYNC-V7 seam contract: the ⋮ "Transcribe" row gating on the AI facet + host
// slot, the in-flight progress affordance + Stop, the completed read-only
// expander + verbatim honesty note (SYNC-V8), the explicit insert-into-note
// action (SYNC-V1/V17), and the no-model hint (SYNC-V3). The host `transcribe`
// slot is a controllable stub — no Tauri, no real engine.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/editor/attachments/pdf-reader", () => ({
  mountPdfScroller: () => () => {},
}));
vi.mock("../../src/editor/attachments/lightbox", () => ({
  showAttachmentLightbox: vi.fn(),
}));
vi.mock("../../src/editor/attachments/waveform", () => ({
  decodePeaks: vi.fn(async () => [] as number[]),
}));
vi.mock("../../src/editor/attachments/toast", () => ({
  showAttachmentToast: vi.fn(),
}));

import { AttachmentAudioWidget } from "../../src/editor/attachments/widgets";
// The production reset, not a test-only twin: it is the function the vault
// teardown paths call, so exercising it here is worth more than a private one.
import { resetTranscripts } from "../../src/editor/attachments/session-caches";
import { showAttachmentToast } from "../../src/editor/attachments/toast";
import { type EditorHost, getHost, setEditorHost } from "../../src/editor/host";
import type { TranscribeHandle, TranscribeOptions } from "../../src/editor/host";
import { AI_TRANSCRIPT_HONESTY_NOTE } from "../../src/lib/load-bearing-copy";

const ID = "a".repeat(64);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const baseHost = getHost();

/** A controllable stand-in for the desktop `transcribe` slot. */
interface TranscribeStub {
  spy: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  resolve: (transcript: string) => void;
  reject: (err: unknown) => void;
  segment: (partial: string) => void;
}

function installHost(opts: {
  aiEnabled: boolean;
  withTranscribe: boolean;
  honestyNote?: string;
}): { view: EditorViewStub; stub: TranscribeStub } {
  const stub: TranscribeStub = {
    spy: vi.fn(),
    stop: vi.fn(),
    resolve: () => {},
    reject: () => {},
    segment: () => {},
  };

  const transcribe = ((_view, _id, o?: TranscribeOptions): TranscribeHandle => {
    stub.segment = (partial: string) => o?.onSegment?.(partial);
    const done = new Promise<string>((res, rej) => {
      stub.resolve = res;
      stub.reject = rej;
    });
    return { done, stop: stub.stop };
  }) as EditorHost["transcribe"];
  stub.spy = vi.fn(transcribe);

  setEditorHost({
    ...baseHost,
    transcribe: opts.withTranscribe ? (stub.spy as EditorHost["transcribe"]) : undefined,
    transcriptHonestyNote: opts.honestyNote,
  });

  const dispatched: { changes?: unknown; userEvent?: string }[] = [];
  const view: EditorViewStub = {
    state: {
      facet: () => opts.aiEnabled,
      doc: { length: 0 },
      selection: { main: { head: 0 } },
    },
    dom: { isConnected: true },
    dispatch: (tr: { changes?: unknown; userEvent?: string }) => dispatched.push(tr),
    focus: () => {},
    dispatched,
  };
  return { view, stub };
}

interface EditorViewStub {
  state: {
    facet: () => boolean;
    doc: { length: number };
    selection: { main: { head: number } };
  };
  dom: { isConnected: boolean };
  dispatch: (tr: { changes?: unknown; userEvent?: string }) => void;
  focus: () => void;
  dispatched: { changes?: unknown; userEvent?: string }[];
}

/** Build the audio widget DOM against `view`, opening the ⋮ menu. */
function build(view: EditorViewStub): HTMLElement {
  const dom = new AttachmentAudioWidget(ID, "Voice note 1.wav", []).toDOM(view as never);
  document.body.appendChild(dom);
  return dom;
}

function openMenu(dom: HTMLElement): void {
  (dom.querySelector('[data-testid="attachment-audio.menu-button"]') as HTMLButtonElement).click();
}

function transcribeRow(): HTMLButtonElement | null {
  return document.body.querySelector('[data-testid="attachment-audio.transcribe"]');
}

beforeEach(() => {
  resetTranscripts();
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
  setEditorHost(baseHost);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Transcribe ⋮-menu row gating (SYNC-V7)", () => {
  it("omits the Transcribe row when the host provides no transcribe slot (mobile)", () => {
    const { view } = installHost({ aiEnabled: true, withTranscribe: false });
    const dom = build(view);
    openMenu(dom);
    expect(transcribeRow()).toBeNull();
  });

  it("shows the Transcribe row ENABLED when the slot exists and the AI facet is true", () => {
    const { view } = installHost({ aiEnabled: true, withTranscribe: true });
    const dom = build(view);
    openMenu(dom);
    const row = transcribeRow();
    expect(row).not.toBeNull();
    expect(row!.disabled).toBe(false);
  });

  it("HIDES the Transcribe row when the AI facet is false", () => {
    const { view } = installHost({ aiEnabled: false, withTranscribe: true });
    const dom = build(view);
    openMenu(dom);
    // Local AI off (or the note's folder AI-excluded) → the row is omitted
    // entirely (MYND-270: hidden, not shown-disabled).
    expect(transcribeRow()).toBeNull();
  });
});

describe("Transcription run → progress → expander → insert", () => {
  it("mounts the progress affordance with a Stop and streams partial segments", () => {
    const { view, stub } = installHost({ aiEnabled: true, withTranscribe: true });
    const dom = build(view);
    openMenu(dom);
    transcribeRow()!.click();

    expect(stub.spy).toHaveBeenCalledTimes(1);
    const progress = dom.querySelector('[data-testid="attachment-audio.transcript-progress"]');
    expect(progress).not.toBeNull();
    expect(dom.querySelector('[data-testid="attachment-audio.transcript-stop"]')).not.toBeNull();

    // A streamed segment updates the live preview (textContent, TB2).
    stub.segment("hello ");
    stub.segment("world");
    expect(dom.querySelector(".cm-attachment-audio-transcript-preview")?.textContent).toBe(
      "hello world",
    );
  });

  it("renders the read-only expander + verbatim honesty note on completion", async () => {
    const { view, stub } = installHost({
      aiEnabled: true,
      withTranscribe: true,
      honestyNote: AI_TRANSCRIPT_HONESTY_NOTE,
    });
    const dom = build(view);
    openMenu(dom);
    transcribeRow()!.click();
    stub.resolve("the full transcript");
    await flush();

    const expander = dom.querySelector('[data-testid="attachment-audio.transcript"]');
    expect(expander).not.toBeNull();
    expect(expander!.textContent).toBe("the full transcript");
    // Honesty note (SYNC-V8) rendered VERBATIM from the host constant.
    expect(dom.querySelector(".cm-attachment-audio-transcript-note")?.textContent).toBe(
      AI_TRANSCRIPT_HONESTY_NOTE,
    );
    // Progress is gone once complete.
    expect(dom.querySelector('[data-testid="attachment-audio.transcript-progress"]')).toBeNull();
  });

  it("insert action writes the transcript into the note body via a normal dispatch (SYNC-17)", async () => {
    const { view, stub } = installHost({ aiEnabled: true, withTranscribe: true });
    const dom = build(view);
    openMenu(dom);
    transcribeRow()!.click();
    stub.resolve("transcribed text");
    await flush();

    const insert = dom.querySelector(
      '[data-testid="attachment-audio.transcript-edit"]',
    ) as HTMLButtonElement;
    expect(insert).not.toBeNull();
    insert.click();

    expect(view.dispatched).toHaveLength(1);
    expect(view.dispatched[0].userEvent).toBe("input.transcript-insert");
    expect(view.dispatched[0].changes).toMatchObject({ insert: "transcribed text" });
  });
});

describe("per-cause hint + Stop", () => {
  const ACTIONABLE_CAUSES = [
    { kind: "feature_off" },
    { kind: "vault_locked" },
    { kind: "no_model" },
    { kind: "model_load_failed" },
  ] as const;

  it("renders a distinct, non-empty hint for each actionable cause (MYND-591)", async () => {
    const texts: string[] = [];
    for (const cause of ACTIONABLE_CAUSES) {
      const { view, stub } = installHost({ aiEnabled: true, withTranscribe: true });
      const dom = build(view);
      openMenu(dom);
      transcribeRow()!.click();
      stub.reject(cause);
      await flush();

      const hint = dom.querySelector('[data-testid="attachment-audio.transcript-hint"]');
      expect(hint, `hint for ${cause.kind}`).not.toBeNull();
      expect(hint!.textContent, `text for ${cause.kind}`).not.toBe("");
      // A cause hint replaces the run — no expander, no lingering progress, no toast.
      expect(dom.querySelector('[data-testid="attachment-audio.transcript"]')).toBeNull();
      expect(dom.querySelector('[data-testid="attachment-audio.transcript-progress"]')).toBeNull();
      expect(showAttachmentToast).not.toHaveBeenCalled();
      texts.push(hint!.textContent ?? "");

      // Reset between iterations (afterEach only runs once for the whole test).
      setEditorHost(baseHost);
      document.body.innerHTML = "";
      resetTranscripts();
      vi.mocked(showAttachmentToast).mockClear();
    }
    // Each cause maps to its own message — a regression that collapses them back
    // into a single "no model" copy would fail here.
    expect(new Set(texts).size).toBe(ACTIONABLE_CAUSES.length);
  });

  it("shows a transient toast and NO hint on a generic failure", async () => {
    const { view, stub } = installHost({ aiEnabled: true, withTranscribe: true });
    const dom = build(view);
    openMenu(dom);
    transcribeRow()!.click();
    stub.reject({ kind: "failed" });
    await flush();

    expect(showAttachmentToast).toHaveBeenCalledTimes(1);
    expect(dom.querySelector('[data-testid="attachment-audio.transcript-hint"]')).toBeNull();
    expect(dom.querySelector('[data-testid="attachment-audio.transcript"]')).toBeNull();
    expect(dom.querySelector('[data-testid="attachment-audio.transcript-progress"]')).toBeNull();
  });

  it("Stop cancels the run, tears down the progress, and commits no transcript", async () => {
    const { view, stub } = installHost({ aiEnabled: true, withTranscribe: true });
    const dom = build(view);
    openMenu(dom);
    transcribeRow()!.click();
    const stop = dom.querySelector(
      '[data-testid="attachment-audio.transcript-stop"]',
    ) as HTMLButtonElement;
    stop.click();

    expect(stub.stop).toHaveBeenCalledTimes(1);
    expect(dom.querySelector('[data-testid="attachment-audio.transcript-progress"]')).toBeNull();
    // A late resolution after a user Stop is ignored — no expander, no note write.
    stub.resolve("late");
    await flush();
    expect(dom.querySelector('[data-testid="attachment-audio.transcript"]')).toBeNull();
    expect(view.dispatched).toHaveLength(0);
  });
});
