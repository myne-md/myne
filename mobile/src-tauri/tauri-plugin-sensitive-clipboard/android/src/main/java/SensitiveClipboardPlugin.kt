// SPDX-License-Identifier: AGPL-3.0-only
// Android half of the mobile clipboard transport (myne-md/myne#390 +
// myne-md/myne#455).
//
// # What Android can and cannot give a secret
//
// It CANNOT give the two properties the iOS side rests on. There is no
// device-confinement flag, so nothing here corresponds to `localOnly`, and there
// is no per-item expiry, so nothing corresponds to `expirationDate`. Those two
// absences are why the RECOVERY-PHRASE Copy is withheld on every Android version
// rather than gated to a recent one. This class implements the account-number
// tier, not the phrase tier.
//
// It CAN give two weaker things, and it is worth being exact about them:
//
//  1. `EXTRA_IS_SENSITIVE` (API 33+) is a RENDERING hint. It asks the system to
//     redact the clipboard preview so the value is not shown in clear text, which
//     defends against shoulder-surfing and against a background app that
//     screenshots or records. **It does NOT prevent another app or a clipboard
//     manager from reading the clipboard programmatically.** The first pass at
//     this design treated it as the Android `localOnly`; it is not, and every
//     downstream decision that assumed it was had to be revisited.
//
//  2. A CLEAR, scheduled on EVERY version, using whichever API exists:
//     - API 28+: `clearPrimaryClip()`.
//     - API 24 to 27: no clear API at all; overwrite with an empty clip.
//
//     API 33+ ALSO has an OS-side auto-clear, and this class does not defer to
//     it. An earlier version did, and the AOSP period is on the order of an hour
//     rather than the 30 s the crate pins — so the account number sat on a
//     system-wide clipboard for an undisclosed window, and the exposure was
//     LONGEST on the newest Android, which is the inverse of what a reader
//     assumes. The OS clear still runs; ours is a shorter backstop in front.
//
// # Why the clear is scheduled here and not in the WebView
//
// A JavaScript timer dies with the WebView and does not survive the process, and
// scheduling it there would also mean holding the secret in the JS heap for the
// whole window. Doing it in Kotlin is not as good as an OS-owned expiry — the
// process can still be killed — but it is the best Android offers, and it keeps
// the secret out of the WebView's reach for the duration.
//
// # Why the clear is UNCONDITIONAL rather than compare-and-clear
//
// Comparing first would need a clipboard READ, which is the grant this design
// withholds everywhere. The cost of not comparing is that a user who copies
// something else within the window has that later copy cleared too. That is a
// real cost and it is the reason the window is short.

package md.myne.mobile.sensitiveclipboard

import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class WriteArgs {
    var value: String = ""

    /**
     * The tier, as the serde-lowercased string the Rust crate sends: `"plain"` or
     * `"secret"`. The Rust side has a unit test pinning those exact strings,
     * because a rename there would compile clean on both sides and silently
     * downgrade every secret write to a plain one.
     *
     * Defaults to `"secret"`, NOT `"plain"`, so the tier FAILS CLOSED. Anything
     * that stops this field arriving — an R8 rename, a future change to the
     * argument shape, a Rust-side typo — then produces an over-protected write
     * rather than a silently unprotected one. An unknown value is rejected
     * outright below, and the Swift mirror now does the same: it used to be
     * described here as rejecting "on the same drift" because its field is
     * non-optional, which is wrong. Non-optional decoding catches a missing KEY
     * and never an unknown VALUE, so until the guard landed there, any tier
     * string that was not exactly "secret" took the plain path on iOS.
     */
    var sensitivity: String = "secret"

    /** Seconds until this class should clear. Ignored for the plain tier. */
    var expireAfterSecs: Int = 30
}

@InvokeArg
class ReadArgs

@TauriPlugin
class SensitiveClipboardPlugin(private val activity: Activity) : Plugin(activity) {

    private companion object {
        /** The tier string the Rust side sends for a credential. */
        const val SECRET_TIER = "secret"

        /** The tier string for ordinary content. */
        const val PLAIN_TIER = "plain"

        /** Android 13. Brings both the sensitivity hint and an OS-owned auto-clear. */
        const val API_SENSITIVE_AND_AUTOCLEAR = Build.VERSION_CODES.TIRAMISU

        /** Android 9. Brings `clearPrimaryClip()`. */
        const val API_CLEAR_PRIMARY_CLIP = Build.VERSION_CODES.P
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * The token the pending clear was scheduled under. Held so a second copy
     * replaces the first one's timer rather than racing it: without this, copying
     * twice inside the window would leave the FIRST timer alive and it would
     * clear the SECOND value early.
     */
    private var pendingClear: Runnable? = null

    private fun clipboard(): ClipboardManager =
        activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    @Command
    fun writeText(invoke: Invoke) {
        val args = invoke.parseArgs(WriteArgs::class.java)

        // An unrecognised tier is an error, not a default. Silently choosing one
        // is how a secret write becomes a plain one without anybody noticing.
        if (args.sensitivity != SECRET_TIER && args.sensitivity != PLAIN_TIER) {
            invoke.reject("unknown clipboard sensitivity tier")
            return
        }
        val isSecret = args.sensitivity == SECRET_TIER

        activity.runOnUiThread {
          try {
            val manager = clipboard()

            // A null label rather than a descriptive one: on some versions the
            // label is user-visible, and "Myne recovery phrase" sitting in a
            // clipboard history would announce exactly what the sensitivity hint
            // is trying to hide.
            val clip = ClipData.newPlainText(null, args.value)

            if (isSecret && Build.VERSION.SDK_INT >= API_SENSITIVE_AND_AUTOCLEAR) {
                clip.description.extras = PersistableBundle().apply {
                    putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
                }
            }

            manager.setPrimaryClip(clip)

            // Cancel any clear left over from a previous copy before scheduling
            // this one, so two copies inside one window cannot have the older
            // timer wipe the newer value.
            pendingClear?.let { mainHandler.removeCallbacks(it) }
            pendingClear = null

            // Scheduled on EVERY version, including API 33+.
            //
            // An earlier version skipped this on 33+ and deferred to the OS's own
            // auto-clear. That was wrong in a way the crate's own pinned constant
            // hid: the AOSP period is on the order of an hour, not the 30 s
            // `SECRET_EXPIRY_SECS` states and `secret_expiry_matches_the_desktop_window`
            // asserts. So the account number sat on a system-wide clipboard for a
            // window neither the code nor the threat model disclosed, and the
            // exposure was LONGEST on the newest Android, which is the inverse of
            // what a reader assumes.
            //
            // The OS clear on 33+ still runs; this is a shorter backstop in front
            // of it, not a replacement for it.
            if (isSecret) {
                val task = Runnable {
                    clearClipboard()
                    pendingClear = null
                }
                pendingClear = task
                mainHandler.postDelayed(task, args.expireAfterSecs.toLong() * 1000L)
            }

            invoke.resolve()
          } catch (e: Exception) {
            // `setPrimaryClip` is fallible: a `TransactionTooLargeException` for
            // an oversized clip (the plain tier's caller is a note body, so a
            // large note reaches it), a `SecurityException`, or a null service on
            // some OEMs. Thrown inside a `Runnable` on the main looper it is
            // uncaught and kills the process; worse, `invoke.resolve()` is then
            // never reached, so the Rust `run_mobile_plugin` parks forever and
            // the WebView promise never settles. All four sibling plugins wrap
            // their UI-thread body for exactly this.
            invoke.reject(e.message ?: "clipboard write failed")
          }
        }
    }

    @Command
    fun readText(invoke: Invoke) {
        invoke.parseArgs(ReadArgs::class.java)

        activity.runOnUiThread {
          try {
            val clip = clipboard().primaryClip
            val text = if (clip != null && clip.itemCount > 0) {
                clip.getItemAt(0).coerceToText(activity)?.toString()
            } else {
                null
            }

            val result = JSObject()
            // Absent rather than empty string when the clipboard holds no text.
            // A paste button acting on `""` would clear the field the user was
            // trying to fill, which on the recovery screen means deleting words
            // they had already typed.
            if (!text.isNullOrEmpty()) {
                result.put("value", text)
            }
            invoke.resolve(result)
          } catch (e: Exception) {
            // Same reasoning as the write: an uncaught throw here kills the
            // process and leaves the WebView promise unsettled.
            invoke.reject(e.message ?: "clipboard read failed")
          }
        }
    }

    /**
     * Best-effort clear, split by what the OS version actually has.
     *
     * Below API 28 there is no clear at all, so an empty clip is written over the
     * secret. That is weaker than a real clear — the clipboard then holds an empty
     * item rather than nothing — but it does remove the value, which is the part
     * that matters.
     */
    private fun clearClipboard() {
        val manager = clipboard()
        if (Build.VERSION.SDK_INT >= API_CLEAR_PRIMARY_CLIP) {
            manager.clearPrimaryClip()
        } else {
            manager.setPrimaryClip(ClipData.newPlainText(null, ""))
        }
    }
}
