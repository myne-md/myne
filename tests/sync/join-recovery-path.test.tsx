// @vitest-environment jsdom
//
// The join's second door and the waiting screen's escape (myne-md/myne#468,
// tasks 7 and 8).
//
// What these pin is the CALL, because the server decides approval on the wire
// path and nothing else: `credentialKind: "recovery"` self-approves, `"password"`
// waits for another device. Every production join sent the second until this
// change, so a phrase path that quietly sent it would leave the one user this
// door exists for — nobody left to approve — waiting forever, with a UI that
// looked finished.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Mutable so one test can take the capability away; the module is otherwise the
// real desktop descriptor.
const caps = { phraseEnrolment: true };
vi.mock("../../src/platform/capabilities", async (orig) => {
  const real = await orig<typeof import("../../src/platform/capabilities")>();
  return {
    ...real,
    has: (cap: string) =>
      cap === "phraseEnrolment" ? caps.phraseEnrolment : real.has(cap as never),
  };
});

import { JoinDeviceModal } from "../../src/components/sync/JoinDeviceModal";

const WORDS = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);

beforeEach(() => {
  invokeMock.mockReset();
  caps.phraseEnrolment = true;
});
afterEach(cleanup);

function fillCommon() {
  fireEvent.change(screen.getByTestId("join.server-input"), {
    target: { value: "https://sync.example" },
  });
  fireEvent.change(screen.getByTestId("join.account-input"), {
    target: { value: "MY-ABCD-EFGH-JKLM-NPQR-STVW" },
  });
}

/** Type the 24 words by pasting them into the first cell — the grid distributes. */
function pastePhrase() {
  const first = screen.getAllByTestId("join.phrase-cell")[0];
  fireEvent.paste(first, { clipboardData: { getData: () => WORDS.join(" ") } });
}

function joinCalls(): Array<Record<string, unknown>> {
  return invokeMock.mock.calls
    .filter((c) => c[0] === "plugin:sync|sync_join_account")
    .map((c) => c[1] as Record<string, unknown>);
}

describe("joining with the recovery phrase (task 7)", () => {
  it("sends the recovery path and hands off to the password reset", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_join_account") {
        return {
          device_id_hex: "aa",
          vault_id: "v1",
          pending: false,
          fingerprint: null,
          needs_password_reset: true,
        };
      }
      return "linux";
    });
    const onJoined = vi.fn();
    const onRecovering = vi.fn();
    render(<JoinDeviceModal onCancel={vi.fn()} onJoined={onJoined} onRecovering={onRecovering} />);
    fillCommon();
    fireEvent.click(await screen.findByTestId("join.mode-recovery"));
    // The warning is on screen BEFORE the grid is filled, not after submit.
    expect(screen.getByTestId("join.phrase-warning")).toBeTruthy();
    expect(screen.queryByTestId("join.password-input")).toBeNull();
    pastePhrase();
    fireEvent.click(screen.getByTestId("join.submit"));

    await waitFor(() => expect(onRecovering).toHaveBeenCalledTimes(1));
    const [call] = joinCalls();
    expect(call.credentialKind, "a phrase join sent the password path").toBe("recovery");
    // The phrase travels in the credential slot, joined with single spaces —
    // the same shape `buildPhraseCredential` gives every other phrase door.
    expect(String(call.password).split(" ")).toHaveLength(24);
    // A Recovering vault is not an unlocked one: never routed to the editor.
    expect(onJoined).not.toHaveBeenCalled();
  });

  it("still sends the password path by default", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_join_account") {
        return {
          device_id_hex: "aa",
          vault_id: "v1",
          pending: false,
          fingerprint: null,
          needs_password_reset: false,
        };
      }
      return "linux";
    });
    const onJoined = vi.fn();
    render(<JoinDeviceModal onCancel={vi.fn()} onJoined={onJoined} onRecovering={vi.fn()} />);
    fillCommon();
    fireEvent.change(screen.getByTestId("join.password-input"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByTestId("join.submit"));
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith("v1"));
    expect(joinCalls()[0].credentialKind).toBe("password");
  });

  it("offers no phrase path where the phrase is not a device credential", () => {
    // The web client's posture (`phraseEnrolment` absent): absent, not hidden.
    caps.phraseEnrolment = false;
    invokeMock.mockResolvedValue("linux");
    render(<JoinDeviceModal onCancel={vi.fn()} onJoined={vi.fn()} onRecovering={vi.fn()} />);
    expect(screen.queryByTestId("join.mode")).toBeNull();
    expect(screen.getByTestId("join.password-input")).toBeTruthy();
  });
});

describe("the waiting screen's escape (task 8)", () => {
  it("offers the phrase, enrols on the recovery path, and lands in the editor", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:sync|sync_join_account") {
        return {
          device_id_hex: "aa",
          vault_id: "v1",
          pending: true,
          fingerprint: null,
          needs_password_reset: false,
        };
      }
      if (cmd === "plugin:sync|sync_enroll") {
        return { approved: args?.credentialKind === "recovery", device_id_hex: "bb" };
      }
      // No head adopted yet: a non-null fingerprint is what moves the screen
      // from waiting to the SAS compare, and this test needs it to stay waiting.
      if (cmd === "plugin:sync|sync_head_fingerprint") return null;
      return "linux";
    });
    const onJoined = vi.fn();
    render(<JoinDeviceModal onCancel={vi.fn()} onJoined={onJoined} onRecovering={vi.fn()} />);
    fillCommon();
    fireEvent.change(screen.getByTestId("join.password-input"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByTestId("join.submit"));

    // Waiting — and no longer a dead end.
    await screen.findByTestId("join.pending");
    fireEvent.click(screen.getByTestId("join.use-phrase"));
    await screen.findByTestId("join.pending-phrase");
    pastePhrase();
    fireEvent.click(screen.getByTestId("join.phrase-submit"));

    await waitFor(() => expect(onJoined).toHaveBeenCalledWith("v1"));
    const enroll = invokeMock.mock.calls.find((c) => c[0] === "plugin:sync|sync_enroll");
    expect(enroll, "the escape never enrolled").toBeTruthy();
    const args = enroll![1] as Record<string, unknown>;
    expect(args.credentialKind).toBe("recovery");
    // The account number the user typed on the form — not asked for twice.
    expect(args.accountNumber).toBe("MY-ABCD-EFGH-JKLM-NPQR-STVW");
  });

  it("does not offer the escape where the phrase is not a device credential", async () => {
    caps.phraseEnrolment = false;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_join_account") {
        return {
          device_id_hex: "aa",
          vault_id: "v1",
          pending: true,
          fingerprint: null,
          needs_password_reset: false,
        };
      }
      return "linux";
    });
    render(<JoinDeviceModal onCancel={vi.fn()} onJoined={vi.fn()} onRecovering={vi.fn()} />);
    fillCommon();
    fireEvent.change(screen.getByTestId("join.password-input"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByTestId("join.submit"));
    await screen.findByTestId("join.pending");
    expect(screen.queryByTestId("join.use-phrase")).toBeNull();
  });
});

describe("full screen, not a modal card (task 10)", () => {
  it("renders in the auth shell and keeps its dialog semantics", () => {
    invokeMock.mockResolvedValue("linux");
    const { container } = render(
      <JoinDeviceModal onCancel={vi.fn()} onJoined={vi.fn()} onRecovering={vi.fn()} />,
    );
    const root = screen.getByTestId("join.modal");
    // Still modal over the stage beneath — the inert background depends on it.
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.getAttribute("aria-modal")).toBe("true");
    // Owns the window: fixed at every edge, and the shell's column inside.
    expect(root.style.position).toBe("fixed");
    expect(root.style.inset).toMatch(/^0(px)?$/);
    expect(container.querySelector(".myne-auth-view"), "not in the auth shell").not.toBeNull();
    // And no scrim: a card over a dimmed background is what this replaced.
    expect(root.style.background).not.toContain("--scrim");
  });
});
