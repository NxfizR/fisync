package com.fisync.app

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

// Every 15 minutes, while the link is meant to be on, start the link again if Android stopped it.
// Android may refuse to start a service from the background; the battery setting in the launcher helps.
class ReconnectWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val app = applicationContext
        val p = app.getSharedPreferences(BridgeService.PREFS, Context.MODE_PRIVATE)
        val hosts = p.getString("hosts", "") ?: ""
        val cid = p.getString("cid", null)
        if (hosts.isBlank() || BridgeService.isRunning()) return Result.success()
        if (SecretStore.load(app, SecretStore.nameFor(cid)) == null) return Result.success()
        if (BridgeService.pausedUntil(app) > System.currentTimeMillis()) return Result.success()
        try {
            ContextCompat.startForegroundService(app, Intent(app, BridgeService::class.java)
                .putExtra("hosts", hosts).putExtra("cid", cid))
        } catch (e: Exception) {
            // Android refused: the next run tries again
        }
        return Result.success()
    }

    companion object {
        private const val NAME = "fisync-reconnect"

        fun schedule(ctx: Context) {
            val request = PeriodicWorkRequestBuilder<ReconnectWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun cancel(ctx: Context) {
            WorkManager.getInstance(ctx).cancelUniqueWork(NAME)
        }
    }
}
