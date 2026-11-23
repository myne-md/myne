// The desktop OS-tier notifier (myne-md/myne#1076, task 23 of the 0.19 block).
//
// Three things are worth testing here and nothing else is. That the payload on the
// wire is the two-field registration and cannot grow a third field, because the
// platform's store is plaintext outside the AEAD envelope. That a refusal SURFACES
// as a failed operation the pass can count, rather than being swallowed into a
// silent no-op. And that cancellation is the same call shape as registration, so the
// reconciliation diff can withdraw what it no longer wants.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]) => undefined as unknown);
// The specifier is resolved from THIS file, so it names the module the source
// file reaches (`../../src/platform/core`), not a path relative to it.
vi.mock("../../src/platform/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { createOsNotifier, ReminderRefusal } from "../../src/lib/reminderOsNotifier";
import { runReminderPass, type VaultTask } from "../../src/lib/reminderSchedule";

const clock = () => new Date("2026-11-22T08:00");

function task(id: string, remind: string): VaultTask {
  return {
    noteId: id,
    lineIndex: 0,
    text: `task ${id}`,
    completed: false,
    remind,
  } as unknown as VaultTask;
}

beforeEach(() => {
  invoke.mockClear();
  invoke.mockImplementation(async () => undefined);
});

describe("the OS notifier is the same seam, with the platform behind it", () => {
  it("registers a two-field payload and nothing more", async () => {
    const notifier = createOsNotifier();
    await notifier.schedule({ id: "myne.reminder.abc.0", at: "2026-11-22T09:00" });

    expect(invoke).toHaveBeenCalledWith("reminders_schedule", {
      reminder: { id: "myne.reminder.abc.0", at: "2026-11-22T09:00" },
    });
    const [, args] = invoke.mock.calls[0] as [string, { reminder: Record<string, unknown> }];
    // The threat-model posture as an assertion: a third field would be a third
    // thing written into the platform's plaintext store.
    expect(Object.keys(args.reminder).sort()).toEqual(["at", "id"]);
  });

  it("lists and cancels through the plugin's own command names", async () => {
    invoke.mockImplementation(async (command: unknown) =>
      command === "reminders_list_pending"
        ? [{ id: "myne.reminder.a.0", at: "" }]
        : undefined,
    );
    const notifier = createOsNotifier();

    const pending = await notifier.listPending();
    expect(pending.map((row) => row.id)).toEqual(["myne.reminder.a.0"]);

    await notifier.cancel("myne.reminder.a.0");
    expect(invoke).toHaveBeenCalledWith("reminders_cancel", { id: "myne.reminder.a.0" });
  });

  it("a refusal surfaces as a failed operation and keeps its kind", async () => {
    // A revoked permission must not read as "nothing to do": the pass counts it and
    // the settings surface explains it, and both need the host's own kind.
    invoke.mockImplementation(async () => {
      throw { kind: "refused", reason: "add_failed" };
    });
    const notifier = createOsNotifier();

    const result = await runReminderPass([task("a", "2026-11-22T09:00")], notifier, clock);

    expect(result.failed).toBeGreaterThan(0);
    expect(notifier.lastRefusal()).toBeInstanceOf(ReminderRefusal);
    expect(notifier.lastRefusal()?.kind).toBe("refused");
  });

  it("an unrecognised throw is classified rather than rethrown raw", async () => {
    // A missing capability arrives as a plain string or an Error, not as a `kind`.
    // The pass must never see an unclassified throw, so it becomes `refused`.
    invoke.mockImplementation(async () => {
      throw new Error("plugin reminders not found");
    });
    const notifier = createOsNotifier();

    await expect(notifier.schedule({ id: "x", at: "2026-11-22T09:00" })).rejects.toBeInstanceOf(
      ReminderRefusal,
    );
    expect(notifier.lastRefusal()?.kind).toBe("refused");
  });

  it("permission is readable and requestable through the same adapter", async () => {
    invoke.mockImplementation(async (command: unknown) =>
      command === "reminders_permission_status" ? "not_determined" : "authorized",
    );
    const notifier = createOsNotifier();

    expect(await notifier.permissionStatus()).toBe("not_determined");
    expect(await notifier.requestPermission()).toBe("authorized");
  });
});
