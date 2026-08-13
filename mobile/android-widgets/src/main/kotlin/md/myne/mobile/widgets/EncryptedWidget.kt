// WG-03 · "Encrypted" — a static reminder badge. Carries no state and never
// updates; tapping opens the app (the iOS widget's default-tap behaviour).
package md.myne.mobile.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews

class EncryptedWidget : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        for (id in appWidgetIds) {
            val views = RemoteViews(context.packageName, R.layout.myne_widget_encrypted)
            views.setOnClickPendingIntent(R.id.myne_root, deepLink(context, URI_OPEN))
            appWidgetManager.updateAppWidget(id, views)
        }
    }
}
