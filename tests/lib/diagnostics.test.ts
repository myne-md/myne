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
  vaultGeneration: "NTV8",
  vaultAuthority: "missing:no_key_at_rest",
  vaultBinding: "orphaned",
  vaultKeyAtRest: "absent",
  vaultSession: "person=closed device=adopted",
  engine: "Chrome 140",
  crossOriginIsolated: true,
  storageUsedMb: 12,
  storageQuotaMb: 10240,
  storageEntries: 418,
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

  // Issue #970, item 15. A desktop block carried four `unknown`s out of nine
  // lines, which reads as an app that cannot read its own state. A reading the
  // client cannot take is now ABSENT: the absence says the same thing once, and
  // the panel no longer owes a paragraph explaining its own output.
  it("omits a reading the client cannot take, rather than printing a placeholder", () => {
    const unreadable = {
      commit: null,
      bundleHash: null,
      storageUsedMb: null,
      storageQuotaMb: null,
      storageEntries: null,
      engine: null,
    };
    const text = buildDiagnostics({ ...INPUTS, ...unreadable });
    for (const gone of Object.keys(unreadable)) {
      expect(text, `${gone} is a placeholder, not a measurement`).not.toContain(`${gone}:`);
    }
    expect(text).not.toContain("unknown");
    // The rest of the block is untouched: a dropped reading is not a dropped
    // report, and the failure code is the line a maintainer came for. The count is
    // DERIVED from the allowlist rather than written down, so adding a field does not
    // leave a stale number asserting the old size of the block.
    expect(text).toContain("failureCode: worker-fatal");
    expect(text.split("\n")).toHaveLength(
      DIAGNOSTIC_FIELDS.length - Object.keys(unreadable).length,
    );
  });

  // myne-md/myne#1003. The five vault facts are the reason a pasted block can now
  // answer "why will this device not sync" without a week of forensics, and they are
  // absent (never placeholdered) when there is no vault to diagnose. This is the same
  // rule the case above pins, stated for the fields that carry the most information.
  it("omits the vault verdict when there is no vault to diagnose", () => {
    const text = buildDiagnostics({
      ...INPUTS,
      vaultGeneration: null,
      vaultAuthority: null,
      vaultBinding: null,
      vaultKeyAtRest: null,
      vaultSession: null,
    });
    for (const gone of [
      "vaultGeneration",
      "vaultAuthority",
      "vaultBinding",
      "vaultKeyAtRest",
      "vaultSession",
    ]) {
      expect(text, `${gone} is a placeholder, not a reading`).not.toContain(`${gone}:`);
    }
    expect(text).not.toContain("unknown");
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
  it("names the WebView a desktop build runs in, not the browser whose UA it borrows", () => {
    const WKWEBVIEW =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    const WEBKITGTK =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    expect(engineLabel(WKWEBVIEW, "WKWebView")).toBe("WKWebView 605");
    expect(engineLabel(WEBKITGTK, "WebKitGTK")).toBe("WebKitGTK 605");
    // iOS WKWebView, which adds a `Mobile/… Safari/604.1` tail but still no
    // `Version/`.
    expect(
      engineLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1",
        "WKWebView",
      ),
    ).toBe("WKWebView 605");
  });

  // The first attempt at this item named the WebView only as a LAST rule, so a
  // WebKitGTK view (which sends a real `Version/… Safari/…` tail) still matched
  // the Safari rule first and the desktop app reported itself as Safari. The
  // host argument is checked before every UA rule for that reason.
  it("does not call a WebKitGTK build Safari, whatever its UA claims", () => {
    const GTK_SAFARI_SHAPED =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.0 Safari/605.1.15";
    expect(engineLabel(GTK_SAFARI_SHAPED, "WebKitGTK")).toBe("WebKitGTK 605");
    expect(engineLabel(GTK_SAFARI_SHAPED)).toBe("Safari 60");
  });

  it("names WebView2 for the Windows host, from the Chromium token", () => {
    const WEBVIEW2 =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
    expect(engineLabel(WEBVIEW2, "WebView2")).toBe("WebView2 140");
    expect(engineLabel(WEBVIEW2, "Android WebView")).toBe("Android WebView 537");
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

  it("returns null rather than guessing", () => {
    // `null`, not the word "unknown": the caller omits the line, so a pasted
    // block never carries a field that says nothing (issue #970, item 15).
    expect(engineLabel("some-crawler/1.0")).toBeNull();
  });
});
