// SPDX-License-Identifier: AGPL-3.0
//
// ⚠️ DEVICE-VERIFY-PENDING — see `RemindersPlugin.kt`.
//
// The record of what is currently registered (MYND-619, task 3).
//
// ── Why this file has to exist ──────────────────────────────────────────────
//
// **`AlarmManager` has no enumeration API.** There is no Android equivalent of
// `getPendingNotificationRequests`: an app cannot ask the platform what alarms
// it currently holds. The PRD said so in advance — "boot-restore and
// pending-listing become ours to write" — and this is the pending-listing half.
// Task 4 replays the same record after a restart, since alarms do not survive
// one.
//
// ── What it may contain, and what it may never ─────────────────────────────
//
// `{ id → at }`. That is the whole schema, and it is the same two fields that
// cross the seam. **No note identifier, no task text, no title, no body** — the
// body is a constant in `ReminderReceiver`, so there is nothing to store.
//
// This is app-private plaintext (`SharedPreferences`), outside the encrypted
// vault. It is the same class of exposure `threat-model.md` §7 already records
// for pending reminders — pending **times** and their **count** — with one
// honest difference worth naming in the mobile clause (task 9): on iOS that
// exposure is entirely in the OS's own store, whereas on Android part of it is
// a file Myne itself writes. The content is identical; the holder is not.
//
// It is **not** a new §10.3 blob family: no magic, no AEAD, no key. SYNC-6's
// promise was that reminders would not add an encrypted device-local blob
// family, and that promise is intact.

package md.myne.reminders

import android.content.Context

/**
 * The device-local record of registered reminders.
 *
 * Deliberately not a cache with its own lifetime: it is written in the same
 * breath as the alarm and cleared in the same breath as the cancel, so
 * [entries] can be answered without asking the platform anything.
 */
internal class ReminderStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Every registration, as `{ id → at }`. */
    fun entries(): Map<String, String> {
        val out = HashMap<String, String>()
        for ((key, value) in prefs.all) {
            // Anything that is not a string pair is not something this wrote —
            // skip rather than crash, so one bad row cannot take out the listing
            // that the whole reconciliation pass depends on.
            if (value is String) out[key] = value
        }
        return out
    }

    /** `commit()`, not `apply()`: the alarm is registered immediately after, and
     *  a process death between the two would leave an alarm nothing knows how to
     *  cancel — an orphan notification with no way to withdraw it. */
    @Suppress("ApplySharedPref")
    fun put(id: String, at: String) {
        prefs.edit().putString(id, at).commit()
    }

    @Suppress("ApplySharedPref")
    fun remove(id: String) {
        prefs.edit().remove(id).commit()
    }

    @Suppress("ApplySharedPref")
    fun clear() {
        prefs.edit().clear().commit()
    }

    private companion object {
        // Distinct from every other device-local prefs file (the share-import
        // wrap key lives in `md.myne.shareimport`) so the two can never collide.
        const val PREFS_NAME = "md.myne.reminders"
    }
}
