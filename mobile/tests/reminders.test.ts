// Reads the backend's own registration sites from disk (see the last describe):
// nothing else in this repo checks that the command names this module sends
// match the ones the plugin declares and the ACL grants. `tests/` sits outside
// `tsc`'s `include: ["src"]`, so the node builtins here are untyped by design —
// adding `@types/node` would be a new dependency for an editor squiggle.
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri IPC bridge so we can assert the exact command name + arg shape
// each wrapper sends — this pins the WebView↔Rust contract against the plugin's
// registered commands (build.rs / permissions / capabilities), which nothing
// else in this repo checks until a device build fails at runtime.
const invoke = vi.fn(async () => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

// `HAS_TAURI` is a module-load constant, so it is mocked through a getter: the
// host-present and host-absent branches are both real behaviour and both need
// covering in one file.
let hasTauri = true;
vi.mock("../src/lib/app-window", () => ({
  get HAS_TAURI() {
    return hasTauri;
  },
}));

import {
  createExactAlarmApi,
  createRawReminderNotifier,
  createReminderNotifier,
  createReminderPermissionApi,
  InvalidReminder,
} from "../src/lib/reminders";

const sib = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(sib(p), "utf8");

beforeEach(() => {
  invoke.mockClear();
  hasTauri = true;
});

describe("reminder notifier — the WebView↔plugin contract", () => {
  it("schedule → plugin:reminders|schedule { reminder: { id, at } }", async () => {
    await createRawReminderNotifier().schedule({ id: "r-1", at: "2026-08-01T09:00" });
    expect(invoke).toHaveBeenCalledWith("plugin:reminders|schedule", {
      reminder: { id: "r-1", at: "2026-08-01T09:00" },
    });
  });

  it("cancel → plugin:reminders|cancel { id }", async () => {
    await createRawReminderNotifier().cancel("r-1");
    expect(invoke).toHaveBeenCalledWith("plugin:reminders|cancel", { id: "r-1" });
  });

  it("cancelAll → plugin:reminders|cancel_all", async () => {
    await createReminderNotifier().cancelAll();
    expect(invoke).toHaveBeenCalledWith("plugin:reminders|cancel_all");
  });

  it("listPending → plugin:reminders|list_pending, mapped to { id, at }", async () => {
    invoke.mockResolvedValueOnce([{ id: "r-1", at: "2026-08-01T09:00" }]);
    const pending = await createReminderNotifier().listPending();
    expect(invoke).toHaveBeenCalledWith("plugin:reminders|list_pending");
    expect(pending).toEqual([{ id: "r-1", at: "2026-08-01T09:00" }]);
  });
});

describe("what actually crosses into OS-owned plaintext", () => {
  // The registration lands in the platform's own persistence and can surface on
  // a locked screen (threat-model.md §7), so the argument shape is a privacy
  // property. Asserted as the whole key set — a laxer check would pass a future
  // `title`/`body`/`noteId` field straight through.
  it("a registration carries nothing but an opaque id and a local instant", async () => {
    await createRawReminderNotifier().schedule({ id: "r-1", at: "2026-08-01T09:00" });
    const [, args] = invoke.mock.calls[0] as unknown as [
      string,
      { reminder: Record<string, unknown> },
    ];
    expect(Object.keys(args)).toEqual(["reminder"]);
    expect(Object.keys(args.reminder).sort()).toEqual(["at", "id"]);
  });

  // Extra properties on the caller's payload must not ride along: the caller is
  // the reconciliation core, and a future field added there for its own use
  // would otherwise silently become OS-visible metadata.
  it("an unexpected field on the payload is not forwarded", async () => {
    const payload = { id: "r-1", at: "2026-08-01T09:00", noteId: "secret-note" };
    await createRawReminderNotifier().schedule(payload);
    const [, args] = invoke.mock.calls[0] as unknown as [
      string,
      { reminder: Record<string, unknown> },
    ];
    expect(args.reminder).not.toHaveProperty("noteId");
    expect(JSON.stringify(args)).not.toContain("secret-note");
  });
});

describe("instants are local wall-clock, and nothing else is accepted", () => {
  // A zone-carrying or over-precise instant reaching the native side is a silent
  // no-fire or a silently shifted hour. Refusing here is what turns that into a
  // counted failure the next pass retries.
  const rejected = [
    "2026-08-01T09:00:00Z",
    "2026-08-01T09:00+03:00",
    "2026-08-01T09:00:00",
    "2026-08-01",
    "2026-8-1T9:00",
    "",
  ];

  for (const at of rejected) {
    it(`refuses ${JSON.stringify(at)} and never reaches the platform`, async () => {
      await expect(createRawReminderNotifier().schedule({ id: "r-1", at })).rejects.toBeInstanceOf(
        InvalidReminder,
      );
      expect(invoke).not.toHaveBeenCalled();
    });
  }

  it("accepts a bare local YYYY-MM-DDTHH:MM", async () => {
    await createRawReminderNotifier().schedule({ id: "r-1", at: "2026-12-31T23:59" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty id — an unaddressable registration can never be cancelled", async () => {
    await expect(
      createRawReminderNotifier().schedule({ id: "", at: "2026-08-01T09:00" }),
    ).rejects.toBeInstanceOf(InvalidReminder);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("what the platform reports back is not trusted blindly", () => {
  // One malformed row would otherwise produce a cancel for an id the OS does not
  // hold — on every pass, forever, because the target set never matches it.
  it("drops rows that are not { id, at }", async () => {
    invoke.mockResolvedValueOnce([
      { id: "r-1", at: "2026-08-01T09:00" },
      { id: 7, at: "2026-08-01T09:00" },
      { id: "r-3" },
      null,
      "r-4",
    ]);
    expect(await createReminderNotifier().listPending()).toEqual([
      { id: "r-1", at: "2026-08-01T09:00" },
    ]);
  });

  it("treats a non-array answer as an empty set", async () => {
    invoke.mockResolvedValueOnce({ pending: "nope" });
    expect(await createReminderNotifier().listPending()).toEqual([]);
  });
});

describe("without a Tauri host", () => {
  // Browser dev and the flow-test tier run the same code. Inert beats broken —
  // but inert must not mean "pretend it worked": listPending reports an empty
  // set, so the reconciliation pass never believes a registration exists.
  it("is inert rather than broken", async () => {
    hasTauri = false;
    const notifier = createReminderNotifier();
    expect(await notifier.listPending()).toEqual([]);
    await notifier.schedule({ id: "r-1", at: "2026-08-01T09:00" });
    await notifier.cancel("r-1");
    await notifier.cancelAll();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("still refuses a malformed instant — validation is not host-gated", async () => {
    hasTauri = false;
    await expect(
      createRawReminderNotifier().schedule({ id: "r-1", at: "2026-08-01T09:00:00Z" }),
    ).rejects.toBeInstanceOf(InvalidReminder);
  });
});

describe("the seam agrees with the desktop and with the backend", () => {
  // The desktop `ReminderNotifier` is the interface this adapter implements —
  // since task 5 it is IMPORTED (`@myne/reminder-schedule`), so a renamed member
  // is already a compile error. This test stays because a type says nothing about
  // what the object actually carries at runtime: it reads the desktop
  // declaration and checks the real object against it.
  it("implements every member of the desktop ReminderNotifier", () => {
    const source = read("../../src/lib/reminderSchedule.ts");
    const block = /export type ReminderNotifier = \{([\s\S]*?)\n\};/.exec(source);
    expect(block, "desktop ReminderNotifier declaration not found").not.toBeNull();

    const members = [...(block as RegExpExecArray)[1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(members.length).toBeGreaterThan(0);

    const notifier = createReminderNotifier() as unknown as Record<string, unknown>;
    for (const member of members) {
      expect(typeof notifier[member], `missing notifier member: ${member}`).toBe("function");
    }
    // The mobile surface is the desktop's plus exactly one addition — the
    // wholesale drop the lifecycle table needs for setting-off, vault-delete and
    // password-change.
    expect(Object.keys(notifier).sort()).toEqual([...members, "cancelAll"].sort());
  });

  // A command invoked from here but absent from the plugin's COMMANDS list is
  // not a build error anywhere: `cargo build` is green, and the failure only
  // appears as a denied invoke at runtime on a device. Pin all three registration
  // sites against the names this module actually sends.
  it("invokes exactly the commands the plugin declares and the ACL grants", async () => {
    const notifier = createReminderNotifier();
    const permission = createReminderPermissionApi();
    invoke.mockResolvedValueOnce([]);
    await notifier.listPending();
    await notifier.schedule({ id: "r-1", at: "2026-08-01T09:00" });
    await notifier.cancel("r-1");
    await notifier.cancelAll();
    await permission.status();
    await permission.request();
    const exactness = createExactAlarmApi();
    await exactness.status();
    await exactness.request();

    const invoked = invoke.mock.calls
      .map((call) => String(call[0]).replace("plugin:reminders|", ""))
      .sort();

    const buildRs = read("../src-tauri/tauri-plugin-reminders/build.rs");
    const commandsLine = /const COMMANDS: &\[&str\] = &\[([^\]]*)\];/.exec(buildRs);
    expect(commandsLine, "plugin build.rs COMMANDS list not found").not.toBeNull();
    const declared = [...(commandsLine as RegExpExecArray)[1].matchAll(/"([a-z_]+)"/g)]
      .map((m) => m[1])
      .sort();

    const defaultToml = read("../src-tauri/tauri-plugin-reminders/permissions/default.toml");
    const granted = [...defaultToml.matchAll(/"allow-([a-z-]+)"/g)]
      .map((m) => m[1].replace(/-/g, "_"))
      .sort();

    expect(declared).toEqual(invoked);
    expect(granted).toEqual(invoked);
  });

  // The capability file is the fourth site, and the one whose omission fails
  // closed at runtime with a permission error rather than at build time.
  it("is granted in the mobile capability set", () => {
    const capability = read("../src-tauri/capabilities/default.json");
    expect(JSON.parse(capability).permissions).toContain("reminders:default");
  });

  // Same discipline as the notifier: the permission surface is the desktop's,
  // restated until MYND-620 task 2 decides where shared logic lives, and pinned
  // by reading the desktop declaration rather than by a comment.
  it("implements the desktop ReminderPermissionApi and its four states", () => {
    const source = read("../../src/lib/reminderPermission.ts");

    const apiBlock = /export type ReminderPermissionApi = \{([\s\S]*?)\n\};/.exec(source);
    expect(apiBlock, "desktop ReminderPermissionApi declaration not found").not.toBeNull();
    const members = [...(apiBlock as RegExpExecArray)[1].matchAll(/^\s{2}(\w+):/gm)].map(
      (m) => m[1],
    );
    const api = createReminderPermissionApi() as unknown as Record<string, unknown>;
    expect(Object.keys(api).sort()).toEqual([...members].sort());

    // The state vocabulary has to agree too — mobile answering a fifth state
    // would fall through the desktop flow's branches into `denied`.
    const stateLine = /export type ReminderPermission =\s*([^;]+);/.exec(source);
    expect(stateLine, "desktop ReminderPermission union not found").not.toBeNull();
    const states = [...(stateLine as RegExpExecArray)[1].matchAll(/"([a-z-]+)"/g)].map(
      (m) => m[1],
    );
    expect(states.sort()).toEqual(["denied", "granted", "not-determined", "unavailable"]);
  });
});

describe("the notification permission surface", () => {
  it("status → plugin:reminders|permission_status", async () => {
    invoke.mockResolvedValueOnce("granted");
    expect(await createReminderPermissionApi().status()).toBe("granted");
    expect(invoke).toHaveBeenCalledWith("plugin:reminders|permission_status");
  });

  it("request → plugin:reminders|request_permission", async () => {
    invoke.mockResolvedValueOnce("denied");
    expect(await createReminderPermissionApi().request()).toBe("denied");
    expect(invoke).toHaveBeenCalledWith("plugin:reminders|request_permission");
  });

  // A false "granted" is the only answer that actually misleads: the app would
  // schedule, believe it had asked, and never fire. Anything unrecognised —
  // including a platform that answers nothing at all — reads as unavailable.
  for (const answer of [undefined, null, "", "GRANTED", "authorized", 1, {}]) {
    it(`maps ${JSON.stringify(answer) ?? "undefined"} to unavailable, never granted`, async () => {
      invoke.mockResolvedValueOnce(answer);
      expect(await createReminderPermissionApi().status()).toBe("unavailable");
    });
  }

  it("reports unavailable without a Tauri host", async () => {
    hasTauri = false;
    const api = createReminderPermissionApi();
    expect(await api.status()).toBe("unavailable");
    expect(await api.request()).toBe("unavailable");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("Android precise delivery", () => {
  it("status → plugin:reminders|exact_alarm_status", async () => {
    invoke.mockResolvedValueOnce("exact");
    expect(await createExactAlarmApi().status()).toBe("exact");
    expect(invoke).toHaveBeenCalledWith("plugin:reminders|exact_alarm_status");
  });

  it("request → plugin:reminders|request_exact_alarm", async () => {
    await createExactAlarmApi().request();
    expect(invoke).toHaveBeenCalledWith("plugin:reminders|request_exact_alarm");
  });

  // Showing the caveat when it was not needed is a smaller failure than a
  // reminder quietly arriving late after the app implied it would not.
  for (const answer of [undefined, null, "", "EXACT", "precise", 1]) {
    it(`maps ${JSON.stringify(answer) ?? "undefined"} to approximate, never exact`, async () => {
      invoke.mockResolvedValueOnce(answer);
      expect(await createExactAlarmApi().status()).toBe("approximate");
    });
  }

  // Without a host there is no platform to be imprecise about, and claiming
  // "approximate" would put a caveat on a screen with no reason for one.
  it("is not-applicable without a Tauri host, and asks for nothing", async () => {
    hasTauri = false;
    const api = createExactAlarmApi();
    expect(await api.status()).toBe("not-applicable");
    await api.request();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("the precise-delivery surface says what it does, and only when it applies", () => {
  const component = () => read("../src/components/ReminderSettings.tsx");

  // The same discipline as the desktop's three reminder sentences: the wording
  // is a promise about behaviour, so it is a constant rendered verbatim rather
  // than a translated label, and it is pinned by FULL-literal equality — a
  // substring match would pass a future softening.
  it("states the fallback in a load-bearing constant, unsoftened", async () => {
    const { REMINDER_APPROXIMATE_DELIVERY_SENTENCE } = await import(
      "../src/lib/load-bearing-copy"
    );
    expect(REMINDER_APPROXIMATE_DELIVERY_SENTENCE).toBe(
      "Android batches wake-ups to save battery, so reminders arrive around the time you set rather than exactly on it. Allowing exact timing removes the delay.",
    );
    // Rendered as the constant, never retyped into JSX where it could drift.
    expect(component()).toContain("{REMINDER_APPROXIMATE_DELIVERY_SENTENCE}");
    // The honesty rule is "state it", not "warn about it".
    expect(REMINDER_APPROXIMATE_DELIVERY_SENTENCE).not.toMatch(/warning|error|broken|fail/i);
  });

  it("renders nothing where the permission does not exist", () => {
    expect(component()).toContain('if (status === null || status === "not-applicable") return null;');
  });

  // `request()` opens a settings SCREEN, not a one-shot dialog, so there is no
  // prompt to spend — which is why there is no "already asked" bookkeeping here
  // and why nothing can re-prompt. The app never opens it on its own.
  it("opens the platform screen only from a tap, and keeps no ask-once state", () => {
    const source = component();
    const requests = [...source.matchAll(/surface\.request\(\)/g)].length;
    expect(requests).toBe(1);
    expect(source).toContain("onClick={() => void request()}");
    for (const forbidden of ["alreadyAsked", "markAsked", "hasAsked", "localStorage"]) {
      expect(source, `no re-prompt bookkeeping: ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// The iOS half is committed source that nothing in this repo can compile: there
// is no Xcode project here and no Swift test runner. Its privacy-critical
// constraints are therefore asserted STRUCTURALLY against the source — the same
// discipline the desktop scheduling core used ("the module contains no
// `new Date()`"). This is not a substitute for the device checklist; it is the
// gate that catches a later edit quietly reintroducing what was ruled out.
describe("iOS adapter — the constraints that cannot be compiled here", () => {
  const swift = () =>
    read("../src-tauri/tauri-plugin-reminders/ios/Sources/RemindersPlugin/RemindersPlugin.swift");

  // Comments are stripped before the "must not contain" checks: that file
  // NAMES what it refuses (`registerForRemoteNotifications`, `DateFormatter`,
  // `removeAllPendingNotificationRequests`) so a reader learns why, and a test
  // that failed on the explanation would push the reasoning out of the code.
  const swiftCode = () =>
    swift()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s\/\/.*$/gm, "");

  it("involves no push service, no push token and no background refresh", () => {
    const source = swiftCode();
    for (const forbidden of [
      "registerForRemoteNotifications",
      "deviceToken",
      "BGTaskScheduler",
      "BGAppRefreshTask",
      "setMinimumBackgroundFetchInterval",
      "UIBackgroundModes",
      "apns",
    ]) {
      expect(source, `iOS adapter must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("uses no repeating trigger", () => {
    const source = swiftCode();
    expect(source).toContain("repeats: false");
    expect(source).not.toContain("repeats: true");
    expect(source).not.toContain("UNTimeIntervalNotificationTrigger");
  });

  it("never asks for a badge — the badge count IS the pending-reminder count", () => {
    const source = swiftCode();
    const options = /requestAuthorization\(options: \[([^\]]*)\]/.exec(source);
    expect(options, "requestAuthorization options not found").not.toBeNull();
    expect((options as RegExpExecArray)[1]).toBe(".alert, .sound");
  });

  it("assigns the body only from the content-free constant, with no interpolation", () => {
    const source = swiftCode();
    const assignments = [...source.matchAll(/content\.body\s*=\s*(.+)/g)].map((m) => m[1].trim());
    expect(assignments).toEqual(["RemindersPlugin.contentFreeBody"]);

    const literal = /static let contentFreeBody = ("(?:[^"\\]|\\.)*")/.exec(source);
    expect(literal, "contentFreeBody literal not found").not.toBeNull();
    expect((literal as RegExpExecArray)[1]).not.toContain("\\(");
  });

  it("carries an empty userInfo — the tap path reads the request identifier", () => {
    const source = swiftCode();
    const assignments = [...source.matchAll(/content\.userInfo\s*=\s*(.+)/g)].map((m) =>
      m[1].trim(),
    );
    expect(assignments).toEqual(["[:]"]);
  });

  // The reconciliation pass cancels whatever `listPending` reports that its
  // target set does not contain. An unfiltered listing would therefore make this
  // plugin delete another subsystem's notifications; an unfiltered cancel-all
  // would do it wholesale.
  it("filters both listing and cancel-all by its own ownership tag", () => {
    const source = swiftCode();
    expect(source).not.toContain("removeAllPendingNotificationRequests");
    expect(
      [...source.matchAll(/categoryIdentifier == RemindersPlugin\.ownershipTag/g)].length,
    ).toBe(2);
  });

  // Local wall-clock means local wall-clock: a formatter carries a locale and a
  // calendar, and a non-Gregorian device calendar would silently shift the hour.
  it("does no timezone or locale-dependent date work", () => {
    const source = swiftCode();
    for (const forbidden of ["DateFormatter", "ISO8601", "timeZone", "TimeZone"]) {
      expect(source, `iOS adapter must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// The app-level half of "no push service": a background mode or an APNs
// entitlement in the plist would enable one regardless of what the Swift says.
describe("the app declares no push or background capability", () => {
  it("Info.ios.plist carries no background mode and no APNs environment", () => {
    const plist = read("../src-tauri/Info.ios.plist");
    for (const forbidden of ["UIBackgroundModes", "aps-environment", "remote-notification"]) {
      expect(plist, `Info.ios.plist must not declare ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// The Android half, under the same reasoning as the iOS block above: no gradle
// and no Kotlin compiler exist here, so the constraints that rule the design are
// asserted against the source. They check constraints, never behaviour.
describe("Android adapter — the constraints that cannot be compiled here", () => {
  const KOTLIN = "../src-tauri/tauri-plugin-reminders/android/src/main/java";
  const kotlin = (name: string) => read(`${KOTLIN}/${name}`);
  const kotlinCode = (name: string) =>
    kotlin(name)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s\/\/.*$/gm, "");
  const KOTLIN_SOURCES = [
    "RemindersPlugin.kt",
    "ReminderAlarms.kt",
    "ReminderReceiver.kt",
    "ReminderStore.kt",
    "BootReceiver.kt",
  ];
  const allKotlinCode = () => KOTLIN_SOURCES.map(kotlinCode).join("\n");

  it("uses no background work scheduler and no push service", () => {
    const source = allKotlinCode();
    for (const forbidden of [
      "WorkManager",
      "androidx.work",
      "JobScheduler",
      "JobService",
      "FirebaseMessaging",
      "FirebaseInstanceId",
      "com.google.firebase",
    ]) {
      expect(source, `Android adapter must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("uses no repeating alarm, and carries both delivery tiers", () => {
    const source = allKotlinCode();
    expect(source).not.toContain("setRepeating");
    expect(source).not.toContain("setInexactRepeating");
    // Exact when the permission is held, approximate — the stated default —
    // when it is not.
    expect(source).toContain("setExactAndAllowWhileIdle");
    expect(source).toContain("setAndAllowWhileIdle");
  });

  it("makes every PendingIntent immutable", () => {
    const source = allKotlinCode();
    expect(source).not.toContain("FLAG_MUTABLE");
    // The alarm intent and the tap intent; a third call site without the flag
    // would hand the platform a rewritable intent. The floor of 2 is what stops
    // this passing vacuously if the regex ever stops matching.
    const sites = [...source.matchAll(/PendingIntent\.get\w+\(/g)].length;
    expect(sites).toBeGreaterThanOrEqual(2);
    expect([...source.matchAll(/FLAG_IMMUTABLE/g)].length).toBe(sites);
  });

  // `Calendar.getInstance()` returns the DEFAULT LOCALE's calendar, which on a
  // Thai or Japanese-imperial locale is not Gregorian: `set(2026, …)` would then
  // mean Buddhist year 2026 and the reminder would land centuries away.
  it("does no locale-dependent calendar work", () => {
    const source = allKotlinCode();
    expect(source).not.toContain("Calendar.getInstance");
    expect(source).not.toContain("SimpleDateFormat");
    expect(source).toContain("GregorianCalendar(TimeZone.getDefault(), Locale.ROOT)");
  });

  it("posts only the content-free body, with no interpolation", () => {
    const source = kotlinCode("ReminderReceiver.kt");
    const texts = [...source.matchAll(/\.setContentText\((.+)\)/g)].map((m) => m[1].trim());
    expect(texts).toEqual(["CONTENT_FREE_BODY"]);
    expect(source).not.toContain("setContentTitle");

    const literal = /const val CONTENT_FREE_BODY = ("(?:[^"\\]|\\.)*")/.exec(source);
    expect(literal, "CONTENT_FREE_BODY literal not found").not.toBeNull();
    expect((literal as RegExpExecArray)[1]).not.toContain("$");
  });

  // Two platforms, one notification text. A divergence would mean the same
  // feature says different things depending on the phone.
  it("says exactly what the iOS adapter says", () => {
    const swiftLiteral = /static let contentFreeBody = ("(?:[^"\\]|\\.)*")/.exec(
      read(
        "../src-tauri/tauri-plugin-reminders/ios/Sources/RemindersPlugin/RemindersPlugin.swift",
      ),
    );
    const kotlinLiteral = /const val CONTENT_FREE_BODY = ("(?:[^"\\]|\\.)*")/.exec(
      kotlin("ReminderReceiver.kt"),
    );
    expect(swiftLiteral).not.toBeNull();
    expect(kotlinLiteral).not.toBeNull();
    expect((kotlinLiteral as RegExpExecArray)[1]).toBe((swiftLiteral as RegExpExecArray)[1]);
  });

  // Android has no alarm-enumeration API, so `listPending` is answered from a
  // record Myne writes. Its schema is the same two fields that cross the seam —
  // it sits outside the encrypted vault, so a third field would be a new leak.
  it("records exactly { id → at } and nothing else", () => {
    const source = kotlinCode("ReminderStore.kt");
    const writes = [...source.matchAll(/putString\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(writes).toEqual(["id, at"]);
  });

  // Android drops every alarm on reboot — and the reconciliation pass cannot
  // notice, because `listPending` is answered from a record that survives the
  // restart perfectly. The diff comes out EMPTY and the reminders are silently
  // gone. The restore is what stops the record from lying.
  it("re-registers from the record on boot AND on every app start", () => {
    expect(kotlinCode("BootReceiver.kt")).toContain("ReminderAlarms.restore(context)");
    // The backstop: a boot broadcast can be missed (an OEM battery manager, a
    // force-stopped app, an install never launched since). Re-registering is
    // idempotent, so running both costs nothing.
    expect(kotlinCode("RemindersPlugin.kt")).toContain("ReminderAlarms.restore(activity)");
  });

  it("restores only from the record, and drops instants already past", () => {
    const source = kotlinCode("ReminderAlarms.kt");
    const restore = /fun restore\(context: Context\) \{([\s\S]*?)\n {4}\}/.exec(source);
    expect(restore, "restore body not found").not.toBeNull();
    const body = (restore as RegExpExecArray)[1];
    // A device that was off through a reminder's moment must not be greeted by
    // it on the way back up — firing late reads as the reminder being wrong.
    expect(body).toContain("triggerAt <= now");
    expect(body).toContain("store.remove(id)");
    // Nothing here may reach for the vault: a reboot leaves it locked, which is
    // the entire reason pre-registration exists.
    expect(body).not.toContain("vault");
  });

  // Same id → same data URI → the same PendingIntent, which FLAG_UPDATE_CURRENT
  // replaces rather than adds. That is what makes "a restart does not duplicate
  // registrations" true with no bookkeeping at all.
  it("re-registration replaces rather than duplicates", () => {
    const source = kotlinCode("ReminderAlarms.kt");
    expect(source).toContain("PendingIntent.FLAG_UPDATE_CURRENT");
    expect(source).toContain('setData(Uri.parse("myne-reminder://" + Uri.encode(id)))');
  });

  // The other half of keeping the record honest: a fired reminder is consumed by
  // the platform, so the record must let go of it. Otherwise `listPending`
  // reports a reminder that no longer exists and every later pass has to clean
  // up after it.
  it("drops the record when a reminder fires, and writes nothing there", () => {
    const source = kotlinCode("ReminderReceiver.kt");
    const calls = [...source.matchAll(/ReminderStore\(context\)\.(\w+)\(/g)].map((m) => m[1]);
    expect(calls).toEqual(["remove"]);
  });

  // One persistence location, holding two fields. A second one would be a second
  // thing outside the encrypted vault to reason about.
  it("persists nowhere but the one record", () => {
    for (const name of KOTLIN_SOURCES) {
      const source = kotlinCode(name);
      const expected = name === "ReminderStore.kt" ? 1 : 0;
      expect(
        [...source.matchAll(/getSharedPreferences\(/g)].length,
        `${name} must not open its own preferences file`,
      ).toBe(expected);
    }
  });

  // Only the four states the shared permission flow branches on. A fifth would
  // fall through its `if` chain and silently read as denied.
  it("answers only the four permission states the shared flow knows", () => {
    const source = kotlinCode("RemindersPlugin.kt");
    const body = /private fun currentPermission\(\): String \{([\s\S]*?)\n {4}\}/.exec(source);
    expect(body, "currentPermission body not found").not.toBeNull();
    const returned = new Set(
      [...(body as RegExpExecArray)[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]),
    );
    expect([...returned].sort()).toEqual(["denied", "granted", "not-determined", "unavailable"]);
  });
});

describe("the Android permission and dependency surface stays minimal", () => {
  const manifest = () =>
    read("../src-tauri/tauri-plugin-reminders/android/src/main/AndroidManifest.xml").replace(
      /<!--[\s\S]*?-->/g,
      "",
    );

  // Three, and the list is pinned whole so a fourth cannot arrive unnoticed.
  // None of them is an install-time grant in the sense that matters:
  // POST_NOTIFICATIONS is a runtime request, SCHEDULE_EXACT_ALARM is a special
  // app access reached only from an affordance the user tapped, and
  // RECEIVE_BOOT_COMPLETED grants access to nothing.
  it("declares exactly three permissions", () => {
    const declared = [...manifest().matchAll(/<uses-permission android:name="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(declared.sort()).toEqual([
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.RECEIVE_BOOT_COMPLETED",
      "android.permission.SCHEDULE_EXACT_ALARM",
    ]);
  });

  // The install-time entitlement, never. The platform reserves it for
  // alarm-clock and calendar-class apps, `vision.md` says Myne has no calendar,
  // and the decision log records no store-distribution decisions to stand on.
  it("never declares the calendar-class entitlement", () => {
    expect(manifest()).not.toContain("USE_EXACT_ALARM");
    expect(read("../src-tauri/build.rs")).not.toContain("USE_EXACT_ALARM");
  });

  // The notification receiver hears only this app's own alarm. The boot receiver
  // has to be exported to hear a system broadcast at all — which is safe because
  // both actions it listens for are protected broadcasts only the platform may
  // send.
  it("exports the boot receiver and only the boot receiver", () => {
    const declarations = [...manifest().matchAll(/<receiver\s+android:name="([^"]+)"([\s\S]*?)>/g)];
    const byName = new Map(declarations.map((m) => [m[1], m[2]]));

    expect(byName.get("md.myne.reminders.ReminderReceiver")).toContain(
      'android:exported="false"',
    );
    expect(byName.get("md.myne.reminders.BootReceiver")).toContain('android:exported="true"');
  });

  it("listens for a restart and for an app update, and nothing else", () => {
    const filter = /<receiver\s+android:name="md\.myne\.reminders\.BootReceiver"[\s\S]*?<\/receiver>/
      .exec(manifest());
    expect(filter, "BootReceiver declaration not found").not.toBeNull();
    const actions = [...(filter as RegExpExecArray)[0].matchAll(/<action android:name="([^"]+)"/g)]
      .map((m) => m[1])
      .sort();
    // MY_PACKAGE_REPLACED sits beside BOOT_COMPLETED because Android drops
    // pending alarms on an app update exactly as it does on a reboot; leaving it
    // out would ship a feature that silently stops working after every update.
    // LOCKED_BOOT_COMPLETED is absent on purpose — it would need direct-boot
    // awareness and a second, device-protected persistence location.
    expect(actions).toEqual([
      "android.intent.action.BOOT_COMPLETED",
      "android.intent.action.MY_PACKAGE_REPLACED",
    ]);
  });

  // The dependency cost is the reason the off-the-shelf plugin was declined; a
  // module that pulled the same libraries in would have spent it anyway.
  it("pulls in no AppCompat, Material or JSON library", () => {
    const gradle = read("../src-tauri/tauri-plugin-reminders/android/build.gradle.kts");
    const deps = /dependencies \{([\s\S]*?)\n\}/.exec(gradle);
    expect(deps, "gradle dependencies block not found").not.toBeNull();
    for (const forbidden of ["appcompat", "material", "jackson", "gson", "moshi"]) {
      expect(
        (deps as RegExpExecArray)[1],
        `reminders module must not depend on ${forbidden}`,
      ).not.toContain(forbidden);
    }
  });
});

describe("the per-device switch and the horizon line", () => {
  const component = () => read("../src/components/ReminderSettings.tsx");

  // A DATE, not a day count: "through 2026-08-08" is checkable against a
  // calendar; "7 days" makes the reader do the arithmetic and get it wrong.
  it("states a date, computed in the user's local calendar", async () => {
    const { horizonDate } = await import("../src/components/ReminderSettings");
    // #52: the horizon is INCLUSIVE of today, so a 7-day horizon ends on
    // today + 6. This asserted today + 7 — a day LATER than any reminder the
    // scheduler registers, and a day later than the other client said.
    // 31 Jan + 6 still lands in February, so the month rollover is still
    // covered, and a local-vs-UTC mistake still shows up as an off-by-one.
    expect(horizonDate(7, new Date(2026, 0, 31, 23, 30))).toBe("2026-02-06");
    // A 1-day horizon covers TODAY and nothing else.
    expect(horizonDate(1, new Date(2026, 11, 31, 0, 30))).toBe("2026-12-31");
    // A leap day, because February is where date arithmetic goes wrong.
    expect(horizonDate(2, new Date(2028, 1, 28, 12, 0))).toBe("2028-02-29");
  });

  it("names the same date the other client does", async () => {
    // The two derivations drifted precisely because they lived apart; both now
    // call the shared one, so this pins that they agree rather than re-deriving
    // an expected value here.
    const { horizonDate } = await import("../src/components/ReminderSettings");
    const { horizonEndDate } = await import("@myne/reminder-schedule");
    const today = new Date(2026, 7, 3, 9, 0);
    expect(horizonDate(7, today)).toBe(horizonEndDate(today, 7));
  });

  it("falls back to the shared horizon when the device has not set one", async () => {
    const { horizonDate } = await import("../src/components/ReminderSettings");
    const { REMINDER_HORIZON_DAYS } = await import("@myne/reminder-schedule");
    const today = new Date(2026, 7, 1, 12, 0);
    expect(horizonDate(null, today)).toBe(horizonDate(REMINDER_HORIZON_DAYS, today));
  });

  // The two fields are the desktop feature's. Mobile registers and consumes
  // them; introducing a third would be a spec change nobody asked for.
  it("introduces no preference field of its own", () => {
    // The component is prefs-agnostic — it takes `enabled` / `horizonDays` as
    // props and names no stored field at all, so it cannot invent one.
    expect(component()).not.toMatch(/reminder[a-z]*_[a-z_]+/);

    // The settings sheet reads exactly the two fields the desktop feature
    // defined, and writes them through exactly the two shared setters.
    const sheet = read("../src/app/flows/SettingsSheet.tsx");
    const fields = new Set(
      [...sheet.matchAll(/eff\.(reminder[a-z_]*)/g)].map((m) => m[1]),
    );
    expect([...fields].sort()).toEqual(["reminder_horizon_days", "reminders_enabled"]);

    const prefs = read("../src/lib/prefs.ts");
    expect(prefs).toContain("plugin:prefs|set_reminders_enabled");
    expect(prefs).toContain("plugin:prefs|set_reminder_horizon_days");
    // No third setter crept in beside them.
    const setters = [...prefs.matchAll(/plugin:prefs\|set_reminder[a-z_]*/g)].map((m) => m[0]);
    expect(new Set(setters).size).toBe(2);
  });

  // The gotcha this repo has been bitten by: a prefs command needs the build.rs
  // list, the permission file AND the invoke_handler. Missing any one of them
  // fails CLOSED at runtime, and nothing at build time says so.
  it("registers both prefs commands at all three backend sites", () => {
    const sites = [
      "../src-tauri/build.rs",
      "../src-tauri/permissions/prefs/default.toml",
      "../src-tauri/src/plugins/prefs/mod.rs",
    ];
    for (const site of sites) {
      const source = read(site);
      for (const command of ["set_reminders_enabled", "set_reminder_horizon_days"]) {
        expect(source, `${site} must register ${command}`).toContain(command);
      }
    }
    // The roster is the fourth trap: a `[[permission]]` block that no `[default]`
    // entry names grants nothing.
    const toml = read("../src-tauri/permissions/prefs/default.toml");
    expect(toml).toContain('"allow-set-reminders-enabled"');
    expect(toml).toContain('"allow-set-reminder-horizon-days"');
  });

  // An absent key must read as ON. Reading it as off would silently disable
  // reminders on every existing vault — the worst available reading.
  it("defaults to enabled before the first read resolves", async () => {
    const { DEFAULT_PREFS } = await import("../src/lib/use-prefs");
    expect(DEFAULT_PREFS.reminders_enabled).toBe(true);
    expect(DEFAULT_PREFS.reminder_horizon_days).toBeNull();
  });

  it("hides the horizon line when reminders are off — there is no horizon to state", () => {
    expect(component()).toContain("{enabled && (");
  });
});

describe("the production factory is opaque by construction (MYND-619 task 4)", () => {
  it("substitutes an opaque id before anything reaches the platform", async () => {
    // The id handed to the plugin is what Android persists in SharedPreferences,
    // OUTSIDE the encrypted envelope. `threat-model.md` §7 promises no resolvable
    // note identifier lands there, and the desktop locator is
    // `myne.reminder.<noteId>.<lineIndex>` — so an unwrapped factory would break
    // that promise the moment the engine is wired.
    invoke.mockClear();
    await createReminderNotifier().schedule({
      id: "myne.reminder.note-abc-123.7",
      at: "2026-08-01T09:00",
    });
    const sent = JSON.stringify(invoke.mock.calls);
    expect(sent).not.toContain("note-abc-123");
    expect(sent).not.toContain("myne.reminder");
  });

  it("the raw factory is still reachable for seam tests, and is NOT what production gets", () => {
    // Two distinct functions: if these ever became the same object, the wrap
    // would have been lost and the guarantee with it.
    expect(createReminderNotifier).not.toBe(createRawReminderNotifier);
  });
});

// myne#508. `setReminderHorizonDays` existed here with its Rust core, its ACL
// row and the three-site registration the describe above pins, and no caller
// anywhere in `mobile/src`, so the horizon rendered and could never be set.
//
// Worth saying why the tests above did not catch it: the "introduces no
// preference field of its own" case asserts the sheet READS both fields and
// that both setters EXIST in `prefs.ts`, and its comment says the sheet "writes
// them through exactly the two shared setters". No assertion in it made that
// claim. These are that claim, checked.
// **What these are, stated so they are not read as coverage.** Five of the six
// cases below are source-TEXT assertions over `SettingsSheet.tsx` and
// `ReminderSettings.tsx`: a regex over the `writeDraftPref` call, two
// `toContain` checks and two window slices. Every one of them passes even if
// `ReminderSwitchBlock` never renders a `Segmented` or `onHorizonChange` is
// never threaded to it, which is exactly the shape this file's preamble and
// `mobile/src/components/inputs.tsx`'s header say they exist to eliminate.
//
// They are kept, and kept labelled, rather than deleted or promoted. The
// BEHAVIOUR is covered at the flow-logic tier, in
// `mobile/tests/flow-logic/settings/reminders.flow.ts`, which renders the sheet,
// presses keys and reads what was written; these are cheap drift locks over
// facts a render assertion states less directly ("the call sits inside the
// chokepoint", "there is no hand-written day list beside the shared one"). So
// the cost here is duplication, not an uncovered path. The one case that is not
// a grep is the `remindersReachTheOs`-against-`check-unwired` agreement, which
// is a real cross-file assertion and the reason this block is worth keeping at
// all.
describe("the horizon can actually be set (myne#508): source-text drift locks, behaviour is in reminders.flow.ts", () => {
  const sheet = (): string => read("../src/app/flows/SettingsSheet.tsx");
  const component = (): string => read("../src/components/ReminderSettings.tsx");

  it("writes the horizon through the same draft path as the switch beside it", () => {
    // An import is not a caller, which is the whole shape of this bug and a
    // lesson `scripts/check-ipc-binding-callers.mjs` learned about itself. So
    // the assertion is on the CALL, and specifically on the call sitting inside
    // `writeDraftPref`, the chokepoint that keeps the sheet's optimistic value
    // and the persisted one in step.
    expect(sheet()).toMatch(
      /writeDraftPref\(\s*"reminder_horizon_days"[\s\S]{0,120}?setReminderHorizonDays\(/,
    );
  });

  it("offers the SHARED choices rather than a list of its own", async () => {
    // The drift #52 recorded about the horizon's end date, one step earlier: a
    // picker with its own option list makes the same preference mean different
    // things on the two clients, and the horizon is device-local, so nothing
    // ever reconciles the disagreement.
    expect(component()).toContain("REMINDER_HORIZON_CHOICES");
    const { REMINDER_HORIZON_CHOICES, REMINDER_HORIZON_DAYS } = await import(
      "@myne/reminder-schedule"
    );
    expect([...REMINDER_HORIZON_CHOICES]).toContain(REMINDER_HORIZON_DAYS);
    // No hand-written day list beside the shared one.
    expect(component()).not.toMatch(/\[\s*1\s*,\s*7\s*,/);
  });

  it("labels the options through `Intl`, not through a catalog key per option", () => {
    // Five keys saying "7 g" in each of 32 catalogs is what this replaced, and
    // a key held in a constant is invisible to `scripts/check-i18n.mjs`, whose
    // scan is for static `t("…")` literals. `Intl` also keeps the two clients
    // identical by construction, since the implementation is the platform's.
    expect(component()).toContain("Intl.NumberFormat");
    expect(component()).not.toMatch(/settings\.reminders\.horizon\d/);
  });

  it("keeps `remindersReachTheOs` and the unwired-pass record in agreement", async () => {
    // This is the machine half of a claim `myne-agents/docs/threat-model.md` §7 now makes:
    // "None of the exposure below currently applies to any build." Nothing tied
    // that sentence to reality except a hardcoded `return false` and a prose
    // pointer, and the change that makes the exposure real is the sanctioned
    // silent path: `check-unwired.mjs` is a ratchet, so REMOVING
    // `reminderPass.ts` from its exemption list is what wiring the pass looks
    // like, and every other assertion here would stay green through it.
    //
    // So the two are asserted to move together. Give the pass a caller without
    // flipping the predicate and this fails by name, which is the moment the
    // §7 scope clause and the gated settings sentence both need revisiting.
    const unwired = read("../../scripts/check-unwired.mjs");
    const passIsRecordedUnwired = unwired.includes('"mobile/src/lib/reminderPass.ts"');
    const { remindersReachTheOs } = await import("../src/lib/reminders");
    expect(remindersReachTheOs()).toBe(!passIsRecordedUnwired);
  });

  it("gates the horizon line on the predicate, in BOTH directions", () => {
    // `remindersReachTheOs()` returns `false` today, so every rendered
    // assertion elsewhere exercises the absent arm. A gate proven only in the
    // direction it is currently stuck in says nothing about the gate, and the
    // arm that is dormant is the one the decision entry promises will come
    // back. This pins the shape rather than the value: the line is inside the
    // predicate's arm and nothing else is.
    const src = component();
    const start = src.indexOf("{remindersReachTheOs() && (");
    expect(start).toBeGreaterThan(-1);
    const close = src.indexOf("\n          )}", start);
    expect(close).toBeGreaterThan(start);
    const arm = src.slice(start, close);
    expect(arm).toContain("settings.reminders.horizon");
    // The picker is NOT inside it: the preference is real and persisted
    // whatever reads it, and a control the user can set is not the same claim
    // as a sentence saying something already happened.
    expect(arm).not.toContain("settings.reminders-horizon-picker");
  });

  it("keeps the horizon behind the switch, so an off feature shows no window", () => {
    // A picker rendered while reminders are off would take a write for a
    // mechanism the switch has turned off. The behavioural half is
    // `mobile/tests/flow-logic/settings/reminders.flow.ts`, which turns the
    // switch off and asserts the picker is gone; this only pins that the markup
    // sits inside the arm rather than after it.
    //
    // Bounded at the arm's close, not at end of file. Slicing to EOF is what
    // this said first, and it made the assertion pass for a picker moved OUT of
    // the arm to any later position. It was a containment claim that only
    // failed if the picker moved ABOVE it.
    const src = component();
    const start = src.indexOf("{enabled && (");
    expect(start).toBeGreaterThan(-1);
    const close = src.indexOf("\n      )}", start);
    expect(close).toBeGreaterThan(start);
    const arm = src.slice(start, close);
    expect(arm).toContain("settings.reminders-horizon-picker");
  });
});
