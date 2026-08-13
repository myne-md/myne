// The single functional output of every Myne widget surface: a `myne://` URL,
// resolved entirely app-side inside the trust boundary (src/lib/deep-link.ts).
// Unlike iOS there is no separate widget process on Android — RemoteViews are
// BUILT by the app process and rendered by the launcher — so "no vault content
// in a widget" is enforced as policy here (static launchers only), not by a
// process sandbox. Keep it that way: nothing in this module may touch vault
// state, and nothing here refreshes on a timeline.
package md.myne.mobile.widgets

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri

internal const val URI_OPEN = "myne://open"
internal const val URI_CAPTURE = "myne://capture"
internal const val URI_CAPTURE_VOICE = "myne://capture?mode=voice"

/** An ACTION_VIEW PendingIntent for one of the `myne://` intents, pinned to our
 *  own package so no other app can claim the implicit VIEW resolution. The URL
 *  lands in MainActivity's deep-link intent-filter (generated from the
 *  `plugins.deep-link` config in tauri.conf.json) and surfaces to the WebView
 *  via @tauri-apps/plugin-deep-link. */
internal fun deepLink(context: Context, uri: String): PendingIntent =
    PendingIntent.getActivity(
        context,
        uri.hashCode(),
        deepLinkIntent(context, uri),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

internal fun deepLinkIntent(context: Context, uri: String): Intent =
    Intent(Intent.ACTION_VIEW, Uri.parse(uri))
        .setPackage(context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
