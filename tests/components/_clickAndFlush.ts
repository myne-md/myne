// Click, then let the click's own async work settle.
//
// `fireEvent.click` inside `act` flushes React's microtask queue and nothing
// else, so a handler that awaits an IPC call and then `setState`s in a `catch`
// has not run by the time the assertion does. The macrotask turn is what lets
// that land, and it is why the rejection is reported as HANDLED rather than
// surfacing as an unhandled rejection that fails an unrelated test later in the
// file.
//
// Three copies of this existed, in three specs about the same component tree,
// each with the same body and (in one case) the same explanatory comment.

import { act, fireEvent } from "@testing-library/react";

export async function clickAndFlush(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
}
