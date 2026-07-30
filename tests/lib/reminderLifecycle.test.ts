// The reminder registration lifecycle (MYND-618 task 8).
//
// The whole point of this module is that ONE entry in the table is surprising —
// locking does not cancel — so the tests exist to make that entry deliberate and
// visible rather than something a reader stumbles on.

import { describe, expect, it } from "vitest";
import {
  cancelsAllOn,
  lifecycleAction,
  reconcilesOn,
  REMINDER_LIFECYCLE_EVENTS,
} from "../../src/lib/reminderLifecycle";

describe("reconciliation runs from every path that can change the set", () => {
  it("unlock, tick, note-save and exit all reconcile", () => {
    for (const event of ["unlock", "tick", "note-save", "exit"] as const) {
      expect(reconcilesOn(event), event).toBe(true);
    }
  });

  it("the pass is the same one everywhere — idempotence makes extra runs free", () => {
    // Four entry points into one pass; the alternative (a different action per
    // path) is how registration sets drift out of step with the vault.
    const actions = new Set(
      (["unlock", "tick", "note-save", "exit"] as const).map(lifecycleAction),
    );
    expect(actions.size).toBe(1);
  });
});

describe("locking does NOT cancel — the written departure", () => {
  it("lock is deliberately a no-op", () => {
    // The teardown rule protects VAULT CONTENT; what the platform holds here is
    // a timestamp and a content-free string (threat-model.md §7).
    expect(lifecycleAction("lock")).toBe("none");
  });

  it("lock is the only event that does nothing at all", () => {
    // Stated as a property so a future "and also do nothing on X" has to argue
    // for itself rather than slipping in beside this one.
    const inert = REMINDER_LIFECYCLE_EVENTS.filter((e) => lifecycleAction(e) === "none");
    expect(inert).toEqual(["lock"]);
  });

  it("lock does not reconcile either — it is not a cheap re-register", () => {
    expect(reconcilesOn("lock")).toBe(false);
  });
});

describe("the three events that clear everything", () => {
  it("setting-off, vault-delete and password-change all cancel all", () => {
    for (const event of ["setting-off", "vault-delete", "password-change"] as const) {
      expect(cancelsAllOn(event), event).toBe(true);
    }
  });

  it("nothing else clears everything", () => {
    const clearing = REMINDER_LIFECYCLE_EVENTS.filter(cancelsAllOn).sort();
    expect(clearing).toEqual(["password-change", "setting-off", "vault-delete"]);
  });
});

describe("completion cancels its own registration", () => {
  it("as its own action, not as a reconciliation", () => {
    // A task the user just ticked must not notify them thirty seconds later
    // because the next tick had not run yet.
    expect(lifecycleAction("task-complete")).toBe("cancel-one");
    expect(reconcilesOn("task-complete")).toBe(false);
  });
});

describe("the table is total", () => {
  it("every event has a decided action", () => {
    for (const event of REMINDER_LIFECYCLE_EVENTS) {
      expect(["reconcile", "cancel-all", "cancel-one", "none"]).toContain(
        lifecycleAction(event),
      );
    }
  });

  it("the event list and the switch agree", () => {
    // The switch ends in a `never` guard, so adding an event without deciding
    // its action fails to compile; this asserts the exported list did not fall
    // behind it.
    expect(REMINDER_LIFECYCLE_EVENTS).toHaveLength(9);
    expect(new Set(REMINDER_LIFECYCLE_EVENTS).size).toBe(REMINDER_LIFECYCLE_EVENTS.length);
  });
});
