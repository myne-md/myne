// The copyable diagnostic block's allowlist (phase3-web-client task 114).
//
// `FailClosedError` carries "NO diagnostic detail in prod (TB6)". Task 114
// narrows that to "no *unbounded* detail" — and the narrowing is only safe if
// the payload cannot grow by accident. A blocklist cannot give that: it works
// until someone adds a field nobody thought to forbid, which is how a note id or
// a path ends up in a block the user pastes into a public issue.
//
// So this file is the check that makes "allowlist" a property rather than a
// description: the produced key set must EQUAL the declared list. A field added
// anywhere else fails here.

import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_FIELDS,
  buildDiagnostics,
  diagnosticRecord,
  engineLabel,
} from "../../src/lib/diagnostics";

const INPUTS = {
  version: "0.1.0",
  channel: "Stable",
  commit: "c1cf94a",
  bundleHash: "sha256:03ef5d60",
  failureCode: "worker-fatal",
  engine: "Chrome 140",
  crossOriginIsolated: true,
  storageUsedMb: 12,
  storageQuotaMb: 10240,
};

describe("diagnostic block", () => {
  it("produces EXACTLY the allowlisted fields, no more and no fewer", () => {
    // Equality, not containment. `toContain` would pass on a block that grew a
    // tenth field, which is the entire failure this test exists to catch.
    expect(Object.keys(diagnosticRecord(INPUTS))).toEqual([...DIAGNOSTIC_FIELDS]);
  });

  it("renders every allowlisted field into the copied text", () => {
    const text = buildDiagnostics(INPUTS);
    for (const field of DIAGNOSTIC_FIELDS) {
      expect(text, `${field} is allowlisted but not rendered`).toContain(`${field}:`);
    }
  });

  it("carries none of the things a pasted block must never carry", () => {
    // Named individually rather than as "no unexpected keys", because these are
    // the specific values that turn a support paste into a disclosure. Each is
    // fed in as a would-be leak: if any ever became a field, it would appear.
    const text = buildDiagnostics(INPUTS);
    const forbidden = [
      "MY-4K7P-9QRS-2TVW-XYZ0-1234", // an account number
      "0193e8d3-1234-7890-abcd-ef0123456789", // a note id
      "/Users/", // a filesystem path
      "Mozilla/5.0", // the full UA string
    ];
    for (const value of forbidden) {
      expect(text).not.toContain(value);
    }
    // And no free-text error message: the block carries a bounded CODE, which is
    // what a maintainer can act on, rather than arbitrary text from arbitrary
    // code that may quote a path, a title or a credential in scope.
    expect(text).toContain("failureCode: worker-fatal");
    expect(text).not.toMatch(/message|stack|at .*\(/i);
  });

  it("reports an absent value as `unknown` rather than as an empty field", () => {
    // A blank after a colon reads as "there is nothing there"; `unknown` reads
    // as "this client could not tell you", which is the true statement on a
    // desktop build with no served bundle.
    const text = buildDiagnostics({ ...INPUTS, commit: null, bundleHash: null, storageUsedMb: null });
    expect(text).toContain("commit: unknown");
    expect(text).toContain("bundleHash: unknown");
    expect(text).toContain("storageUsedMb: unknown");
  });

  it("is a flat readable list, not JSON", () => {
    // A user pastes this into an issue or a message. A flat list survives that;
    // a JSON blob invites trimming, and a trimmed blob is a block missing the
    // one field that mattered.
    const text = buildDiagnostics(INPUTS);
    expect(text.startsWith("{")).toBe(false);
    expect(text.split("\n")).toHaveLength(DIAGNOSTIC_FIELDS.length);
  });
});

describe("engine label", () => {
  it("picks the MOST SPECIFIC engine, not the first token that matches", () => {
    // Order is load-bearing: Chrome's UA also contains `Safari`, and Edge's
    // contains both. A naive scan reports every Edge user as Chrome and every
    // Chrome user as Safari.
    const EDGE =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
    const CHROME =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    const SAFARI =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";
    const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
    expect(engineLabel(EDGE)).toBe("Edge 140");
    expect(engineLabel(CHROME)).toBe("Chrome 140");
    expect(engineLabel(SAFARI)).toBe("Safari 18");
    expect(engineLabel(FIREFOX)).toBe("Firefox 133");
  });

  it("reduces to two tokens, discarding the fingerprinting tail", () => {
    const UA =
      "Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
    const label = engineLabel(UA);
    expect(label).toBe("Chrome 140");
    // The device model and build id are exactly the tail that must not travel.
    expect(label).not.toContain("SM-S911B");
    expect(label).not.toContain("Android");
  });

  // Issue #970, item 14. The block said `engine: unknown` on BOTH desktop
  // hosts, because neither UA carries a `Version/… Safari` pair or a Chrome
  // token: macOS WKWebView and Linux WebKitGTK send `AppleWebKit/<ver>` and
  // nothing else the five rules above recognise. The app's two primary desktop
  // surfaces reported no engine at all.
  it("names WebKit for the desktop WebViews", () => {
    const WKWEBVIEW =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    const WEBKITGTK =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    expect(engineLabel(WKWEBVIEW)).toBe("WebKit 605");
    expect(engineLabel(WEBKITGTK)).toBe("WebKit 605");
    // iOS WKWebView, which adds a `Mobile/… Safari/604.1` tail but still no
    // `Version/`.
    expect(
      engineLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1",
      ),
    ).toBe("WebKit 605");
  });

  it("still prefers the specific engine over WebKit", () => {
    // The rule above is last on purpose: every Chromium UA carries
    // `AppleWebKit/537.36`, so a WebKit rule placed anywhere earlier would
    // relabel every Chrome and Edge user.
    expect(
      engineLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome 140");
  });

  it("says `unknown` rather than guessing", () => {
    expect(engineLabel("some-crawler/1.0")).toBe("unknown");
  });
});
