package com.fisync.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Handles the buttons on the link notification.
class ControlReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_PAUSE = "com.fisync.PAUSE"
        const val ACTION_LOCK = "com.fisync.LOCK"
    }

    override fun onReceive(c: Context, i: Intent) {
        when (i.action) {
            ACTION_PAUSE -> {
                BridgeService.setPause(c, 1)
                BridgeService.instance?.applyPause()
            }
            ACTION_LOCK -> BridgeService.instance?.lockComputer()
        }
    }
}
