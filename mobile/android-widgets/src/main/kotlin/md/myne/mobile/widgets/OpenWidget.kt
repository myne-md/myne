// WG-01 · "Open Myne" — a door into the vault. Static by design: the locked
// default is the ONLY state (no unlock indicator, which would leak vault
// status to anyone glancing at the launcher).
package md.myne.mobile.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews

class OpenWidget : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        for (id in appWidgetIds) {
            val views = RemoteViews(context.packageName, R.layout.myne_widget_open)
            views.setOnClickPendingIntent(R.id.myne_root, deepLink(context, URI_OPEN))
            appWidgetManager.updateAppWidget(id, views)
        }
    }
}
