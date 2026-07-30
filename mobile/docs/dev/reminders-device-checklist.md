# Task reminders — manual device checklist (MYND-619)

Everything in this file exists because **no harness can drive it**. Whether an
operating system actually fires a registration while Myne is closed, whether it
survives a reboot, and where a tap lands after unlock are measurements on a real
phone. The automated tiers cover what they can and stop there:

| Tier | Covers | Cannot cover |
|---|---|---|
| `tests/reminder*.test.ts` (vitest) | the seam contract, the bound, opacity, the latch, the source-level constraints of both native halves | anything the platform does |
| `tests/flow-logic/settings/reminders.flow.ts` (Playwright, mock IPC) | the three settings surfaces | delivery, boot, taps |
| `cargo check --target aarch64-apple-ios` | **compiles the Swift** (via `swift-rs`) | that it behaves |
| — | | the Kotlin does not compile anywhere in this repo |

Run the whole list on each platform before the feature is presented as working.
A failed row is a **stop**, not a note: the entire premise is that a reminder
which arrives late or not at all is never trusted again.

---

## iOS

- [ ] **Permission, once.** Create the first reminder → an in-app explanation
      appears → then the system dialog. Decline it. Create a second reminder and
      confirm the app **does not ask again** by itself.
- [ ] **Fires while closed.** Set a reminder two minutes out, swipe the app away
      from the switcher, wait. It arrives.
- [ ] **Fires while the vault is locked.** Set one two minutes out, lock the
      vault (or wait out auto-lock), wait. It arrives.
- [ ] **Body is content-free.** The notification reads exactly
      `Myne — reminder`. No task text, no note title, nothing else.
- [ ] **Nothing appears in the foreground.** Sit in the app with it open when a
      reminder is due. iOS must **not** draw a banner — the in-app layer owns the
      foreground, and two would be one too many.
- [ ] **No badge.** The app icon grows no number, ever.
- [ ] **Cancel actually cancels.** Set three, complete one, confirm two remain
      pending and the completed one never fires.
- [ ] **Running the pass twice changes nothing.** Lock and unlock twice in a row
      with the same task list; no duplicate notification arrives.
- [ ] **Survives a restart.** Set one an hour out, restart the phone, and
      **without opening Myne** confirm it still arrives.
- [ ] **Tap while locked.** Lock the vault, tap a fired reminder. The app opens
      at the unlock screen; nothing about the task is visible before unlock.
- [ ] **Settings.** Privacy → the reminder switch is on, the horizon line names a
      date roughly a week out, and the precise-delivery row is **absent**
      entirely (iOS has no such permission).

## Android

- [ ] **Permission, once.** First reminder → in-app explanation → the Android 13+
      system dialog. Decline it, create a second reminder, confirm no second
      automatic prompt. On a pre-13 device confirm the state instead reflects the
      app's notification switch in system settings.
- [ ] **Fires while closed.** Two minutes out, swipe the app away, wait.
      **Expect it late** — that is the approximate tier, not a defect, until the
      precise-alarm permission is granted below.
- [ ] **Fires while the vault is locked.**
- [ ] **Body is content-free.** Exactly `Myne — reminder`.
- [ ] **Small icon is legible.** Some Android versions render a coloured icon as
      a white square in the status bar; look at it rather than assuming.
- [ ] **The channel exists before the first fire.** Open the app once, then go to
      system settings → Myne → Notifications, and confirm a **Reminders** channel
      is already listed. A user looking for it should find it, not discover it
      only after being interrupted.
- [ ] **Permission list is exactly three.** System settings shows notifications,
      alarms & reminders, and the two audio permissions — and nothing else.
- [ ] **Precise delivery.** Privacy → "Exact timing / Allow" with the fallback
      sentence beneath → tap → the platform screen opens → grant → return. The
      row now reads **On** and the sentence is gone.
- [ ] **Granting upgrades an EXISTING reminder.** This is the row most likely to
      fail. Register a reminder *before* granting, then grant, then return to the
      app and wait for it: it must arrive **on the minute**. (That is the
      `onResume` re-arm; without it the old alarm stays approximate.)
- [ ] **Revoking degrades rather than breaks.** Revoke the permission in system
      settings, return to the app, and confirm reminders still arrive —
      approximately.
- [ ] **Survives a restart.** One an hour out, reboot, and **without opening
      Myne** confirm it arrives.
- [ ] **A restart does not duplicate.** Repeat the row above, then open Myne once
      after the reboot, and confirm exactly **one** notification arrives — not two.
- [ ] **Survives an app update.** Install an updated APK over the top with a
      pending reminder and confirm it still arrives.
- [ ] **Cancel actually cancels**, and a reminder already showing in the shade is
      withdrawn when its task is completed.
- [ ] **Tap while locked.** Lock the vault, tap a fired reminder, confirm the app
      opens and nothing about the task is visible before unlock. Then background
      and foreground the app several times and confirm the tap does **not**
      replay (the intent extra is cleared after reading).

---

## Known, and not a checklist failure

- **A tap after a cold start cannot be resolved back to a specific task.** The
  identifier the platform holds is opaque and the map back to a task is
  memory-only by design, so a session that did not register the reminder cannot
  name it. Where such a tap should land is an open decision recorded in
  `myne-agents/features/task-notifications-mobile/progress.md`.
- **Manufacturer battery managers** can delay or drop alarms on some devices.
  This is documented rather than fought: the app does not detect it, does not
  prompt about battery optimisation, and says so in the help documentation.
