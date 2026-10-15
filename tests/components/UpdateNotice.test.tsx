// @vitest-environment jsdom
//
// Component tests for `src/components/update/UpdateNotice.tsx` (myne-md/myne#870).
//
// The notice is prop-driven on purpose, so every state is asserted here without
// faking a host: the three views, the release-notes block's nullable half, and
// the fact that the confirm's own buttons are the only way to reach the install.
// The accessible-copy assertions are deliberately key-based (`t` returns the
// key), so a copy edit does not have to touch this file; what it pins is WHICH
// line is rendered in which state.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { UpdateNotice } from "../../src/components/update/UpdateNotice";

const NOTES =
  "Attachments sync in both directions.\nThe task panel keeps its scroll position.";

function handlers() {
  return {
    onRequestUpdate: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onLater: vi.fn(),
    onReopen: vi.fn(),
  };
}

function renderNotice(view: "offer" | "confirm" | "pill", notes: string | null = NOTES) {
  const spies = handlers();
  render(<UpdateNotice view={view} version="0.10.1" notes={notes} {...spies} />);
  return spies;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the offer", () => {
  it("renders the version line, the release notes and the consequence, and its own press only asks", () => {
    const spies = renderNotice("offer");
    expect(screen.getByTestId("update.notice")).toBeTruthy();
    expect(screen.getByText("update.notice.available")).toBeTruthy();
    expect(screen.getByText(/Attachments sync in both directions/)).toBeTruthy();
    expect(screen.getByText("update.notice.consequence")).toBeTruthy();

    fireEvent.click(screen.getByTestId("update.notice-primary"));
    expect(spies.onRequestUpdate).toHaveBeenCalledTimes(1);
    // The offer's press must NOT start anything: the confirm is the informed
    // one, and a regression that wired both buttons to the same handler would
    // read as a working flow.
    expect(spies.onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("update.notice-later"));
    expect(spies.onLater).toHaveBeenCalledTimes(1);
  });

  it("renders cleanly when the manifest carries no release notes", () => {
    renderNotice("offer", null);
    expect(screen.getByTestId("update.notice")).toBeTruthy();
    expect(screen.queryByText(/Attachments sync in both directions/)).toBeNull();
    // The consequence line is not optional, and it is what makes the confirm a
    // confirmation rather than a second chance to read.
    expect(screen.getByText("update.notice.consequence")).toBeTruthy();
  });
});

describe("the confirm", () => {
  it("names the lock and the restart, and is the only surface that installs", () => {
    const spies = renderNotice("confirm");
    expect(screen.getByTestId("update.notice-confirm")).toBeTruthy();
    expect(screen.getByText("update.notice.confirmBody")).toBeTruthy();
    // The offer's own line is replaced, not stacked on top of: two consequence
    // sentences would read as two different promises.
    expect(screen.queryByText("update.notice.consequence")).toBeNull();

    fireEvent.click(screen.getByTestId("update.notice-confirm-primary"));
    expect(spies.onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("update.notice-cancel"));
    expect(spies.onCancel).toHaveBeenCalledTimes(1);
    expect(spies.onLater).not.toHaveBeenCalled();
  });
});

describe("the pill", () => {
  it("is one control, and its press is the way back to the offer", () => {
    const spies = renderNotice("pill");
    expect(screen.getByTestId("update.notice-pill")).toBeTruthy();
    // The card is gone, which is the whole point of reducing.
    expect(screen.queryByTestId("update.notice")).toBeNull();

    fireEvent.click(screen.getByTestId("update.notice-pill"));
    expect(spies.onReopen).toHaveBeenCalledTimes(1);
    expect(spies.onConfirm).not.toHaveBeenCalled();
  });
});

describe("a confirm that refused to start", () => {
  function renderBlocked(blocked: "flush" | "lock" | "stage") {
    const spies = handlers();
    render(
      <UpdateNotice
        view="confirm"
        version="0.10.1"
        notes={NOTES}
        blocked={blocked}
        {...spies}
      />,
    );
    return spies;
  }

  it("says which step refused, and stays pressable so the retry is the same button", () => {
    const spies = renderBlocked("lock");
    expect(screen.getByTestId("update.notice-blocked")).toBeTruthy();
    // The line differs per step, so the three refusals are distinguishable
    // rather than one vague "something went wrong".
    expect(screen.getByText("update.notice.lockFailed")).toBeTruthy();
    expect(screen.queryByText("update.notice.flushFailed")).toBeNull();

    fireEvent.click(screen.getByTestId("update.notice-confirm-primary"));
    expect(spies.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("names the flush when a pane would not save", () => {
    renderBlocked("flush");
    expect(screen.getByText("update.notice.flushFailed")).toBeTruthy();
  });

  it("names the stage when the app had already left the vault", () => {
    renderBlocked("stage");
    expect(screen.getByText("update.notice.stageFailed")).toBeTruthy();
  });
});

describe("while the flow is working", () => {
  it("disables the confirm's buttons, so one press cannot become two installers", () => {
    const spies = handlers();
    render(
      <UpdateNotice
        view="confirm"
        version="0.10.1"
        notes={NOTES}
        working
        {...spies}
      />,
    );
    const confirm = screen.getByTestId(
      "update.notice-confirm-primary",
    ) as HTMLButtonElement;
    const cancel = screen.getByTestId("update.notice-cancel") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);

    fireEvent.click(confirm);
    expect(spies.onConfirm).not.toHaveBeenCalled();
  });
});
