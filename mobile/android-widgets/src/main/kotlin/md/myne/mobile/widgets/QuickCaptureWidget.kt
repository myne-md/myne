// WG-02 · "Quick capture" — the one action widget. 2×2 shows the small layout
// (whole-widget tap → new note, mirroring the iOS systemSmall `widgetURL`);
// resized wider it switches to the medium layout with two independent tap
// targets ("New note" + mic → voice capture), which Android RemoteViews can do
// per-view where iOS systemSmall could not.
package md.myne.mobile.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle
import android.widget.RemoteViews

class QuickCaptureWidget : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        for (id in appWidgetIds) render(context, appWidgetManager, id)
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        render(context, appWidgetManager, appWidgetId)
    }

    private fun render(context: Context, manager: AppWidgetManager, id: Int) {
        val minWidthDp = manager.getAppWidgetOptions(id)
            .getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
        val views = if (minWidthDp >= MEDIUM_MIN_WIDTH_DP) {
            RemoteViews(context.packageName, R.layout.myne_widget_capture_medium).apply {
                setOnClickPendingIntent(R.id.myne_btn_new_note, deepLink(context, URI_CAPTURE))
                setOnClickPendingIntent(R.id.myne_btn_voice, deepLink(context, URI_CAPTURE_VOICE))
            }
        } else {
            RemoteViews(context.packageName, R.layout.myne_widget_capture_small).apply {
                setOnClickPendingIntent(R.id.myne_root, deepLink(context, URI_CAPTURE))
            }
        }
        manager.updateAppWidget(id, views)
    }

    private companion object {
        // Below ~3 launcher cells the two-button row cannot breathe; the
        // OPTION_APPWIDGET_MIN_WIDTH for 3 cells starts around 180–250dp
        // depending on launcher grid, so 220 lands the switch at "wider than
        // the default 2×2".
        const val MEDIUM_MIN_WIDTH_DP = 220
    }
}
