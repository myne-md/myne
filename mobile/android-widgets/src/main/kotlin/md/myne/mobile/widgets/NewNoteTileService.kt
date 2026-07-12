// Quick Settings "New note" tile — the Android analog of the iOS 18 Control
// Center control (MyneControl.swift + NewNoteIntent). Like every other Myne
// widget surface it only emits a `myne://` URL; on a locked device the system
// keyguard runs first, so nothing is exposed before unlock.
package md.myne.mobile.widgets

import android.os.Build
import android.service.quicksettings.TileService

class NewNoteTileService : TileService() {
    override fun onClick() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(deepLink(this, URI_CAPTURE))
        } else {
            // The Intent overload is rejected on 34+ but is the only one that
            // exists below it.
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(deepLinkIntent(this, URI_CAPTURE))
        }
    }
}
