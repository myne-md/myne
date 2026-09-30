// `myne://open-file` deep-link parsing + latch (myne-md/myne#788, task 12).
//
// The parser is pure, so the rejection matrix is asserted directly. The
// handler is driven with the platform seam mocked, because what it must prove
// is the two security-relevant behaviours around it: a gate-off link is
// dropped with NO latch and NO event (nothing to show), and a gate-on link
// latches the CANONICAL path the host resolved, never the one the link
// claimed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const gateGetMock = vi.fn();
const resolveMock = vi.fn();

vi.mock("../../src/platform/plainFile", () => ({
  plainFileGateGet: (...args: unknown[]) => gateGetMock(...args),
  plainFileResolvePath: (...args: unknown[]) => resolveMock(...args),
}));

import {
  MAX_PATH_CHARS,
  OPEN_FILE_EVENT,
  clearPendingOpenFile,
  consumePendingOpenFile,
  handleOpenFileDeepLinkUrl,
  parseOpenFileUrl,
} from "../../src/plain/openFileDeepLink";

const dispatched: string[] = [];

beforeEach(() => {
  gateGetMock.mockReset();
  resolveMock.mockReset();
  clearPendingOpenFile();
  dispatched.length = 0;
  vi.stubGlobal("window", {
    dispatchEvent: (event: Event) => {
      dispatched.push(event.type);
      return true;
    },
  });
});

describe("parseOpenFileUrl", () => {
  it("accepts the documented route and keeps the path verbatim", () => {
    const result = parseOpenFileUrl("myne://open-file?path=/tmp/note.md");
    expect(result).toEqual({ ok: true, path: "/tmp/note.md" });
  });

  it("accepts a percent-encoded file URL and decodes it", () => {
    const result = parseOpenFileUrl(
      "myne://open-file?path=file%3A%2F%2F%2Ftmp%2Fmy%20note.md",
    );
    expect(result).toEqual({ ok: true, path: "file:///tmp/my note.md" });
  });

  it("folds the host case, since an opaque scheme is not lowercased for us", () => {
    const result = parseOpenFileUrl("myne://OPEN-FILE?path=/tmp/note.md");
    expect(result.ok).toBe(true);
  });

  it("ignores every other myne:// action silently", () => {
    for (const raw of [
      "myne://theme/install?v=1&name=x&payload=e30",
      "myne://open?id=abc",
      "myne://capture?mode=voice",
    ]) {
      expect(parseOpenFileUrl(raw)).toEqual({
        ok: false,
        reason: "not-an-open-file-link",
      });
    }
  });

  it("ignores other protocols and junk", () => {
    for (const raw of ["https://myne.md/", "not a url", ""]) {
      expect(parseOpenFileUrl(raw)).toEqual({
        ok: false,
        reason: "not-an-open-file-link",
      });
    }
  });

  it("refuses a pathname on the route rather than guessing", () => {
    expect(parseOpenFileUrl("myne://open-file/extra?path=/tmp/note.md")).toEqual(
      { ok: false, reason: "not-an-open-file-link" },
    );
  });

  it("refuses a missing, empty or oversized path", () => {
    for (const raw of [
      "myne://open-file",
      "myne://open-file?path=",
      `myne://open-file?path=/${"a".repeat(MAX_PATH_CHARS)}`,
    ]) {
      expect(parseOpenFileUrl(raw)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("refuses a path carrying a control character", () => {
    expect(parseOpenFileUrl("myne://open-file?path=/tmp/a%0Ab.md")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("handleOpenFileDeepLinkUrl", () => {
  it("drops a gate-off link with no latch and no event", async () => {
    gateGetMock.mockResolvedValue(false);
    await handleOpenFileDeepLinkUrl("myne://open-file?path=/tmp/note.md");
    expect(gateGetMock).toHaveBeenCalledTimes(1);
    expect(resolveMock).not.toHaveBeenCalled();
    expect(consumePendingOpenFile()).toBeNull();
    expect(dispatched).toEqual([]);
  });

  it("latches the canonical path the host resolved, not the one in the link", async () => {
    gateGetMock.mockResolvedValue(true);
    resolveMock.mockResolvedValue("/canonical/note.md");
    await handleOpenFileDeepLinkUrl("myne://open-file?path=/tmp/link-claims.md");
    expect(resolveMock).toHaveBeenCalledWith("/tmp/link-claims.md");
    expect(consumePendingOpenFile()).toEqual({ path: "/canonical/note.md" });
    expect(dispatched).toEqual([OPEN_FILE_EVENT]);
  });

  it("drops a link the host refuses (missing file, unsupported type)", async () => {
    gateGetMock.mockResolvedValue(true);
    resolveMock.mockRejectedValue({ kind: "unsupported_extension" });
    await handleOpenFileDeepLinkUrl("myne://open-file?path=/tmp/note.txt");
    expect(consumePendingOpenFile()).toBeNull();
    expect(dispatched).toEqual([]);
  });

  it("never asks the host about another route", async () => {
    await handleOpenFileDeepLinkUrl("myne://theme/install?v=1&name=x");
    expect(gateGetMock).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("consumes the latch exactly once", async () => {
    gateGetMock.mockResolvedValue(true);
    resolveMock.mockResolvedValue("/canonical/note.md");
    await handleOpenFileDeepLinkUrl("myne://open-file?path=/tmp/note.md");
    expect(consumePendingOpenFile()).toEqual({ path: "/canonical/note.md" });
    expect(consumePendingOpenFile()).toBeNull();
  });
});
