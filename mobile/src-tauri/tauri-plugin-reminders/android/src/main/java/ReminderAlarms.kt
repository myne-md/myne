// SPDX-License-Identifier: AGPL-3.0-only
//
// ⚠️ DEVICE-VERIFY-PENDING — see `RemindersPlugin.kt`.
//
// Registering, withdrawing and restoring alarms (MYND-619, tasks 3 and 4).
//
// Split out of the plugin for one concrete reason: **a `BroadcastReceiver` has a
// `Context`, not an `Activity`.** The boot restore path and the plugin's command
// path have to register alarms exactly the same way, and the only way to
// guarantee "exactly the same way" is one implementation both call.
//
// ── Why a restore path exists at all ───────────────────────────────────────
//
// **Android drops every alarm on reboot**, and the reconciliation pass cannot
// notice. Its `listPending` is answered from `ReminderStore`, which survives the
// restart perfectly — so after a reboot the record says "registered", the target
// set agrees, the diff comes out **empty**, and nothing is ever rescheduled. The
// reminders are simply gone, silently, and the pass that exists to heal drift
// reports everything in order.
//
// So the restore is not a nicety on top of the record; it is what stops the
// record from lying. It runs from two places, deliberately:
//
//   * `BootReceiver` — the moment the platform will accept alarms again;
//   * the plugin's `load()` — every app start, because a boot broadcast can be
//     missed (an aggressive OEM battery manager, a force-stopped app, an
//     install that has never been launched). One of the two having run is
//     enough, and both running is free.
//
// Re-registering is idempotent by construction: same id → same data URI → the
// same `PendingIntent`, which `FLAG_UPDATE_CURRENT` replaces rather than adds.
// That is what makes "a restart does not duplicate registrations" true without
// any bookkeeping.

package md.myne.reminders

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone

internal object ReminderAlarms {

    /** Outcome of a registration attempt, so the caller can answer precisely. */
    internal enum class Result { OK, INVALID_INSTANT, NO_ALARM_SERVICE, REFUSED }

    /**
     * Register one reminder, recording it first.
     *
     * The record is written **before** the alarm: a process death between the
     * two can then only leave a record with no alarm, which the next
     * reconciliation pass — or the next restore — corrects. The reverse order
     * could leave an alarm nothing knows how to cancel.
     */
    fun schedule(context: Context, id: String, at: String): Result {
        val triggerAt = localEpochMillis(at) ?: return Result.INVALID_INSTANT
        val manager = alarmManager(context) ?: return Result.NO_ALARM_SERVICE

        ReminderStore(context).put(id, at)
        return if (arm(context, manager, id, triggerAt)) {
            Result.OK
        } else {
            ReminderStore(context).remove(id)
            Result.REFUSED
        }
    }

    /** Withdraw one reminder: the alarm, the record, and anything already posted. */
    fun cancel(context: Context, id: String) {
        // `FLAG_NO_CREATE` returns null when no such alarm exists, so this does
        // not mint a PendingIntent purely in order to destroy it.
        val pending = alarmIntent(context, id, PendingIntent.FLAG_NO_CREATE)
        if (pending != null) {
            alarmManager(context)?.cancel(pending)
            pending.cancel()
        }
        ReminderStore(context).remove(id)
        // A reminder already showing in the shade is withdrawn too: the user
        // completed or rescheduled the task, and leaving the old notification up
        // is the same wrongness as firing it late.
        try {
            androidx.core.app.NotificationManagerCompat.from(context)
                .cancel(id, ReminderReceiver.NOTIFICATION_ID)
        } catch (_: SecurityException) {
            // Nothing was posted, or notifications are off. Either is fine.
        }
    }

    /** Withdraw every reminder this app registered. */
    fun cancelAll(context: Context) {
        for (id in ReminderStore(context).entries().keys) cancel(context, id)
        ReminderStore(context).clear()
    }

    /**
     * Re-register everything the record holds. Safe to run at any time.
     *
     * **Instants already in the past are dropped, not fired.** A device that was
     * off through a reminder's moment should not be greeted by it on the way
     * back up: firing late reads as the reminder being wrong, which is the same
     * reasoning that keeps past instants out of the target set upstream.
     */
    fun restore(context: Context) {
        val store = ReminderStore(context)
        val manager = alarmManager(context) ?: return
        val now = System.currentTimeMillis()
        for ((id, at) in store.entries()) {
            val triggerAt = localEpochMillis(at)
            if (triggerAt == null || triggerAt <= now) {
                store.remove(id)
                continue
            }
            arm(context, manager, id, triggerAt)
        }
    }

    /**
     * Hand the platform the alarm. Returns false only when it refuses outright.
     *
     * Exact when the permission is held, approximate otherwise — and approximate
     * is the **stated default**, because `canScheduleExactAlarms()` is false
     * until task 6 declares `SCHEDULE_EXACT_ALARM` and the user grants it.
     */
    private fun arm(
        context: Context,
        manager: AlarmManager,
        id: String,
        triggerAt: Long,
    ): Boolean {
        val pending = alarmIntent(context, id, PendingIntent.FLAG_UPDATE_CURRENT) ?: return false
        return try {
            if (canScheduleExact(manager)) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
            } else {
                // `AndAllowWhileIdle` is what gets it through Doze at all;
                // without the permission the platform still batches the wake-up,
                // so delivery is approximate rather than absent.
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
            }
            true
        } catch (_: SecurityException) {
            // The permission can be revoked between the check and the call. Fall
            // back rather than fail: an approximate reminder is the product's
            // stated default, and losing the reminder entirely is not.
            try {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
                true
            } catch (_: SecurityException) {
                false
            }
        }
    }

    /**
     * The alarm's `PendingIntent`.
     *
     * The id goes in the **data URI**, not only in an extra, and that is
     * load-bearing: `PendingIntent` equality ignores extras entirely, so two
     * reminders whose intents differed only by extra would be the same pending
     * intent — scheduling the second would silently replace the first, and
     * cancelling either would cancel both. It is also what makes a re-register
     * replace rather than duplicate.
     */
    private fun alarmIntent(context: Context, id: String, flag: Int): PendingIntent? {
        val intent = Intent(context, ReminderReceiver::class.java)
            .setAction(ReminderReceiver.ACTION_FIRE)
            .setData(Uri.parse("myne-reminder://" + Uri.encode(id)))
            .putExtra(ReminderReceiver.EXTRA_ID, id)
        return PendingIntent.getBroadcast(
            context,
            0,
            intent,
            // Immutable: nothing may rewrite this intent after it is handed to
            // the platform. Required from API 31 and correct before it.
            flag or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun alarmManager(context: Context): AlarmManager? =
        context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager

    /**
     * How precisely this device will currently deliver a reminder.
     *
     * Three answers, not two, because "the permission is missing" and "this
     * platform has no such permission" are different facts and the settings copy
     * says different things about them.
     */
    fun exactness(context: Context): String {
        val manager = alarmManager(context) ?: return EXACTNESS_APPROXIMATE
        return if (canScheduleExact(manager)) EXACTNESS_EXACT else EXACTNESS_APPROXIMATE
    }

    const val EXACTNESS_EXACT = "exact"
    const val EXACTNESS_APPROXIMATE = "approximate"

    private fun canScheduleExact(manager: AlarmManager): Boolean =
        // Before API 31 an exact alarm needs no permission at all. From 31 the
        // platform answers, and it answers false until task 6 declares
        // SCHEDULE_EXACT_ALARM and the user grants it.
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()

    // ── Local wall-clock conversion ────────────────────────────────────────
    //
    // `GregorianCalendar` explicitly, NEVER `Calendar.getInstance()`: the latter
    // returns the DEFAULT LOCALE's calendar, which on a Thai or
    // Japanese-imperial locale is not Gregorian — `set(2026, …)` would then mean
    // Buddhist year 2026 and the reminder would land centuries away. The time
    // zone is the device's, which is what "09:00 means 09:00 wherever the user
    // is" asks for.

    fun localEpochMillis(instant: String): Long? {
        val halves = instant.split("T")
        if (halves.size != 2) return null
        val date = halves[0].split("-")
        val time = halves[1].split(":")
        if (date.size != 3 || time.size != 2) return null

        // Widths AND digits are both checked: `"-1".toInt()` is a valid
        // two-character parse that would yield hour -1.
        val year = digits(date[0], 4) ?: return null
        val month = digits(date[1], 2) ?: return null
        val day = digits(date[2], 2) ?: return null
        val hour = digits(time[0], 2) ?: return null
        val minute = digits(time[1], 2) ?: return null
        if (month !in 1..12 || day !in 1..31 || hour !in 0..23 || minute !in 0..59) return null

        val calendar = GregorianCalendar(TimeZone.getDefault(), Locale.ROOT)
        calendar.clear()
        // Non-lenient so 31 February is refused rather than rolled into March.
        calendar.isLenient = false
        calendar.set(year, month - 1, day, hour, minute, 0)
        return try {
            calendar.timeInMillis
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /** Exactly [width] ASCII digits, as an integer. No sign, no whitespace. */
    private fun digits(text: String, width: Int): Int? {
        if (text.length != width) return null
        for (c in text) if (c !in '0'..'9') return null
        return text.toIntOrNull()
    }
}
