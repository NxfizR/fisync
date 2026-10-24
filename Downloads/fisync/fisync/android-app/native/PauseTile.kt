package com.fisync.app

import android.content.Intent
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

// Quick Settings tile: pauses the phone link for an hour, or resumes it.
class PauseTile : TileService() {
    override fun onStartListening() {
        refresh()
    }

    override fun onClick() {
        if (BridgeService.pausedUntil(this) > System.currentTimeMillis()) {
            val svc = BridgeService.instance
            if (svc != null) {
                svc.resumeNow()
            } else {
                BridgeService.setPause(this, 0)
                startForegroundService(Intent(this, BridgeService::class.java))
            }
        } else {
            BridgeService.setPause(this, 1)
            BridgeService.instance?.applyPause()
        }
        refresh()
    }

    private fun refresh() {
        val t = qsTile ?: return
        val paused = BridgeService.pausedUntil(this) > System.currentTimeMillis()
        t.state = if (paused) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        t.label = "fisync"
        t.updateTile()
    }
}
