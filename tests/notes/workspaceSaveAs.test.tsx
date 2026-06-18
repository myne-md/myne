// @vitest-environment jsdom
//
// Named-workspaces save-as regression (MYND-308). The slot ops default their
// id factories to `crypto.randomUUID`; passing the method DETACHED and calling it
// (`newId()`) throws `TypeError: Value of "this" must be of type Crypto`. The
// other workspace tests always INJECT a deterministic factory, which masked the
// crash — so these exercise the PRODUCTION default path explicitly: the bare
// `saveAsSlot(c, name)` / `createSlot(c, name)` / `deleteSlot(c, id)` the context
// callbacks call, plus the full provider save-as on a nested split layout.

import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { WorkspaceProvider, useWorkspace } from "../../src/notes/workspaceContext";
import {
  wrapAsSingleSlot,
  saveAsSlot,
  createSlot,
  deleteSlot,
  emptyWorkspace,
} from "../../src/notes/workspaceState";

function wrapper({ children }: { children: ReactNode }) {
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}

describe("named-workspaces slot ops — default crypto.randomUUID factory", () => {
  it("saveAsSlot with NO injected factory does not throw + mints a real id", () => {
    const container = wrapAsSingleSlot(emptyWorkspace("p0"), "slot0", "Default");
    let saved!: ReturnType<typeof saveAsSlot>;
    expect(() => {
      saved = saveAsSlot(container, "Saved"); // production path: default factory
    }).not.toThrow();
    expect(saved.slots).toHaveLength(2);
    const cloneId = saved.activeId;
    expect(typeof cloneId).toBe("string");
    expect(cloneId.length).toBeGreaterThan(0);
    expect(cloneId).not.toBe("slot0");
  });

  it("createSlot + deleteSlot with NO injected factory do not throw", () => {
    const container = wrapAsSingleSlot(emptyWorkspace("p0"), "slot0", "Default");
    let withNew!: ReturnType<typeof createSlot>;
    expect(() => {
      withNew = createSlot(container, "Empty"); // default factories (id + paneId)
    }).not.toThrow();
    expect(withNew.slots).toHaveLength(2);
    // Deleting the last slot mints a fresh Default via the default factory.
    expect(() => deleteSlot(wrapAsSingleSlot(emptyWorkspace("p0")), "nope")).not.toThrow();
  });
});

describe("save-as on a nested split — provider effect chain (no crash)", () => {
  it("saveWorkspaceAs after building a nested split keeps the app alive", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });

    // 1 tab left + a right column split (top-right + bottom-right).
    act(() => result.current.openInFocused("nLeft"));
    act(() => result.current.openToSide("nTR"));
    act(() => result.current.splitFocused("column"));
    act(() => result.current.openInFocused("nBR"));
    expect(result.current.leaves.length).toBe(3);

    act(() => result.current.saveWorkspaceAs("Saved")); // the reported crash

    expect(result.current.slots.length).toBe(2);
    expect(result.current.leaves.length).toBe(3);
    expect(result.current.slots.map((s) => s.name)).toContain("Saved");
  });
});
