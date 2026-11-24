// SPDX-License-Identifier: AGPL-3.0
//
// ⚠️ DEVICE-VERIFY-PENDING — this Kotlin cannot be gradle-built in the mobile
// repo (gradle is not installed here, and `src-tauri/gen/` holds only `schemas`);
// it is committed source at the `tauri-plugin-screen-guard` bar and is verified
// on a real Android device via `dev-notes/device-matrix.md`, NOT in the change
// that adds it.
//
// Android half of the task-reminder scheduler (MYND-619, tasks 3 and 4).
//
// This class is the WebView-facing surface only. How an alarm is actually
// registered, withdrawn and restored lives in `ReminderAlarms`, because the boot
// path has a `Context` and no `Activity` and the two must do the same thing.
//
// ── The mechanism, and the two it is not ────────────────────────────────────
//
// `AlarmManager` + a `BroadcastReceiver` (`ReminderReceiver`). It registers an
// inert payload and runs no code of ours until it fires.
//
// * **No background work scheduler.** `WorkManager` / `JobScheduler` are already
//   ratified as rejected: they are device-liveness beacons, and a reminder needs
//   nothing to run.
// * **No repeating alarm.** `setRepeating` would fire whether or not the task was
//   completed and would write the recurrence RULE into the platform store rather
//   than one instant — a larger and much longer-lived exposure. iOS refuses the
//   same thing, so the two platforms keep one model.
//
// ── Exactness is opt-in, and approximate is the honest default ──────────────
//
// Without the precise-alarm permission the platform batches wake-ups and a
// reminder can arrive minutes late. That is the DEFAULT state here and the app
// says so rather than pretending otherwise (the settings copy, task 8). This
// plugin only *uses* the permission if it is already held — the in-app affordance
// that asks for it is task 6, and `SCHEDULE_EXACT_ALARM` is deliberately NOT yet
// declared in the manifest, so `canScheduleExactAlarms()` is false until then.
// `USE_EXACT_ALARM`, the install-time entitlement, is never declared: the
// platform reserves it for alarm-clock and calendar-class apps and `vision.md`
// says Myne has no calendar.
//
// ── Listing needs a record, because Android has no enumeration API ──────────
//
// See `ReminderStore` for the record and `ReminderAlarms.restore` for why the
// record would otherwise start lying after a reboot.
//
// ── One platform divergence, recorded rather than silently chosen ───────────
//
// iOS suppresses a notification while the app is in the foreground by default;
// Android posts it. Nothing doubles today, because the in-app reminder surface
// (N1) is not built — `useReminderScheduler` only runs the reconciliation pass.
// When N1 lands, whoever builds it decides whether Android suppresses in
// foreground; making that choice here would have invented policy no design pass
// ratified, and the machinery would be dead code until then.

package md.myne.reminders

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * `schedule` argument. [at] is a LOCAL wall-clock instant, `YYYY-MM-DDTHH:MM` —
 * no offset, no zone.
 */
@InvokeArg
class ScheduleArgs {
    lateinit var id: String
    lateinit var at: String
}

/** `cancel` argument — the opaque registration identifier, nothing else. */
@InvokeArg
class CancelArgs {
    lateinit var id: String
}

/** `setTapHandler` argument — the Rust-side delivery channel for taps. */
@InvokeArg
class SetTapHandlerArgs {
    lateinit var handler: Channel
}

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = POST_ALIAS),
    ],
)
class RemindersPlugin(private val activity: Activity) : Plugin(activity) {

    // Delivery channel for reminder taps, handed in by the Rust backend at setup
    // (the deep-link / share-intent `setEventHandler` precedent). Null until then;
    // a tap that lands before it is wired is dropped, which is the designed
    // behaviour — the alternative to dropping is a queue, and a queue is a file.
    private var tapChannel: Channel? = null

    /** Internal-only: NOT in `build.rs`, so it is unreachable from the WebView. */
    @Command
    fun setTapHandler(invoke: Invoke) {
        tapChannel = invoke.parseArgs(SetTapHandlerArgs::class.java).handler
        // The intent that started us may already be a tap (cold launch on a
        // locked phone is the common case), and `load` runs before the backend
        // wires this channel — so re-check now that there is somewhere to send.
        deliverTap(activity.intent)
        invoke.resolve()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        deliverTap(intent)
    }

    /**
     * Forward a tapped registration identifier, once.
     *
     * The extra is REMOVED after reading: the intent outlives the delivery
     * (Android hands the same one back on every `onResume`), so leaving it in
     * place would replay the same tap and navigate the user somewhere they did
     * not ask to go a second time.
     */
    private fun deliverTap(intent: Intent?) {
        val id = intent?.getStringExtra(ReminderReceiver.EXTRA_ID) ?: return
        intent.removeExtra(ReminderReceiver.EXTRA_ID)
        val payload = JSObject()
        payload.put("id", id)
        tapChannel?.send(payload)
    }

    override fun load(webView: WebView) {
        super.load(webView)
        // Created up front so the "Reminders" line exists in Android's per-app
        // notification settings before the first reminder ever fires — a user who
        // goes looking for it should find it, not discover that it appears only
        // after something has already interrupted them.
        ReminderChannel.ensure(activity)
        // The second half of boot restore, and the one that does not depend on a
        // broadcast arriving. `BootReceiver` is the timely path; this is the
        // backstop for a boot broadcast that never came — an aggressive OEM
        // battery manager, a force-stopped app, an install never launched since.
        // Re-registering is idempotent, so running both costs nothing.
        ReminderAlarms.restore(activity)
    }

    // MARK: - Scheduling

    @Command
    fun schedule(invoke: Invoke) {
        val args = invoke.parseArgs(ScheduleArgs::class.java)
        if (args.id.isEmpty()) {
            invoke.reject("reminder id is empty")
            return
        }
        when (ReminderAlarms.schedule(activity, args.id, args.at)) {
            ReminderAlarms.Result.OK -> invoke.resolve()
            // Refused rather than coerced. A parse that "recovered" from a
            // malformed instant would register a reminder at an hour nobody
            // asked for, and a reminder that arrives at the wrong time is not
            // trusted again.
            ReminderAlarms.Result.INVALID_INSTANT ->
                invoke.reject("reminder instant is not local YYYY-MM-DDTHH:MM: ${args.at}")
            ReminderAlarms.Result.NO_ALARM_SERVICE -> invoke.reject("alarm service unavailable")
            ReminderAlarms.Result.REFUSED -> invoke.reject("the platform refused the alarm")
        }
    }

    @Command
    fun cancel(invoke: Invoke) {
        val args = invoke.parseArgs(CancelArgs::class.java)
        ReminderAlarms.cancel(activity, args.id)
        // Cancelling something the platform is not holding is a no-op, never an
        // error: the reconciliation pass cancels first and has to survive a set
        // that drifted underneath it.
        invoke.resolve()
    }

    @Command
    fun cancelAll(invoke: Invoke) {
        ReminderAlarms.cancelAll(activity)
        invoke.resolve()
    }

    @Command
    fun listPending(invoke: Invoke) {
        val pending = JSArray()
        for ((id, at) in ReminderStore(activity).entries()) {
            pending.put(JSObject().put("id", id).put("at", at))
        }
        invoke.resolve(JSObject().put("pending", pending))
    }

    /**
     * Re-arm everything on every return to the app.
     *
     * This is what makes "granting the precise-alarm permission produces precise
     * delivery" true for reminders that were **already registered**. Granting it
     * does not upgrade existing alarms — they stay inexact until something
     * re-registers them — and the reconciliation pass cannot do it, because the
     * instants have not changed and its diff comes out empty. So the re-arm has
     * to happen on this side, and `onResume` is the moment the user comes back
     * from the platform's permission screen.
     *
     * It heals revocation too: the platform cancels exact alarms when the
     * permission is withdrawn, and this puts them back as approximate ones.
     *
     * (`AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED` is the
     * targeted signal, and it is deliberately NOT used: whether that implicit
     * broadcast reaches a *manifest-declared* receiver on modern Android could
     * not be verified without a device, and an unverifiable mechanism in code
     * nothing here can compile is how a feature silently stops working.
     * `onResume` is guaranteed, and the sweep is idempotent over ≤16 entries.)
     */
    override fun onResume() {
        super.onResume()
        ReminderAlarms.restore(activity)
    }

    // MARK: - Precise delivery (task 6)
    //
    // The permission is requested ON DEMAND, from an in-app affordance, and never
    // at install. `USE_EXACT_ALARM` — the install-time entitlement — is not
    // declared and never will be: the platform reserves it for alarm-clock and
    // calendar-class apps, `vision.md` says Myne has no calendar, and
    // `decisions.md` records no store-distribution decisions at all to stand on.
    //
    // There is no prompt to spend here: `ACTION_REQUEST_SCHEDULE_EXACT_ALARM`
    // opens a settings screen, so nothing is consumed by asking and nothing
    // re-prompts. The app never opens it on its own — only a tap does.

    @Command
    fun exactAlarmStatus(invoke: Invoke) {
        invoke.resolve(JSObject().put("status", ReminderAlarms.exactness(activity)))
    }

    @Command
    fun requestExactAlarm(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            // Before Android 12 an exact alarm needs no permission, so there is
            // no screen to open and nothing to ask for.
            invoke.resolve()
            return
        }
        val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
            .setData(Uri.parse("package:" + activity.packageName))
        try {
            activity.startActivity(intent)
            invoke.resolve()
        } catch (e: ActivityNotFoundException) {
            // Some manufacturer builds do not carry the screen. Saying so beats
            // a button that appears to do nothing.
            invoke.reject("this device has no exact-alarm settings screen", e)
        }
    }

    // MARK: - Notification permission
    //
    // The *when* is not decided here — `requestReminderPermission` above the seam
    // owns it (first reminder, after an in-app explanation, marked before the
    // ask, never automatically repeated). This is `POST_NOTIFICATIONS`, the
    // RUNTIME request; it is not the install-time declaration the manifest
    // deliberately omits, and it is not the precise-alarm permission (task 6).

    @Command
    fun permissionStatus(invoke: Invoke) {
        invoke.resolve(JSObject().put("status", currentPermission()))
    }

    @Command
    fun requestPermission(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // There is no runtime permission to request before Android 13.
            // Answering the current truth beats showing nothing and reporting a
            // grant the platform never made.
            invoke.resolve(JSObject().put("status", currentPermission()))
            return
        }
        requestPermissionForAlias(POST_ALIAS, invoke, "permissionRequestCallback")
    }

    @PermissionCallback
    private fun permissionRequestCallback(invoke: Invoke) {
        invoke.resolve(JSObject().put("status", currentPermission()))
    }

    /**
     * The four-state answer the shared permission flow expects.
     *
     * `areNotificationsEnabled()` is consulted on **both** paths, because the
     * runtime grant is not the whole truth: a user can switch the app's
     * notifications off in system settings while the permission still reads
     * granted, and reporting "granted" then would mean scheduling reminders that
     * can never appear.
     *
     * `PROMPT_WITH_RATIONALE` maps to **denied**, not to "ask again". The user
     * declined once; the ratified posture is one quiet line and no nagging.
     */
    private fun currentPermission(): String {
        val enabled = NotificationManagerCompat.from(activity).areNotificationsEnabled()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return if (enabled) "granted" else "denied"
        }
        return when (getPermissionState(POST_ALIAS)) {
            PermissionState.GRANTED -> if (enabled) "granted" else "denied"
            PermissionState.DENIED, PermissionState.PROMPT_WITH_RATIONALE -> "denied"
            PermissionState.PROMPT -> "not-determined"
            // A state this build cannot read is never assumed to be permissive.
            null -> "unavailable"
        }
    }
}

/** Alias the `@TauriPlugin` annotation binds `POST_NOTIFICATIONS` to. */
internal const val POST_ALIAS = "postNotifications"

/** Channel creation, shared by the plugin's `load` and the receiver's fire path. */
internal object ReminderChannel {
    fun ensure(context: android.content.Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(android.app.NotificationManager::class.java)
            ?: return
        // Creating a channel that already exists is a no-op, which is what makes
        // this safe to call from two places without a "did we already" flag.
        manager.createNotificationChannel(
            android.app.NotificationChannel(
                ReminderReceiver.CHANNEL_ID,
                ReminderReceiver.CHANNEL_NAME,
                android.app.NotificationManager.IMPORTANCE_DEFAULT,
            ),
        )
    }
}
