// SPDX-License-Identifier: AGPL-3.0
// Android half of the mobile screen-capture protection (MYND-469).
//
// FLAG_SECURE is the authoritative OS primitive: it blanks screenshots,
// screen recordings, and the recents/app-switcher preview at the window
// level. This class is loaded reflectively by the Tauri PluginManager
// (consumer-rules.pro keeps it through R8) and is reachable ONLY from the
// Rust backend — no WebView-facing command, no ACL surface.

package md.myne.screenguard

import android.app.Activity
import android.view.WindowManager
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class SetSecureArgs {
    var enabled: Boolean = false
}

@TauriPlugin
class ScreenGuardPlugin(private val activity: Activity) : Plugin(activity) {

    // Pre-unlock always-ON invariant (threat-model §6; the desktop
    // "visible:false → protect → show" analog): protected from the moment the
    // plugin loads — before the WebView paints the unlock screen and before
    // any Rust hook can fire. `vault_unlock` later applies the user's
    // persisted preference through `setSecure`.
    override fun load(webView: WebView) {
        super.load(webView)
        activity.runOnUiThread {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }

    // Window-manipulation must happen on the UI thread. Tauri currently
    // dispatches @Command methods on the main thread (runOnUiThread then runs
    // inline), but that is an implementation detail of PluginManager — the
    // explicit hop keeps this correct if dispatch threading ever changes.
    // resolve() fires inside the block, so the Rust caller returns only after
    // the flag is actually applied/cleared.
    @Command
    fun setSecure(invoke: Invoke) {
        val args = invoke.parseArgs(SetSecureArgs::class.java)
        activity.runOnUiThread {
            try {
                if (args.enabled) {
                    activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                } else {
                    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                }
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject(e.message ?: "setSecure failed")
            }
        }
    }
}
