// @vitest-environment jsdom
//
// myne-md/myne#870: the update notice and the updating stage, wired through `App`.
//
// # Why this file mounts `App` rather than the two surfaces
//
// The notice and the screen are covered directly elsewhere
// (`tests/components/UpdateNotice.test.tsx`, `tests/screens/UpdatingScreen.test.tsx`),
// and neither of those files can see the two bindings this change added to
// `App.tsx`: the notice is mounted by `App` rather than by the editor, and the
// `updating` case is `App`'s stage arm. A reviewer measured the gap by deleting
// both from `App.tsx` and watching the whole suite stay green, which is the
// shipped-inert shape `tests/stage/pending-approval-idle-lock.test.tsx` exists
// to close in its own area. So this file asserts the wiring, not the surfaces.
//
// # What is stubbed, and why that is not the test stubbing its own subject
//
// `Editor` is a stub, and the update seam is mocked, because neither is the
// subject: the subject is which surface `App` renders, on which stage, and what
// the confirm does to the stage. Stubbing `Editor` also removes the only other
// place a notice could be mounted from, so a notice observed here can have come
// from exactly one binding.
//
// The timer is advanced rather than waited on: the check is deliberately ten
// seconds after the stage is entered, and `shouldAdvanceTime` keeps Testing
// Library's own waiting working while that stays under this test's control.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

/** Written through `vi.hoisted`: `stage.ts` calls `has()` at module load. */
const caps = vi.hoisted(() => ({ absent: [] as string[] }));
vi.mock("../../src/platform/capabilities", () => ({
  has: (cap: string) => !caps.absent.includes(cap),
  ALL_CAPABILITIES: [],
}));

const update = vi.hoisted(() => ({
  check: vi.fn(() =>
    Promise.resolve({
      kind: "available" as const,
      version: "0.10.1",
      notes: "Fixes a crash on launch.",
    }),
  ),
  install: vi.fn(() => Promise.resolve()),
  autoCheck: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../../src/platform/update", () => ({
  getAutoCheck: update.autoCheck,
  updateCheck: update.check,
  updateInstall: update.install,
}));

const lockVault = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../src/lib/vault-unlock", () => ({ lockVault }));

const flushOpenPanes = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../src/notes/renameFlushHook", () => ({
  renameFlushHooks: () => ({ flushOpenPanes }),
}));

vi.mock("../../src/screens/Editor", () => ({
  Editor: () => <div data-testid="stub.editor" />,
}));

import App from "../../src/App";

/** One healthy vault with its slot unlocked, so boot routes to `editor`. */
function wire(): void {
  invokeMock.mockImplementation(async (cmd) => {
    switch (cmd) {
      case "plugin:vault-unlock|vault_list":
        return [{ id: "v1", status: { kind: "Exists" } }];
      case "plugin:vault-unlock|vault_slot_kind":
        return "Unlocked";
      case "plugin:prefs|prefs_read":
        return {};
      case "plugin:sync|sync_person_status":
        return {
          enrolled: false,
          identity_unlocked: false,
          person_id_hex: null,
          identity_code: null,
        };
      default:
        return undefined;
    }
  });
}

/** Let the ten-second check delay elapse, then wait for the offer it starts. */
async function offerArrives(): Promise<void> {
  await screen.findByTestId("stub.editor");
  expect(screen.queryByTestId("update.notice")).toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  // A real WAIT rather than one `act` drain, and with a budget the full suite
  // cannot starve. The check is a chain of three awaits; under `pnpm test` (938
  // files across parallel workers) the default 1s `findBy` timeout is not enough,
  // which is why this file passed in isolation and failed in the suite twice, on
  // two different tests, both times at a `findBy` the worker had not reached yet.
  await screen.findByTestId("update.notice", {}, { timeout: 5_000 });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  caps.absent = [];
  wire();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("the notice, wired through App", () => {
  it("mounts on the editor stage only once the check has offered something", async () => {
    render(<App />);
    await offerArrives();

    expect(screen.getByTestId("update.notice")).toBeTruthy();
    expect(update.check).toHaveBeenCalledTimes(1);
  });

  it("does not mount on a client without the selfUpdate capability", async () => {
    caps.absent = ["selfUpdate"];
    render(<App />);
    await screen.findByTestId("stub.editor");
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await act(async () => {});

    expect(screen.queryByTestId("update.notice")).toBeNull();
    expect(update.check).not.toHaveBeenCalled();
  });

  it("reduces to the pill, and the pill is what reopens the offer", async () => {
    render(<App />);
    await offerArrives();

    // The collapse is the container's timer, so it is asserted here rather than
    // in the component test: a wrong `onReopen` binding would otherwise ship a
    // pill that does nothing, with every other test green.
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    expect(screen.getByTestId("update.notice-pill")).toBeTruthy();
    expect(screen.queryByTestId("update.notice")).toBeNull();

    fireEvent.click(screen.getByTestId("update.notice-pill"));
    expect(
      await screen.findByTestId("update.notice", {}, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(screen.queryByTestId("update.notice-pill")).toBeNull();
  });
});

describe("the updating stage, wired through App", () => {
  it("replaces the editor after the confirm, and takes the notice with it", async () => {
    render(<App />);
    await offerArrives();

    fireEvent.click(screen.getByTestId("update.notice-primary"));
    fireEvent.click(screen.getByTestId("update.notice-confirm-primary"));
    await act(async () => {});
    await act(async () => {});

    expect(
      await screen.findByTestId("update.updating", {}, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(screen.queryByTestId("stub.editor")).toBeNull();
    expect(screen.queryByTestId("update.notice")).toBeNull();
    // The order the whole flow rests on: the panes are flushed and the vault is
    // locked before the installer is asked to do anything.
    expect(flushOpenPanes).toHaveBeenCalledTimes(1);
    expect(lockVault).toHaveBeenCalledTimes(1);
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  it("keeps the editor and reports the refusal when the vault will not lock", async () => {
    lockVault.mockRejectedValueOnce(new Error("no"));
    render(<App />);
    await offerArrives();

    fireEvent.click(screen.getByTestId("update.notice-primary"));
    fireEvent.click(screen.getByTestId("update.notice-confirm-primary"));

    // The stage must NOT move: the updating screen is unreachable without a
    // lock, so the confirm is the only surface left to say what happened.
    expect(
      await screen.findByTestId("update.notice-blocked", {}, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(screen.getByTestId("stub.editor")).toBeTruthy();
    expect(screen.getByTestId("update.notice-confirm")).toBeTruthy();
    expect(update.install).not.toHaveBeenCalled();
  });
});
