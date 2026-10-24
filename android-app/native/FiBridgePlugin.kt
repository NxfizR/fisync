package com.fisync.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.CallLog
import android.provider.Settings
import android.provider.Telephony
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.File
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

@CapacitorPlugin(
    name = "FiBridge",
    permissions = [
        Permission(
            alias = "all",
            strings = [
                Manifest.permission.CALL_PHONE,
                Manifest.permission.READ_PHONE_STATE,
                Manifest.permission.READ_CALL_LOG,
                Manifest.permission.ANSWER_PHONE_CALLS,
                Manifest.permission.READ_SMS,
                Manifest.permission.SEND_SMS,
                Manifest.permission.RECEIVE_SMS,
                Manifest.permission.READ_CONTACTS,
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.POST_NOTIFICATIONS
            ]
        )
    ]
)
class FiBridgePlugin : Plugin() {

    override fun load() {
        current = this
    }

    @PluginMethod
    fun requestAll(call: PluginCall) {
        requestAllPermissions(call, "permsDone")
    }

    @PermissionCallback
    private fun permsDone(call: PluginCall) {
        call.resolve()
    }

    @PluginMethod
    fun startService(call: PluginCall) {
        val i = Intent(context, BridgeService::class.java)
        i.putExtra("hosts", call.getString("hosts"))
        i.putExtra("mac", call.getString("mac"))
        i.putExtra("autowake", call.getBoolean("autowake", false) ?: false)
        i.putExtra("cid", call.getString("cid"))
        ContextCompat.startForegroundService(context, i)
        call.resolve()
    }

    @PluginMethod
    fun stopService(call: PluginCall) {
        if (BridgeService.isRunning()) {
            context.startService(Intent(context, BridgeService::class.java).setAction(BridgeService.ACTION_STOP))
        }
        call.resolve()
    }

    // Tells the computer this phone is removed, then clears the stored pairing.
    @PluginMethod
    fun forget(call: PluginCall) {
        if (BridgeService.isRunning()) {
            context.startService(Intent(context, BridgeService::class.java).setAction(BridgeService.ACTION_FORGET))
        } else {
            context.getSharedPreferences(BridgeService.PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        }
        call.resolve()
    }

    @PluginMethod
    fun isRunning(call: PluginCall) {
        val r = JSObject()
        r.put("running", BridgeService.isRunning())
        call.resolve(r)
    }

    @PluginMethod
    fun openBluetoothSettings(call: PluginCall) {
        context.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        call.resolve()
    }

    @PluginMethod
    fun notificationAccess(call: PluginCall) {
        context.startActivity(
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        call.resolve()
    }

    // Quick actions: these work even when the computer is off.
    @PluginMethod
    fun dial(call: PluginCall) {
        val number = call.getString("number") ?: return call.reject("No number")
        context.startActivity(
            Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        call.resolve()
    }

    @PluginMethod
    fun lastCall(call: PluginCall) {
        val r = JSObject()
        try {
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI, arrayOf(CallLog.Calls.NUMBER), null, null, "${CallLog.Calls.DATE} DESC"
            )?.use { c ->
                if (c.moveToFirst()) r.put("number", c.getString(0))
            }
            call.resolve(r)
        } catch (e: SecurityException) {
            call.reject("Call log permission is off")
        }
    }

    @PluginMethod
    fun lastSms(call: PluginCall) {
        val r = JSObject()
        try {
            context.contentResolver.query(
                Telephony.Sms.CONTENT_URI, arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY), null, null,
                "${Telephony.Sms.DATE} DESC"
            )?.use { c ->
                if (c.moveToFirst()) {
                    r.put("address", c.getString(0))
                    r.put("body", c.getString(1))
                }
            }
            call.resolve(r)
        } catch (e: SecurityException) {
            call.reject("Text message permission is off")
        }
    }

    @PluginMethod
    fun sendSms(call: PluginCall) {
        val to = call.getString("to") ?: return call.reject("No recipient")
        val body = call.getString("body") ?: return call.reject("No text")
        try {
            @Suppress("DEPRECATION")
            val sm: SmsManager = if (Build.VERSION.SDK_INT >= 31) {
                context.getSystemService(SmsManager::class.java)
            } else {
                SmsManager.getDefault()
            }
            sm.sendMultipartTextMessage(to, null, sm.divideMessage(body), null, null)
            call.resolve()
        } catch (e: SecurityException) {
            call.reject("Permission to send texts is off")
        }
    }

    // Wake-on-LAN: broadcasts the magic packet on this Wi-Fi network. The computer must allow it.
    @PluginMethod
    fun wake(call: PluginCall) {
        val mac = call.getString("mac") ?: return call.reject("No computer address")
        Thread {
            try {
                val hex = mac.filter { it.isLetterOrDigit() }.lowercase()
                require(hex.length == 12) { "bad computer address" }
                val address = ByteArray(6) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
                val packet = ByteArray(6 + 16 * 6)
                for (i in 0 until 6) packet[i] = 0xff.toByte()
                for (r in 0 until 16) System.arraycopy(address, 0, packet, 6 + r * 6, 6)
                DatagramSocket().use { socket ->
                    socket.broadcast = true
                    socket.send(DatagramPacket(packet, packet.size, InetAddress.getByName("255.255.255.255"), 9))
                }
                call.resolve()
            } catch (e: Exception) {
                call.reject("Could not send the wake signal: " + e.message)
            }
        }.start()
    }

    @PluginMethod
    fun crashLog(call: PluginCall) {
        val r = JSObject()
        val file = File(context.filesDir, "crash.log")
        r.put("text", if (file.exists()) file.readText() else "")
        call.resolve(r)
    }

    @PluginMethod
    fun clearCrashLog(call: PluginCall) {
        File(context.filesDir, "crash.log").delete()
        call.resolve()
    }

    @PluginMethod
    fun setAutostart(call: PluginCall) {
        context.getSharedPreferences(BridgeService.PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean("autostart", call.getBoolean("enabled", true) ?: true).apply()
        call.resolve()
    }

    @PluginMethod
    fun batteryRestricted(call: PluginCall) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val r = JSObject()
        r.put("restricted", !pm.isIgnoringBatteryOptimizations(context.packageName))
        call.resolve(r)
    }

    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        call.resolve()
    }

    @PluginMethod
    fun pauseState(call: PluginCall) {
        val r = JSObject()
        r.put("until", BridgeService.pausedUntil(context))
        call.resolve(r)
    }

    // The page hands over a token once, right after pairing. From then on only the Keystore holds it.
    @PluginMethod
    fun storeToken(call: PluginCall) {
        val token = call.getString("token")
        if (token.isNullOrEmpty()) {
            call.reject("No token")
            return
        }
        SecretStore.save(context, SecretStore.nameFor(call.getString("cid")), token)
        call.resolve()
    }

    @PluginMethod
    fun forgetToken(call: PluginCall) {
        SecretStore.delete(context, SecretStore.nameFor(call.getString("cid")))
        call.resolve()
    }

    companion object {
        private var current: FiBridgePlugin? = null

        // Called by BridgeService to tell the web page about the link status.
        fun emit(event: String, data: JSObject) {
            current?.notifyListeners(event, data)
        }
    }
}
