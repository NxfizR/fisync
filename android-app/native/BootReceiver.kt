package com.fisync.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

// Starts the background link again after the phone restarts, if this phone is paired and the setting is on.
// On Android 15 and newer the system can refuse a start at boot; then the app starts when you open it.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = context.getSharedPreferences(BridgeService.PREFS, Context.MODE_PRIVATE)
        if (prefs.getString("token", null) == null) return
        if (!prefs.getBoolean("autostart", true)) return
        ContextCompat.startForegroundService(context, Intent(context, BridgeService::class.java))
    }
}
