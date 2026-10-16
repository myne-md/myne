// @vitest-environment jsdom
//
// Component tests for `src/components/sync/PersonIdentityUnlock.tsx`
// (myne-md/myne#831), the ONE inline session unlock of the person identity.
// These moved here from `memberRosterPanel.test.tsx` when the roster's duplicate
// grid was removed: the control now lives in the Sync panel's Identity block.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  getPersonIdentityState,
  resetPersonIdentityState,
} from "../../src/components/sync/personIdentityState";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type UnlockView = {
  fingerprint_hex: string;
  person_id_hex: string;
  identity_code: string;
};

let mockUnlock: () => Promise<UnlockView> = () =>
  Promise.resolve({
    fingerprint_hex: "00".repeat(32),
    person_id_hex: "11".repeat(16),
    identity_code: "MYNE-PERSON-1:owner",
  });

vi.mock("../../src/lib/invite", () => ({
  personUnlock: () => mockUnlock(),
}));

import { PersonIdentityUnlock } from "../../src/components/sync/PersonIdentityUnlock";
import { PHRASE_CELL_COUNT } from "../../src/components/sync/EnrollPhraseCredential";

const CELL_IDS = Array.from({ length: PHRASE_CELL_COUNT }, (_, index) =>
  index === 0
    ? "sync.panel.identity-unlock.phrase-input"
    : `sync.panel.identity-unlock.phrase-cell-${index + 1}`,
);

function fillPhrase(): void {
  for (const testId of CELL_IDS) {
    fireEvent.change(screen.getByTestId(testId), { target: { value: "abandon" } });
  }
}

beforeEach(() => {
  resetPersonIdentityState();
  mockUnlock = () =>
    Promise.resolve({
      fingerprint_hex: "00".repeat(32),
      person_id_hex: "11".repeat(16),
      identity_code: "MYNE-PERSON-1:owner",
    });
});

afterEach(() => {
  cleanup();
  resetPersonIdentityState();
});

describe("PersonIdentityUnlock", () => {
  it("offers the phrase entry collapsed, opening on request", () => {
    const onOpenChange = vi.fn();
    render(<PersonIdentityUnlock open={false} onOpenChange={onOpenChange} />);
    expect(screen.queryByTestId("sync.panel.identity-unlock.phrase-grid")).toBeNull();
    fireEvent.click(screen.getByTestId("sync.panel.identity-unlock.open"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("collapses the grid and clears the cells on cancel", () => {
    function Wrapper() {
      const [open, setOpen] = useState(false);
      return <PersonIdentityUnlock open={open} onOpenChange={setOpen} />;
    }
    render(<Wrapper />);
    fireEvent.click(screen.getByTestId("sync.panel.identity-unlock.open"));
    fireEvent.change(screen.getByTestId("sync.panel.identity-unlock.phrase-input"), {
      target: { value: "abandon" },
    });
    fireEvent.click(screen.getByTestId("sync.panel.identity-unlock.cancel"));
    expect(screen.queryByTestId("sync.panel.identity-unlock.phrase-grid")).toBeNull();
    // Re-opening starts from an empty grid, not the abandoned cells.
    fireEvent.click(screen.getByTestId("sync.panel.identity-unlock.open"));
    expect(
      (screen.getByTestId("sync.panel.identity-unlock.phrase-input") as HTMLInputElement).value,
    ).toBe("");
  });

  it("exposes the recovery-phrase field under a programmatic label", () => {
    render(<PersonIdentityUnlock open onOpenChange={() => {}} />);
    const input = screen.getByTestId(
      "sync.panel.identity-unlock.phrase-input",
    ) as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.style.padding).toBe("var(--space-1) var(--space-2)");
    expect(input.style.borderRadius).toBe("var(--radius-1)");
    expect(input.getAttribute("aria-label")).toBe("sync.enroll.wordAria");

    // The label query resolves to the same element: assistive tech names it.
    expect(screen.getAllByLabelText("sync.enroll.wordAria")[0]).toBe(input);
  });

  it("pads its own body, inset like the header", () => {
    // `ModalShell`'s body has no padding, so the grid and the buttons ran flush
    // to the border (myne-md/myne#867, on the user's read).
    render(<PersonIdentityUnlock open onOpenChange={() => {}} />);
    const body = document.querySelector(".myne-modal-body")?.firstElementChild as HTMLElement;
    expect(body.contains(screen.getByTestId("sync.panel.identity-unlock.submit"))).toBe(true);
    expect(body.style.padding).toBe("var(--space-4) var(--space-5) var(--space-5)");
  });

  it("keeps the phrase grid inside its container at any panel width", () => {
    render(<PersonIdentityUnlock open onOpenChange={() => {}} />);
    const grid = screen.getByTestId(
      "sync.panel.identity-unlock.phrase-grid",
    ) as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("repeat(4, minmax(0, 1fr))");
    const wraps = Array.from(grid.children) as HTMLElement[];
    expect(wraps).toHaveLength(PHRASE_CELL_COUNT);
    for (const wrap of wraps) {
      expect(wrap.style.minWidth).toBe("0px");
    }
  });

  it("unlocks the identity from the phrase and publishes it to the store", async () => {
    render(<PersonIdentityUnlock open onOpenChange={() => {}} />);
    fillPhrase();
    fireEvent.click(screen.getByTestId("sync.panel.identity-unlock.submit"));
    await waitFor(() => {
      expect(getPersonIdentityState()).toEqual({
        ready: true,
        ownerCode: "MYNE-PERSON-1:owner",
      });
    });
  });

  it("shows the typed error when the phrase does not open an identity", async () => {
    mockUnlock = () => Promise.reject(new Error("bad phrase"));
    render(<PersonIdentityUnlock open onOpenChange={() => {}} />);
    fillPhrase();
    fireEvent.click(screen.getByTestId("sync.panel.identity-unlock.submit"));
    await screen.findByTestId("sync.panel.identity-unlock.error");
    expect(getPersonIdentityState().ready).toBe(false);
  });

  it("does not publish an unlock that resolves after a session reset", async () => {
    let resolveUnlock!: (view: UnlockView) => void;
    mockUnlock = () =>
      new Promise<UnlockView>((resolve) => {
        resolveUnlock = resolve;
      });
    render(<PersonIdentityUnlock open onOpenChange={() => {}} />);
    fillPhrase();
    fireEvent.click(screen.getByTestId("sync.panel.identity-unlock.submit"));
    resetPersonIdentityState();
    resolveUnlock({
      fingerprint_hex: "00".repeat(32),
      person_id_hex: "11".repeat(16),
      identity_code: "MYNE-PERSON-1:stale",
    });
    await waitFor(() => {
      expect(getPersonIdentityState().ready).toBe(false);
    });
  });
});
