package com.fisync.app

import android.content.Intent
import android.os.Bundle
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(FiBridgePlugin::class.java)
        super.onCreate(savedInstanceState)
        // Long-press the app icon for a shortcut that pauses the phone link.
        ShortcutManagerCompat.setDynamicShortcuts(this, listOf(
            ShortcutInfoCompat.Builder(this, "pause-hour")
                .setShortLabel("Pause for an hour")
                .setLongLabel("Pause the phone link for an hour")
                .setIcon(IconCompat.createWithResource(this, android.R.drawable.ic_media_pause))
                .setIntent(Intent(this, MainActivity::class.java)
                    .setAction(Intent.ACTION_VIEW)
                    .putExtra("fisync_action", "pause"))
                .build()
        ))
        handleAction(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleAction(intent)
    }

    private fun handleAction(i: Intent?) {
        if (i != null && i.getStringExtra("fisync_action") == "pause") {
            BridgeService.setPause(this, 1)
            BridgeService.instance?.applyPause()
            i.removeExtra("fisync_action")
        }
    }
}
