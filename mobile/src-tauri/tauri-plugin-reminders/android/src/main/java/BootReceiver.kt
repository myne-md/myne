// SPDX-License-Identifier: AGPL-3.0-only
//
// ⚠️ DEVICE-VERIFY-PENDING — see `RemindersPlugin.kt`.
//
// Re-registering alarms after the platform throws them away (MYND-619, task 4).
//
// Android drops every pending alarm on reboot, and **also on an app update**.
// The two are the same failure with different triggers, they are healed by the
// same call, and `MY_PACKAGE_REPLACED` costs no permission — so both are handled
// here rather than shipping a feature that silently stops working after every
// update.
//
// The re-registration comes from `ReminderStore` and nowhere else. It cannot
// come from the vault: a reboot leaves the vault locked, and the whole point of
// pre-registration is that it survives without one. That is also why the record
// carries only an identifier and an instant — see `ReminderStore`.
//
// **Exported, and safe.** A receiver has to be exported to hear a system
// broadcast. Both actions it listens for are *protected broadcasts*, which only
// the platform may send, so exporting it does not let another app trigger it.
// (`ReminderReceiver`, which draws the notification, is `exported="false"` — it
// hears only this app's own alarm.)
//
// `BOOT_COMPLETED` is delivered after the user first unlocks the device, not at
// the earliest boot stage. That is deliberate: the earlier `LOCKED_BOOT_COMPLETED`
// would require direct-boot awareness and device-protected storage, which is a
// second persistence location for a few minutes of earliness nobody asked for.

package md.myne.reminders

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

internal class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                // Idempotent: same id → same PendingIntent → replaced, never
                // added. Past instants are dropped rather than fired, because a
                // device that was off through a reminder's moment should not be
                // greeted by it on the way back up.
                ReminderAlarms.restore(context)
            }
            // Anything else is not ours to act on. A receiver that restored on
            // an unexpected action would be doing work on a signal nobody
            // reasoned about.
            else -> Unit
        }
    }
}
