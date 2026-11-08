// @vitest-environment jsdom
// `usePrefValue` — the join between a pref's read half and its write half
// (myne-md/myne#995).
//
// Each case below is a behaviour the sixteen hand-rolled blocks in
// `src/components/settings/` got DIFFERENTLY, so this file is as much a record of
// the decision as a test of it:
//
//   - a refused write converges on DISK TRUTH, not on the value captured before the
//     write. Two rapid toggles capture one baseline and the first one's rollback then
//     inverts the control against the second write's result, which is the defect
//     `src/hooks/usePrefs.ts` already documents one level up.
//   - a refused write that cannot even re-read keeps the optimistic value rather than
//     snapping back to something nobody verified.
//   - a failed MOUNT read is not an error: the panel keeps the caller's default,
//     because opening against a locked vault is a normal frame, not a save failure.
//   - the error clears on the next successful write, so a surface that recovered does
//     not keep accusing itself.

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { usePrefValue } from "@myne/client-core/pref-value";

interface View {
  enabled: boolean;
  label: string;
}

const view = (enabled: boolean): View => ({ enabled, label: "from disk" });

function setup(options: {
  read?: () => Promise<View>;
  write?: (next: boolean) => Promise<unknown>;
}) {
  return renderHook(() =>
    usePrefValue<View, boolean>({
      read: options.read ?? (async () => view(false)),
      select: (v) => v.enabled,
      write: options.write ?? (async () => undefined),
      initial: true,
      errorMessage: "Saving this setting did not work.",
    }),
  );
}

describe("usePrefValue", () => {
  it("takes the value from the first read, not from the default", async () => {
    // Default true, disk says false: a surface that kept `initial` would show a
    // switch that disagrees with the vault for the whole session.
    const { result } = setup({});
    await waitFor(() => expect(result.current.value).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it("applies the value before the write resolves", async () => {
    let release: () => void = () => {};
    const write = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { result } = setup({ write });
    await waitFor(() => expect(result.current.value).toBe(false));

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.set(true);
    });
    expect(result.current.value).toBe(true);
    await act(async () => {
      release();
      await pending;
    });
    expect(write).toHaveBeenCalledWith(true);
    expect(result.current.error).toBeNull();
  });

  it("converges on disk truth when the write is refused", async () => {
    // The defect this pins: rolling back to the value captured before the write (or
    // to `initial`) shows `true` while the vault still says `false`. The two answers
    // are distinguishable here ONLY because `initial` and disk DISAGREE — the first
    // version of this case had `initial: true` and a disk that then became `true`, so
    // a rollback passed it too. A fixture the defect cannot be reached in is not a
    // test, and only the injection found it.
    const read = async () => view(false);
    const write = async () => {
      throw new Error("refused");
    };
    const { result } = setup({ read, write });
    await waitFor(() => expect(result.current.value).toBe(false));

    await act(async () => {
      await result.current.set(true);
    });
    expect(result.current.value).toBe(false);
    expect(result.current.error).toBe("Saving this setting did not work.");
  });

  it("keeps the optimistic value when the convergence read also fails", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      if (reads > 1) throw new Error("locked");
      return view(false);
    };
    const write = async () => {
      throw new Error("refused");
    };
    const { result } = setup({ read, write });
    await waitFor(() => expect(result.current.value).toBe(false));

    await act(async () => {
      await result.current.set(true);
    });
    expect(result.current.value).toBe(true);
    expect(result.current.error).toBe("Saving this setting did not work.");
  });

  it("does not treat a failed mount read as an error", async () => {
    const read = async () => {
      throw new Error("SlotNotUnlocked");
    };
    const { result } = setup({ read });
    await waitFor(() => expect(result.current.value).toBe(true));
    expect(result.current.error).toBeNull();
  });

  it("clears the error on the next successful write", async () => {
    let refuse = true;
    const write = async () => {
      if (refuse) throw new Error("refused");
    };
    const { result } = setup({ write });
    await waitFor(() => expect(result.current.value).toBe(false));

    await act(async () => {
      await result.current.set(true);
    });
    expect(result.current.error).not.toBeNull();

    refuse = false;
    await act(async () => {
      await result.current.set(true);
    });
    expect(result.current.error).toBeNull();
  });
});
