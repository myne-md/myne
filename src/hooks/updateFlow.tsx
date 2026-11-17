// The update flow, reachable from a surface that App cannot hand props to.
//
// `useUpdateAvailable` is mounted ONCE, in `App.tsx`, and it has to be there: the
// confirm locks the vault, which moves the Stage off `editor` and unmounts
// whatever the editor was rendering, so the flow's state has to live above the
// screen that started it. The notice reads that state through props because App
// renders it directly.
//
// The About row cannot: it sits inside the Settings modal, several providers deep.
// Without this context it grew a SECOND install path of its own — flush the panes,
// then call `updateInstall` directly, with no lock and no `updating` stage — and
// that is one half of myne-md/myne#1059: two doors onto one command, an install
// running behind a row whose own state said "working", and a second download on
// top of the first when both were pressed.
//
// So this is not an abstraction for its own sake. It exists so there is ONE flow,
// and a surface that wants to start an update asks the flow rather than the
// command.

import { createContext, useContext, type ReactNode } from "react";
import type { UpdateAvailableHook } from "./useUpdateAvailable";

const UpdateFlowContext = createContext<UpdateAvailableHook | null>(null);

export function UpdateFlowProvider({
  value,
  children,
}: {
  value: UpdateAvailableHook;
  children: ReactNode;
}) {
  return (
    <UpdateFlowContext.Provider value={value}>{children}</UpdateFlowContext.Provider>
  );
}

/**
 * The one update flow, or `null` when there is none.
 *
 * `null` rather than a throw: on a client without the `selfUpdate` capability
 * (web, mobile) there is no flow to find, and a surface that asks from there is
 * asking about an affordance it does not render. A throw would turn that into a
 * crash on a client where the whole feature is absent by design.
 */
export function useUpdateFlow(): UpdateAvailableHook | null {
  return useContext(UpdateFlowContext);
}
