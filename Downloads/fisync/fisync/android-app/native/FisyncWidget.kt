package com.fisync.app

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.widget.RemoteViews

// Home screen widget showing the link status.
class FisyncWidget : AppWidgetProvider() {
    override fun onUpdate(c: Context, m: AppWidgetManager, ids: IntArray) {
        refresh(c)
    }

    companion object {
        fun refresh(c: Context) {
            val text = c.getSharedPreferences(BridgeService.PREFS, Context.MODE_PRIVATE)
                .getString(BridgeService.WIDGET_KEY, "fisync: not connected") ?: "fisync"
            val m = AppWidgetManager.getInstance(c)
            for (id in m.getAppWidgetIds(ComponentName(c, FisyncWidget::class.java))) {
                val v = RemoteViews(c.packageName, R.layout.widget_fisync)
                v.setTextViewText(R.id.status, text)
                m.updateAppWidget(id, v)
            }
        }
    }
}
