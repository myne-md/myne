import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { readEphemeralFile } = await import("../../src/lib/ephemeralAttachment");

function fileOf(name: string, bytes: number[], type = "image/png"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("the composer's device lane", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("sends the bytes to the host and nothing about the vault", async () => {
    invoke.mockResolvedValue({
      name: "receipt.png",
      text: "TOTAL 42.00",
      status: "ok",
      char_count: 11,
      truncated: false,
    });
    const reading = await readEphemeralFile(fileOf("receipt.png", [1, 2, 3]));

    expect(reading.text).toBe("TOTAL 42.00");
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, payload] = invoke.mock.calls[0] as [string, { source: unknown }];
    // The lane that keeps the file out of the vault: no attachment id, no
    // folder, no scope — just the bytes and the name the composer shows.
    expect(command).toBe("plugin:attachments|attachment_extract_ephemeral");
    expect(payload).toEqual({
      source: { kind: "bytes", bytes: [1, 2, 3], filename: "receipt.png" },
    });
  });

  it("carries a nameless capture without inventing one", async () => {
    invoke.mockResolvedValue({
      name: "Untitled",
      text: "x",
      status: "ok",
      char_count: 1,
      truncated: false,
    });
    await readEphemeralFile(fileOf("", [0]));
    const [, payload] = invoke.mock.calls[0] as [string, { source: { filename: unknown } }];
    expect(payload.source.filename).toBeNull();
  });

  it("refuses an oversize file here rather than marshalling 64 MiB up", async () => {
    const huge = new File([new Uint8Array(64 * 1024 * 1024 + 1)], "huge.png");
    const reading = await readEphemeralFile(huge);
    expect(reading.status).toBe("failed");
    expect(reading.text).toBe("");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes a reading with no text straight through, because the sentence is the caller's", async () => {
    invoke.mockResolvedValue({
      name: "blank.png",
      text: "",
      status: "empty",
      char_count: 0,
      truncated: false,
    });
    const reading = await readEphemeralFile(fileOf("blank.png", [9]));
    expect(reading.status).toBe("empty");
  });
});
