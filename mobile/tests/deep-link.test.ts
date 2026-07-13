// Unit coverage for the widget/deep-link capture latch (E2E-gap #39). The
// cold-launch mechanism — myne://capture[?mode=voice] parsing + the
// pre-editor-mount latch replayed on unlock — previously had ZERO tests. The
// flow-logic tier fires the WARM CAPTURE_EVENT directly, bypassing URL parsing
// and the cold-launch latch, so this fills the parse + latch half here. (The
// real locked-device cold launch stays a device check.)

import { describe, it, expect, beforeEach } from "vitest";
import { handleUrl, consumePendingCapture, CAPTURE_EVENT } from "../src/lib/deep-link";

describe("deep-link handleUrl (widget capture latch)", () => {
  beforeEach(() => {
    // The node test env has no DOM; a bare EventTarget is enough for the
    // CAPTURE_EVENT dispatch (Node ships CustomEvent globally).
    (globalThis as unknown as { window: EventTarget }).window = new EventTarget();
    consumePendingCapture(); // drain any latch left by a prior case
  });

  it("myne://capture latches a text capture and fires CAPTURE_EVENT", () => {
    let seen: string | null = null;
    (globalThis as unknown as { window: EventTarget }).window.addEventListener(
      CAPTURE_EVENT,
      (e) => {
        seen = (e as CustomEvent<{ mode: string }>).detail.mode;
      },
    );
    handleUrl("myne://capture");
    expect(seen).toBe("text");
    expect(consumePendingCapture()).toBe("text");
  });

  it("myne://capture?mode=voice latches a voice capture", () => {
    handleUrl("myne://capture?mode=voice");
    expect(consumePendingCapture()).toBe("voice");
  });

  it("an unknown mode falls back to text", () => {
    handleUrl("myne://capture?mode=bogus");
    expect(consumePendingCapture()).toBe("text");
  });

  it("myne://open launches without latching a capture", () => {
    handleUrl("myne://open");
    expect(consumePendingCapture()).toBeNull();
  });

  it("consumePendingCapture is one-shot (second read is null)", () => {
    handleUrl("myne://capture");
    expect(consumePendingCapture()).toBe("text");
    expect(consumePendingCapture()).toBeNull();
  });

  it("non-myne and malformed URLs are ignored without throwing", () => {
    expect(() => handleUrl("https://evil.example/capture?mode=voice")).not.toThrow();
    expect(() => handleUrl("not even a url")).not.toThrow();
    expect(consumePendingCapture()).toBeNull();
  });
});
