// Opaque registration identifiers and the tap latch (MYND-619 task 7).

import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn(async () => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

let hasTauri = true;
vi.mock("../src/lib/app-window", () => ({
  get HAS_TAURI() {
    return hasTauri;
  },
}));

import type { MobileReminderNotifier } from "../src/lib/reminders";
import {
  locatorFor,
  opaqueFor,
  opaqueNotifier,
  resetReminderIdentity,
} from "../src/lib/reminderIdentity";
import {
  clearReminderTap,
  consumeReminderTap,
  handleReminderTap,
  REMINDER_TAP_EVENT,
} from "../src/lib/reminderTap";
import { runBoundedReminderPass } from "../src/lib/reminderPass";
import type { VaultTask } from "@myne/reminder-schedule";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

/** A notifier that behaves like a platform: it remembers, and replaces by id. */
function fakePlatform() {
  const held = new Map<string, string>();
  const notifier: MobileReminderNotifier = {
    listPending: async () => [...held].map(([id, at]) => ({ id, at })),
    schedule: async ({ id, at }) => void held.set(id, at),
    cancel: async (id) => void held.delete(id),
    cancelAll: async () => held.clear(),
  };
  return { held, notifier };
}

const LOCATOR = "myne.reminder.note-abc-123.4";

beforeEach(() => {
  // The node test env has no DOM; a bare EventTarget is enough for the
  // REMINDER_TAP_EVENT dispatch (Node ships CustomEvent globally). Same shape as
  // `deep-link.test.ts`, which covers the sibling latch.
  (globalThis as unknown as { window: EventTarget }).window = new EventTarget();
  resetReminderIdentity();
  clearReminderTap();
  invoke.mockClear();
  hasTauri = true;
});

describe("what reaches the platform is opaque", () => {
  it("is 32 hex characters with no structure at all", () => {
    const opaque = opaqueFor(LOCATOR);
    expect(opaque).toMatch(/^[0-9a-f]{32}$/);
  });

  // The whole point: the locator names a NOTE, and a note identifier in the
  // platform's plaintext store is correlatable metadata (threat-model.md §7).
  it("carries nothing derived from the task", () => {
    const opaque = opaqueFor(LOCATOR);
    // No run of three or more characters from the locator survives — a check
    // that stays meaningful even though a hex string trivially contains "4".
    for (let i = 0; i + 3 <= LOCATOR.length; i++) {
      expect(opaque, `leaks ${LOCATOR.slice(i, i + 3)}`).not.toContain(LOCATOR.slice(i, i + 3));
    }
  });

  it("is stable within a session and different per registration", () => {
    const a = opaqueFor(LOCATOR);
    expect(opaqueFor(LOCATOR)).toBe(a);
    expect(opaqueFor("myne.reminder.other.1")).not.toBe(a);
  });

  it("does not survive a reset — the map is session state, not storage", () => {
    const before = opaqueFor(LOCATOR);
    resetReminderIdentity();
    expect(locatorFor(before)).toBeNull();
    expect(opaqueFor(LOCATOR)).not.toBe(before);
  });
});

describe("the translating notifier", () => {
  it("hands the platform the opaque id and never the locator", async () => {
    const { held, notifier } = fakePlatform();
    await opaqueNotifier(notifier).schedule({ id: LOCATOR, at: "2026-08-02T09:00" });

    expect(held.size).toBe(1);
    const [id] = [...held.keys()];
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify([...held])).not.toContain("note-abc-123");
  });

  it("reports back in locator space, so the pass never learns about the swap", async () => {
    const { notifier } = fakePlatform();
    const wrapped = opaqueNotifier(notifier);
    await wrapped.schedule({ id: LOCATOR, at: "2026-08-02T09:00" });

    expect(await wrapped.listPending()).toEqual([{ id: LOCATOR, at: "2026-08-02T09:00" }]);
  });

  it("withdraws by locator", async () => {
    const { held, notifier } = fakePlatform();
    const wrapped = opaqueNotifier(notifier);
    await wrapped.schedule({ id: LOCATOR, at: "2026-08-02T09:00" });
    await wrapped.cancel(LOCATOR);

    expect(held.size).toBe(0);
  });

  // A registration left behind by a previous run of the app: this session never
  // minted its id and cannot name it. It must still be withdrawable, or it would
  // sit in the platform store forever.
  it("passes an unattributable identifier through unchanged, so it can be cleared", async () => {
    const { held, notifier } = fakePlatform();
    held.set("deadbeefdeadbeefdeadbeefdeadbeef", "2026-08-02T09:00");
    const wrapped = opaqueNotifier(notifier);

    expect(await wrapped.listPending()).toEqual([
      { id: "deadbeefdeadbeefdeadbeefdeadbeef", at: "2026-08-02T09:00" },
    ]);
    await wrapped.cancel("deadbeefdeadbeefdeadbeefdeadbeef");
    expect(held.size).toBe(0);
  });

  it("forgets everything on cancel-all", async () => {
    const { held, notifier } = fakePlatform();
    const wrapped = opaqueNotifier(notifier);
    await wrapped.schedule({ id: LOCATOR, at: "2026-08-02T09:00" });
    const opaque = [...held.keys()][0]!;

    await wrapped.cancelAll();

    expect(held.size).toBe(0);
    expect(locatorFor(opaque)).toBeNull();
  });
});

describe("the pass keeps working through the translation", () => {
  const task = (noteId: string, lineIndex: number, remind: string): VaultTask => ({
    noteId,
    noteTitle: null,
    noteFolder: null,
    lineIndex,
    rawLine: `- [ ] x [remind:: ${remind}]`,
    completed: false,
    oversized: false,
    remind,
  });
  const NOW = new Date(2026, 7, 1, 8, 0);
  const clock = () => NOW;

  it("is still a no-op the second time", async () => {
    const { held, notifier } = fakePlatform();
    const wrapped = opaqueNotifier(notifier);
    const tasks = [task("n1", 1, "2026-08-02T09:00"), task("n2", 1, "2026-08-03T09:00")];

    await runBoundedReminderPass({ tasks, notifier: wrapped, clock, max: 10 });
    const first = [...held.keys()].sort();
    const second = await runBoundedReminderPass({ tasks, notifier: wrapped, clock, max: 10 });

    expect(second).toEqual({ scheduled: 0, cancelled: 0, failed: 0 });
    expect([...held.keys()].sort()).toEqual(first);
  });

  // The documented cost of a memory-only map: a new session cannot name what the
  // last one registered, so the pass clears and re-registers. Self-healing, but
  // it should be a *known* cost rather than a surprise.
  it("replaces a previous session's registrations rather than leaving them", async () => {
    const { held, notifier } = fakePlatform();
    const tasks = [task("n1", 1, "2026-08-02T09:00")];

    await runBoundedReminderPass({
      tasks,
      notifier: opaqueNotifier(notifier),
      clock,
      max: 10,
    });
    const previousSession = [...held.keys()];

    // The app restarts: the map is gone, the platform's registrations are not.
    resetReminderIdentity();
    const result = await runBoundedReminderPass({
      tasks,
      notifier: opaqueNotifier(notifier),
      clock,
      max: 10,
    });

    expect(result).toEqual({ scheduled: 1, cancelled: 1, failed: 0 });
    expect(held.size).toBe(1);
    expect([...held.keys()]).not.toEqual(previousSession);
  });
});

describe("the tap latch", () => {
  it("is consumed exactly once", () => {
    handleReminderTap("abc");
    expect(consumeReminderTap()).toBe("abc");
    // Two surfaces both acting on one tap would navigate twice, and the second
    // navigation is the one the user did not ask for.
    expect(consumeReminderTap()).toBeNull();
  });

  it("announces a tap that arrives while something is listening", () => {
    const seen: string[] = [];
    const target = (globalThis as unknown as { window: EventTarget }).window;
    const listener = (e: Event) => seen.push((e as CustomEvent<{ id: string }>).detail.id);
    target.addEventListener(REMINDER_TAP_EVENT, listener);
    handleReminderTap("abc");
    target.removeEventListener(REMINDER_TAP_EVENT, listener);
    expect(seen).toEqual(["abc"]);
  });

  it("keeps the most recent tap when two arrive before either is consumed", () => {
    handleReminderTap("first");
    handleReminderTap("second");
    expect(consumeReminderTap()).toBe("second");
  });

  // A malformed delivery must not occupy the latch and block the real one behind
  // it.
  it("ignores anything that is not a non-empty string", () => {
    for (const bad of [undefined, null, "", 7, {}, []]) {
      handleReminderTap(bad);
      expect(consumeReminderTap()).toBeNull();
    }
  });

  it("can be discarded without acting on it", () => {
    handleReminderTap("abc");
    clearReminderTap();
    expect(consumeReminderTap()).toBeNull();
  });
});

describe("nothing about a tap touches disk", () => {
  const sources = [
    "../src/lib/reminderTap.ts",
    "../src/lib/reminderIdentity.ts",
  ];

  // The latch is memory-only, and so is the identifier map. Persisting either
  // would put an OS-visible identifier next to a note identifier in plaintext —
  // the exact pairing this task exists to prevent.
  it("uses no storage API anywhere", () => {
    for (const path of sources) {
      const source = read(path);
      for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "writeTextFile", "plugin:fs"]) {
        expect(source, `${path} must not use ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("holds the latch in a module-level variable, not in a queue", () => {
    const source = read("../src/lib/reminderTap.ts");
    expect(source).toContain("let latched: string | null = null;");
    expect(source).not.toContain("push(");
  });
});

describe("the native halves deliver only the identifier", () => {
  const strip = (s: string) =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s\/\/.*$/gm, "");

  it("Android sends { id } and clears the extra so a tap cannot replay", () => {
    const kotlin = strip(
      read("../src-tauri/tauri-plugin-reminders/android/src/main/java/RemindersPlugin.kt"),
    );
    const puts = [...kotlin.matchAll(/payload\.put\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(puts).toEqual(['"id", id']);
    // Android hands the same intent back on every resume; without this the same
    // tap would navigate the user somewhere a second time.
    expect(kotlin).toContain("intent.removeExtra(ReminderReceiver.EXTRA_ID)");
  });

  it("iOS sends the request identifier and nothing from the notification", () => {
    const swift = strip(
      read(
        "../src-tauri/tauri-plugin-reminders/ios/Sources/RemindersPlugin/RemindersPlugin.swift",
      ),
    );
    expect(swift).toContain("let id = response.notification.request.identifier");
    const payloads = [...swift.matchAll(/let payload: JsonObject = (.+)/g)].map((m) => m[1].trim());
    expect(payloads).toEqual(['["id": id]']);
    // Nothing may be read out of the notification's content.
    expect(swift).not.toContain("response.notification.request.content");
  });

  // Setting a delegate is what makes taps arrive; implementing `willPresent` is
  // what would ALSO opt the app into foreground presentation, producing a second
  // notification for one reminder once the in-app layer lands.
  it("iOS sets a delegate for taps without opting into foreground presentation", () => {
    const swift = strip(
      read(
        "../src-tauri/tauri-plugin-reminders/ios/Sources/RemindersPlugin/RemindersPlugin.swift",
      ),
    );
    expect(swift).toContain("center.delegate = self");
    expect(swift).toContain("didReceive response: UNNotificationResponse");
    expect(swift).not.toContain("willPresent");
  });

  // Reachable from the Rust backend only — never from the WebView, so it carries
  // no ACL surface (the deep-link `setEventHandler` precedent).
  it("the tap handler is not a WebView-facing command", () => {
    expect(read("../src-tauri/tauri-plugin-reminders/build.rs")).not.toContain("set_tap_handler");
    expect(
      read("../src-tauri/tauri-plugin-reminders/permissions/default.toml"),
    ).not.toContain("tap");
  });
});

// Where a tapped reminder lands (MYND-620 task 7). The notification side is
// MYND-619's; this is the receiving half, and the split is the reason the two
// features were separated at all.
describe("the tap landing", () => {
  const task = (noteId: string, lineIndex: number | null): VaultTask => ({
    noteId,
    noteTitle: "A note",
    noteFolder: null,
    lineIndex,
    rawLine: "- [ ] x",
    completed: false,
    oversized: false,
  });

  it("resolves a latched identifier to its task", async () => {
    const { resolveReminderTap } = await import("../src/lib/reminderLanding");
    const { reminderId } = await import("@myne/reminder-schedule");
    const target = task("n1", 3);
    const opaque = opaqueFor(reminderId(target));

    expect(resolveReminderTap(opaque, [task("n0", 1), target])).toEqual({
      kind: "task",
      task: target,
    });
  });

  it("resolves a note-task, which has no line", async () => {
    const { resolveReminderTap } = await import("../src/lib/reminderLanding");
    const { reminderId } = await import("@myne/reminder-schedule");
    const target = task("n2", null);
    const opaque = opaqueFor(reminderId(target));

    expect(resolveReminderTap(opaque, [target])).toEqual({ kind: "task", task: target });
  });

  it("reports nothing when nothing was tapped", async () => {
    const { resolveReminderTap } = await import("../src/lib/reminderLanding");
    expect(resolveReminderTap(null, [task("n1", 3)])).toEqual({ kind: "none" });
  });

  // The task was completed and removed, deleted, or moved to another line. An
  // error about an identifier the user never saw would be worse than the list.
  it("degrades to unresolved when the task is gone", async () => {
    const { resolveReminderTap } = await import("../src/lib/reminderLanding");
    const { reminderId } = await import("@myne/reminder-schedule");
    const opaque = opaqueFor(reminderId(task("n1", 3)));

    expect(resolveReminderTap(opaque, [])).toEqual({ kind: "unresolved" });
  });

  // The documented cold-start limit: the opaque→locator map is memory-only by
  // design, so a session that did not register the reminder cannot name it.
  it("degrades to unresolved after a cold start", async () => {
    const { resolveReminderTap } = await import("../src/lib/reminderLanding");
    const { reminderId } = await import("@myne/reminder-schedule");
    const target = task("n1", 3);
    const opaque = opaqueFor(reminderId(target));

    resetReminderIdentity(); // the app restarted

    expect(resolveReminderTap(opaque, [target])).toEqual({ kind: "unresolved" });
  });

  // Consuming is unconditional. A latch that survived a failed resolution would
  // fire again on the next unlock and navigate the user a second time.
  it("consumes the latch exactly once, resolvable or not", async () => {
    const { takeReminderLanding } = await import("../src/lib/reminderLanding");
    handleReminderTap("an identifier this session never minted");

    expect(takeReminderLanding([])).toEqual({ kind: "unresolved" });
    expect(takeReminderLanding([])).toEqual({ kind: "none" });
  });

  it("never parses the locator — it asks the shared generator", () => {
    const source = read("../src/lib/reminderLanding.ts");
    expect(source).toContain('from "@myne/reminder-schedule"');
    expect(source).toContain("reminderId(candidate) === locator");
    // A second implementation of a format the generator owns would drift the
    // first time a task gained a new kind of location.
    for (const forbidden of ["split(", "myne.reminder.", "slice(", "match("]) {
      expect(source, `must not parse the locator: ${forbidden}`).not.toContain(forbidden);
    }
  });
});
