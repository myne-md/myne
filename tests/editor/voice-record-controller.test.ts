// @vitest-environment jsdom
//
// Voice-note recording controller (MYND-259): the start / stop / cancel flow,
// the single-recording-at-a-time guard, the continuation-clip live insert, and
// the start/stop error→toast mapping. Embeds insert into a real EditorView so
// the form-C output and catalog seeding are asserted for real.
//
// **Driven through `EditorHost.voice`, not through Tauri** (phase3-web-client
// task 76). The controller used to `invoke` the three commands and `listen` for
// the two events itself, which put `@tauri-apps/api` into any bundle reaching
// this file — including a browser's. The platform half now lives in the host
// (`src/lib/voice-record.ts` on desktop), so what this file mocks is the seam,
// which is also what a second client has to satisfy. The IPC strings and event
// names did not change; they simply moved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEditorHost, getHost, type EditorHost } from "@myne/editor/host";

// The two backend→UI subscriptions, captured so tests can drive the level and
// continuation-clip streams synchronously.
type LevelCb = (level: number) => void;
type ClipCb = (clip: { id: string; content_type: string; filename: string; size: number }) => void;
let levelCb: LevelCb | null = null;
let clipCb: ClipCb | null = null;

const unlisten = vi.fn();
const voiceStart = vi.fn(async () => {});
const voiceStop = vi.fn(async () => null as unknown);
const voiceCancel = vi.fn(async () => {});
const onLevel = vi.fn(async (cb: LevelCb) => {
  levelCb = cb;
  return unlisten;
});
const onClip = vi.fn(async (cb: ClipCb) => {
  clipCb = cb;
  return unlisten;
});

/** Install the voice backend on the globally-installed test host. */
function installVoiceHost(): () => void {
  const host = getHost();
  const patched: EditorHost = {
    ...host,
    voice: {
      start: voiceStart,
      stop: voiceStop as () => Promise<never>,
      cancel: voiceCancel,
      onLevel,
      onClip,
    } as EditorHost["voice"],
  };
  setEditorHost(patched);
  return () => setEditorHost(host);
}

// A controllable recording-bar handle stand-in.
const barHandle = {
  setLevel: vi.fn(),
  setBusy: vi.fn(),
  teardown: vi.fn(),
  onTeardown: vi.fn(),
};
const mountRecordingBar = vi.fn(() => barHandle);
let lastBarOpts: { onStop: () => void; onCancel: () => void } | null = null;
vi.mock("@myne/editor/attachments/recordingBar", () => ({
  mountRecordingBar: (opts: { onStop: () => void; onCancel: () => void }) => {
    lastBarOpts = opts;
    return mountRecordingBar();
  },
}));

const showAttachmentToast = vi.fn();
vi.mock("@myne/editor/attachments/toast", () => ({
  showAttachmentToast: (...a: unknown[]) => showAttachmentToast(...a),
}));

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  isRecording,
  startVoiceRecording,
} from "@myne/editor/attachments/voiceRecord";
import { catalogField } from "@myne/editor/attachments/catalog";

const ID = "c".repeat(64);

function imported(id: string, filename: string) {
  return { id, content_type: "audio/wav", filename, size: 100 };
}

function mount(doc = ""): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions: [catalogField],
    }),
    parent: host,
  });
}

let restoreHost: (() => void) | null = null;

beforeEach(() => {
  levelCb = null;
  clipCb = null;
  lastBarOpts = null;
  voiceStart.mockReset().mockResolvedValue(undefined);
  voiceStop.mockReset().mockResolvedValue(null);
  voiceCancel.mockReset().mockResolvedValue(undefined);
  onLevel.mockClear();
  onClip.mockClear();
  showAttachmentToast.mockReset();
  Object.values(barHandle).forEach((fn) => fn.mockReset());
  restoreHost = installVoiceHost();
});

afterEach(() => {
  restoreHost?.();
  restoreHost = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("startVoiceRecording", () => {
  it("starts the backend, mounts the bar, and registers level + clip listeners", async () => {
    const view = mount();
    await startVoiceRecording(view);
    // microtask flush so the awaited subscriptions have registered.
    await Promise.resolve();
    expect(voiceStart).toHaveBeenCalledOnce();
    expect(mountRecordingBar).toHaveBeenCalledOnce();
    expect(isRecording()).toBe(true);
    expect(levelCb).not.toBeNull();
    expect(clipCb).not.toBeNull();
    // Both unsubscribe fns were registered for teardown.
    expect(barHandle.onTeardown).toHaveBeenCalledTimes(2);
    // Clean up via the cancel path so the module-level `recording` flag resets.
    lastBarOpts!.onCancel();
    await Promise.resolve();
    view.destroy();
  });

  it("feeds the level event into the bar meter", async () => {
    const view = mount();
    await startVoiceRecording(view);
    await Promise.resolve();
    levelCb!(0.7);
    expect(barHandle.setLevel).toHaveBeenCalledWith(0.7);
    lastBarOpts!.onCancel();
    await Promise.resolve();
    view.destroy();
  });

  it("inserts a continuation-clip embed live and seeds the catalog", async () => {
    const view = mount("");
    await startVoiceRecording(view);
    await Promise.resolve();
    clipCb!(imported(ID, "clip1.wav"));
    expect(view.state.doc.toString()).toBe(`![[att:${ID}|clip1.wav]]`);
    // The catalog cache is seeded so the embed resolves to its player immediately.
    expect(view.state.field(catalogField)!.get(ID)!.contentType).toBe("audio/wav");
    lastBarOpts!.onCancel();
    await Promise.resolve();
    view.destroy();
  });

  it("toasts a mapped start error and does NOT mount the bar nor stay recording", async () => {
    voiceStart.mockRejectedValueOnce({ kind: "noInputDevice" });
    const view = mount();
    await startVoiceRecording(view);
    expect(mountRecordingBar).not.toHaveBeenCalled();
    expect(isRecording()).toBe(false);
    expect(showAttachmentToast).toHaveBeenCalledWith(
      "No microphone found. Connect one and try again.",
      "error",
    );
    view.destroy();
  });

  it("maps the alreadyRecording / locked / captureFailed / default start errors", async () => {
    const cases: Array<[unknown, string]> = [
      [{ kind: "locked" }, "Unlock your vault to record a voice note."],
      [{ kind: "alreadyRecording" }, "A recording is already in progress."],
      [
        { kind: "captureFailed" },
        "Couldn't start recording. Check microphone access in System Settings.",
      ],
      [{ kind: "weird" }, "Couldn't start recording."],
    ];
    for (const [err, msg] of cases) {
      showAttachmentToast.mockReset();
      voiceStart.mockRejectedValueOnce(err);
      const view = mount();
      await startVoiceRecording(view);
      expect(showAttachmentToast).toHaveBeenCalledWith(msg, "error");
      view.destroy();
    }
  });

  it("is a no-op while a recording is already in progress (single-recording guard)", async () => {
    const view = mount();
    await startVoiceRecording(view);
    await Promise.resolve();
    expect(isRecording()).toBe(true);
    voiceStart.mockClear();
    // A second start while recording must not re-enter the backend.
    await startVoiceRecording(view);
    expect(voiceStart).not.toHaveBeenCalled();
    lastBarOpts!.onCancel();
    await Promise.resolve();
    view.destroy();
  });
});

describe("finishRecording (Stop)", () => {
  it("stops, inserts the final clip embed, flips busy, and clears the recording flag", async () => {
    const view = mount("");
    vi.spyOn(view, "focus").mockImplementation(() => {});
    await startVoiceRecording(view);
    await Promise.resolve();

    voiceStop.mockResolvedValueOnce(imported(ID, "final.wav")); // stop returns the clip
    await lastBarOpts!.onStop();
    expect(barHandle.setBusy).toHaveBeenCalledOnce();
    // The display filename is stamped by the HOST now (`src/lib/voice-record.ts`
    // calls the package's own `voiceNoteFilename`), so what this asserts is that
    // stop was reached — the naming convention has its own test.
    expect(voiceStop).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe(`![[att:${ID}|final.wav]]`);
    expect(barHandle.teardown).toHaveBeenCalled();
    expect(isRecording()).toBe(false);
    view.destroy();
  });

  it("inserts nothing when stop returns null (all audio already went out as clips)", async () => {
    const view = mount("base");
    vi.spyOn(view, "focus").mockImplementation(() => {});
    await startVoiceRecording(view);
    await Promise.resolve();
    voiceStop.mockResolvedValueOnce(null); // stop → null
    await lastBarOpts!.onStop();
    expect(view.state.doc.toString()).toBe("base");
    expect(isRecording()).toBe(false);
    view.destroy();
  });

  it("toasts a mapped stop error and still tears the bar down + clears the flag", async () => {
    const view = mount("");
    await startVoiceRecording(view);
    await Promise.resolve();
    voiceStop.mockRejectedValueOnce({ kind: "silentRecording" }); // stop fails
    await lastBarOpts!.onStop();
    expect(showAttachmentToast).toHaveBeenCalledWith(
      "Recording was silent and discarded. Check your microphone.",
      "error",
    );
    expect(barHandle.teardown).toHaveBeenCalled();
    expect(isRecording()).toBe(false);
    view.destroy();
  });
});

describe("cancelRecording (Cancel)", () => {
  it("calls the cancel command, tears the bar down, and clears the flag", async () => {
    const view = mount("keep");
    await startVoiceRecording(view);
    await Promise.resolve();
    voiceCancel.mockClear();
    await lastBarOpts!.onCancel();
    expect(voiceCancel).toHaveBeenCalledOnce();
    expect(barHandle.teardown).toHaveBeenCalled();
    expect(isRecording()).toBe(false);
    // Nothing inserted on cancel.
    expect(view.state.doc.toString()).toBe("keep");
    view.destroy();
  });

  it("tears the bar down even when the cancel command rejects (best-effort)", async () => {
    const view = mount();
    await startVoiceRecording(view);
    await Promise.resolve();
    voiceCancel.mockRejectedValueOnce(new Error("ipc down")); // cancel fails
    await lastBarOpts!.onCancel();
    expect(barHandle.teardown).toHaveBeenCalled();
    expect(isRecording()).toBe(false);
    view.destroy();
  });
});
