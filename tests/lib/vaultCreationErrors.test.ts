// AppError → user-facing message mapping for vault creation (Q7 design session).
// Exhaustive over every AppError / ProtocolError / IoErrorKind arm: each arm
// pins its displayMode + primaryAction (the load-bearing routing — "dedicated"
// + "restart" routes to <SessionLostStep>; "inline" + "retry" renders a banner).
// A drift between this map and the Rust enums is a compile error at the source;
// these tests pin the *behaviour* of each arm so a copy/routing regression is
// caught.

import { describe, expect, it } from "vitest";

import { mapAppErrorToUserMessage } from "../../src/lib/vault-creation-errors";
import type {
  AppError,
  IoErrorKind,
  ProtocolError,
} from "../../src/types/protocol-error";

const protocol = (detail: ProtocolError): AppError => ({ kind: "Protocol", detail });
const io = (detail: IoErrorKind): AppError => ({ kind: "Io", detail });

describe("ProtocolError arms — all inline/retry", () => {
  const cases: ProtocolError["kind"][] = [
    "InvalidPassword",
    "PasswordTooShort",
    "KdfFailure",
    "AeadFailure",
    "InvalidVaultMeta",
    "AccountNumberInvalid",
    "Csprng",
  ];

  it.each(cases)("%s → inline banner with a retry action", (kind) => {
    const r = mapAppErrorToUserMessage(protocol({ kind } as ProtocolError));
    expect(r.displayMode).toBe("inline");
    expect(r.primaryAction).toBe("retry");
    expect(r.title.length).toBeGreaterThan(0);
    expect(r.body.length).toBeGreaterThan(0);
  });

  it("KdfFailure carries the low-memory hint copy", () => {
    const r = mapAppErrorToUserMessage(protocol({ kind: "KdfFailure" }));
    expect(r.title).toBe("Couldn't set up encryption");
    expect(r.body).toMatch(/low on memory/i);
  });

  it("PasswordTooShort names the 12-character floor", () => {
    const r = mapAppErrorToUserMessage(protocol({ kind: "PasswordTooShort" }));
    expect(r.body).toMatch(/12 characters/);
  });
});

describe("IoErrorKind arms — all inline/retry, distinct copy", () => {
  const cases: IoErrorKind["kind"][] = [
    "PermissionDenied",
    "NoSpace",
    "NotFound",
    "Other",
  ];

  it.each(cases)("%s → inline banner with a retry action", (kind) => {
    const r = mapAppErrorToUserMessage(io({ kind } as IoErrorKind));
    expect(r.displayMode).toBe("inline");
    expect(r.primaryAction).toBe("retry");
  });

  it("each Io variant maps to a DISTINCT title (no collapsed copy)", () => {
    const titles = cases.map(
      (kind) => mapAppErrorToUserMessage(io({ kind } as IoErrorKind)).title,
    );
    expect(new Set(titles).size).toBe(cases.length);
  });

  it("NoSpace points at freeing disk space", () => {
    const r = mapAppErrorToUserMessage(io({ kind: "NoSpace" }));
    expect(r.title).toBe("Not enough disk space");
    expect(r.body).toMatch(/disk space/i);
  });

  it("PermissionDenied points at the app-data folder permission", () => {
    const r = mapAppErrorToUserMessage(io({ kind: "PermissionDenied" }));
    expect(r.body).toMatch(/permission/i);
  });
});

describe("session-loss arms route to the dedicated SessionLostStep", () => {
  it("SessionNotFound → dedicated/restart", () => {
    const r = mapAppErrorToUserMessage({ kind: "SessionNotFound" });
    expect(r.displayMode).toBe("dedicated");
    expect(r.primaryAction).toBe("restart");
  });

  it("SessionExpired → dedicated/restart with the 10-minute timeout copy", () => {
    const r = mapAppErrorToUserMessage({ kind: "SessionExpired" });
    expect(r.displayMode).toBe("dedicated");
    expect(r.primaryAction).toBe("restart");
    expect(r.body).toMatch(/10 minutes/);
  });
});

describe("top-level non-session arms", () => {
  it("TooManyConcurrentSessions → inline/retry, names other windows", () => {
    const r = mapAppErrorToUserMessage({ kind: "TooManyConcurrentSessions" });
    expect(r.displayMode).toBe("inline");
    expect(r.primaryAction).toBe("retry");
    expect(r.body).toMatch(/windows/i);
  });

  it("JoinFailure → generic inline/retry", () => {
    const r = mapAppErrorToUserMessage({ kind: "JoinFailure" });
    expect(r.displayMode).toBe("inline");
    expect(r.primaryAction).toBe("retry");
  });

  it("VaultArtifactsPresent → dedicated/restart (route to unlock via restart)", () => {
    const r = mapAppErrorToUserMessage({ kind: "VaultArtifactsPresent" });
    expect(r.displayMode).toBe("dedicated");
    expect(r.primaryAction).toBe("restart");
    expect(r.title).toBe("Vault already exists");
  });

  it("VaultBusyAuth → inline/retry (transient lock)", () => {
    const r = mapAppErrorToUserMessage({ kind: "VaultBusyAuth" });
    expect(r.displayMode).toBe("inline");
    expect(r.primaryAction).toBe("retry");
    expect(r.title).toBe("Vault busy");
  });
});

describe("assertNever guards against an unmapped variant", () => {
  it("throws on an unknown AppError kind (compile-error analogue at runtime)", () => {
    expect(() =>
      mapAppErrorToUserMessage({ kind: "TotallyNew" } as unknown as AppError),
    ).toThrow(/Unhandled error variant/);
  });

  it("throws on an unknown ProtocolError kind", () => {
    expect(() =>
      mapAppErrorToUserMessage(
        protocol({ kind: "Bogus" } as unknown as ProtocolError),
      ),
    ).toThrow(/Unhandled error variant/);
  });

  it("throws on an unknown IoErrorKind", () => {
    expect(() =>
      mapAppErrorToUserMessage(io({ kind: "Weird" } as unknown as IoErrorKind)),
    ).toThrow(/Unhandled error variant/);
  });
});
