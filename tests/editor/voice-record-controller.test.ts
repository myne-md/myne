// @vitest-environment jsdom
//
// Voice-note recording controller (MYND-259): the start / stop / cancel flow
// over the three Rust commands, the single-recording-at-a-time guard, the
// continuation-clip live insert, and the start/stop error→toast mapping. The
// Tauri `invoke` / `listen`, the recording-bar UI, and the toast are mocked at
// module scope; embeds insert into a real EditorView so the form-C output and
// catalog seeding are asserted for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

// `listen` returns an unlisten fn; capture the registered callbacks so tests can
// drive the level / continuation-clip event streams synchronously.
const listeners = new Map<string, (e: { payload: unknown }) => void>();
const unlisten = vi.fn();
const listen = vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
  listeners.set(event, cb);
  return unlisten;
});
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => (listen as Function)(...a) }));

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

beforeEach(() => {
  listeners.clear();
  lastBarOpts = null;
  invoke.mockReset();
  showAttachmentToast.mockReset();
  Object.values(barHandle).forEach((fn) => fn.mockReset());
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("startVoiceRecording", () => {
  it("starts the backend, mounts the bar, and registers level + clip listeners", async () => {
    invoke.mockResolvedValue(undefined);
    const view = mount();
    await startVoiceRecording(view);
    // microtask flush so the awaited listen() calls have registered.
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith("plugin:attachments|voice_record_start");
    expect(mountRecordingBar).toHaveBeenCalledOnce();
    expect(isRecording()).toBe(true);
    expect(listeners.has("voice-record:level")).toBe(true);
    expect(listeners.has("voice-record:clip")).toBe(true);
    // Both unlisten fns were registered for teardown.
    expect(barHandle.onTeardown).toHaveBeenCalledTimes(2);
    // Clean up via the cancel path so the module-level `recording` flag resets.
    invoke.mockResolvedValue(undefined);
    lastBarOpts!.onCancel();
    await Promise.resolve();
    view.destroy();
  });

  it("feeds the level event into the bar meter", async () => {
    invoke.mockResolvedValue(undefined);
    const view = mount();
    await startVoiceRecording(view);
    await Promise.resolve();
    listeners.get("voice-record:level")!({ payload: 0.7 });
    expect(barHandle.setLevel).toHaveBeenCalledWith(0.7);
    lastBarOpts!.onCancel();
    await Promise.resolve();
    view.destroy();
  });

  it("inserts a continuation-clip embed live and seeds the catalog", async () => {
    invoke.mockResolvedValue(undefined);
    const view = mount("");
    await startVoiceRecording(view);
    await Promise.resolve();
    listeners.get("voice-record:clip")!({ payload: imported(ID, "clip1.wav") });
    expect(view.state.doc.toString()).toBe(`![[att:${ID}|clip1.wav]]`);
    // The catalog cache is seeded so the embed resolves to its player immediately.
    expect(view.state.field(catalogField)!.get(ID)!.contentType).toBe("audio/wav");
    lastBarOpts!.onCancel();
    await Promise.resolve();
    view.destroy();
  });

  it("toasts a mapped start error and does NOT mount the bar nor stay recording", async () => {
    invoke.mockRejectedValueOnce({ kind: "noInputDevice" });
    const view = mount();
    await startVoiceRecording(view);
    expect(mountRecordingBar).not.toHaveBeenCalled();
    expect(isRecording()).toBe(false);
    expect(showAttachmentToast).toHaveBeenCalledWith(
      "No microphone found. Connect one and try again.",
    );
    view.destroy();
  });

  it("maps the alreadyRecording / locked / captureFailed / default start errors", async () => {
    const cases: Array<[unknown, string]> = [
      [{ kind: "locked" }, "Unlock your vault to record a voice note."],
      [{ kind: "alreadyRecording" }, "A recording is already in progress."],
      [
        { kind: "captureFailed" },
        "Couldn't start recording — check microphone access in System Settings.",
      ],
      [{ kind: "weird" }, "Couldn't start recording."],
    ];
    for (const [err, msg] of cases) {
      invoke.mockReset();
      showAttachmentToast.mockReset();
      invoke.mockRejectedValueOnce(err);
      const view = mount();
      await startVoiceRecording(view);
      expect(showAttachmentToast).toHaveBeenCalledWith(msg);
      view.destroy();
    }
  });

  it("is a no-op while a recording is already in progress (single-recording guard)", async () => {
    invoke.mockResolvedValue(undefined);
    const view = mount();
    await startVoiceRecording(view);
    await Promise.resolve();
    expect(isRecording()).toBe(true);
    invoke.mockClear();
    // A second start while recording must not re-invoke the backend.
    await startVoiceRecording(view);
    expect(invoke).not.toHaveBeenCalled();
    lastBarOpts!.onCancel();
    await Promise.resolve();
    view.destroy();
  });
});

describe("finishRecording (Stop)", () => {
  it("stops, inserts the final clip embed, flips busy, and clears the recording flag", async () => {
    invoke.mockResolvedValueOnce(undefined); // start
    const view = mount("");
    vi.spyOn(view, "focus").mockImplementation(() => {});
    await startVoiceRecording(view);
    await Promise.resolve();

    invoke.mockResolvedValueOnce(imported(ID, "final.wav")); // stop returns the clip
    await lastBarOpts!.onStop();
    expect(barHandle.setBusy).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      "plugin:attachments|voice_record_stop",
      expect.objectContaining({ filename: expect.stringMatching(/^Voice note .*\.wav$/) }),
    );
    expect(view.state.doc.toString()).toBe(`![[att:${ID}|final.wav]]`);
    expect(barHandle.teardown).toHaveBeenCalled();
    expect(isRecording()).toBe(false);
    view.destroy();
  });

  it("inserts nothing when stop returns null (all audio already went out as clips)", async () => {
    invoke.mockResolvedValueOnce(undefined); // start
    const view = mount("base");
    vi.spyOn(view, "focus").mockImplementation(() => {});
    await startVoiceRecording(view);
    await Promise.resolve();
    invoke.mockResolvedValueOnce(null); // stop → null
    await lastBarOpts!.onStop();
    expect(view.state.doc.toString()).toBe("base");
    expect(isRecording()).toBe(false);
    view.destroy();
  });

  it("toasts a mapped stop error and still tears the bar down + clears the flag", async () => {
    invoke.mockResolvedValueOnce(undefined); // start
    const view = mount("");
    await startVoiceRecording(view);
    await Promise.resolve();
    invoke.mockRejectedValueOnce({ kind: "silentRecording" }); // stop fails
    await lastBarOpts!.onStop();
    expect(showAttachmentToast).toHaveBeenCalledWith(
      "Recording was silent and discarded — check your microphone.",
    );
    expect(barHandle.teardown).toHaveBeenCalled();
    expect(isRecording()).toBe(false);
    view.destroy();
  });
});

describe("cancelRecording (Cancel)", () => {
  it("calls the cancel command, tears the bar down, and clears the flag", async () => {
    invoke.mockResolvedValueOnce(undefined); // start
    const view = mount("keep");
    await startVoiceRecording(view);
    await Promise.resolve();
    invoke.mockClear();
    invoke.mockResolvedValueOnce(undefined); // cancel
    await lastBarOpts!.onCancel();
    expect(invoke).toHaveBeenCalledWith("plugin:attachments|voice_record_cancel");
    expect(barHandle.teardown).toHaveBeenCalled();
    expect(isRecording()).toBe(false);
    // Nothing inserted on cancel.
    expect(view.state.doc.toString()).toBe("keep");
    view.destroy();
  });

  it("tears the bar down even when the cancel command rejects (best-effort)", async () => {
    invoke.mockResolvedValueOnce(undefined); // start
    const view = mount();
    await startVoiceRecording(view);
    await Promise.resolve();
    invoke.mockRejectedValueOnce(new Error("ipc down")); // cancel fails
    await lastBarOpts!.onCancel();
    expect(barHandle.teardown).toHaveBeenCalled();
    expect(isRecording()).toBe(false);
    view.destroy();
  });
});
