// SPDX-License-Identifier: AGPL-3.0
//
// ⚠️ DEVICE-VERIFY-PENDING — see `RemindersPlugin.kt`.
//
// What actually posts the notification when an alarm fires (MYND-619, task 3).
//
// `AlarmManager` does not draw notifications; it delivers a `PendingIntent`. On
// Android this receiver is therefore the whole "a reminder fires while Myne is
// closed" mechanism — it runs in a short-lived broadcast, posts one notification
// and returns. **No vault is opened, nothing is decrypted, and no Myne process
// stays alive**, which is exactly the distinction `decisions.md` 2026-07-28 drew
// against the OS scheduling rejected for backups: a backup must RUN WORK, a
// reminder registers an inert payload.
//
// The notification body is the fixed, content-free constant below. There is no
// code path here that reads a task, a note, or the vault — this receiver is
// handed an identifier and nothing else.
//
// It is declared `android:exported="false"`: only the alarm this app registered
// can trigger it, so another app cannot make Myne draw a notification.

package md.myne.reminders

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

internal class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return

        // The registration has now been consumed by the platform. Dropping it
        // here keeps `listPending` honest: a fired reminder reported as still
        // pending would be cancelled by the next reconciliation pass anyway, and
        // an accurate answer beats a self-healing wrong one.
        ReminderStore(context).remove(id)

        // The plugin creates the channel at load, but a reminder can fire in a
        // process the plugin never started (an alarm wakes the app cold), so the
        // receiver has to be able to create it too. One implementation, called
        // from both places.
        ReminderChannel.ensure(context)

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            // The app's own launcher icon, rather than a bespoke asset: a second
            // icon here would be one more thing to keep in step with the brand
            // set, for no user-visible gain.
            .setSmallIcon(context.applicationInfo.icon)
            .setContentText(CONTENT_FREE_BODY)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            // Tapping opens the app. Task 7 owns where it lands after unlock;
            // until then the launcher intent is the honest minimum.
            .setContentIntent(launchIntent(context, id))
            .build()

        // `notify` throws `SecurityException` when the runtime notification
        // permission is absent (Android 13+). A reminder that cannot be posted is
        // a fact to survive, not a crash inside a broadcast receiver — the
        // settings copy already states that delivery may not happen, and the
        // permission surface is what the user acts on.
        try {
            // The tag is the registration id, so a later "withdraw what was
            // posted" has something to address; the int stays constant.
            NotificationManagerCompat.from(context).notify(id, NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            // Permission revoked between scheduling and firing. Nothing to do.
        }
    }

    /** The app's launcher intent, carrying only the opaque registration id. */
    private fun launchIntent(context: Context, id: String): PendingIntent? {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: return null
        launch.putExtra(EXTRA_ID, id)
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(
            context,
            0,
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    internal companion object {
        /** Intent extra carrying the opaque registration identifier. */
        const val EXTRA_ID = "md.myne.reminders.id"

        /** Action of the alarm intent — part of `PendingIntent` identity. */
        const val ACTION_FIRE = "md.myne.reminders.FIRE"

        const val CHANNEL_ID = "md.myne.reminders"

        /** Shown in Android's per-app notification settings. */
        const val CHANNEL_NAME = "Reminders"

        /**
         * The notification body, fixed and content-free.
         *
         * It carries no count, deliberately: every registration is exactly one
         * reminder, so a count would always read `1` — zero information, sitting
         * in the OS store for free. Nothing is ever concatenated onto it.
         */
        const val CONTENT_FREE_BODY = "Myne — reminder"

        /** The `notify` id. Identity is carried by the tag, not by this. */
        const val NOTIFICATION_ID = 1
    }
}
