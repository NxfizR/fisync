package com.fisync.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.BatteryManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Telephony
import android.telecom.TelecomManager
import android.telephony.SmsManager
import android.telephony.TelephonyManager
import android.util.Base64
import androidx.core.app.NotificationCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

// Runs in the background with a visible notification. It keeps an encrypted link to the computer,
// reports incoming calls and texts, and carries out the computer's requests.
class BridgeService : Service() {

    companion object {
        const val PREFS = "fisync"
        const val ACTION_STOP = "com.fisync.STOP"
        const val ACTION_FORGET = "com.fisync.FORGET"
        private const val CHANNEL = "fisync-link"
        private const val NOTE_ID = 7
        private const val MAX_PHOTO_BYTES = 10_000_000L

        @Volatile
        private var running = false

        fun isRunning(): Boolean = running

        const val ACTION_RESUME = "com.fisync.RESUME"
        const val WIDGET_KEY = "widgetText"
        private const val PAUSE_KEY = "phonePausedUntil"

        // When the phone link is paused, this is the time it comes back (0 when not paused).
        fun pausedUntil(ctx: Context): Long =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(PAUSE_KEY, 0L)

        // Pauses the phone link for the given hours; 0 resumes it.
        fun setPause(ctx: Context, hours: Long) {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            if (hours > 0) p.putLong(PAUSE_KEY, System.currentTimeMillis() + hours * 3_600_000L) else p.remove(PAUSE_KEY)
            p.apply()
        }

    @Volatile
    var instance: BridgeService? = null
        private set

        // Builds a JSON object from alternating keys and values.
        fun o(vararg kv: Any?): JSObject {
            val j = JSObject()
            var i = 0
            while (i + 1 < kv.size) {
                j.put(kv[i] as String, kv[i + 1])
                i += 2
            }
            return j
        }
    }

    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val work: ExecutorService = Executors.newSingleThreadExecutor()
    private val ui = Handler(Looper.getMainLooper())
    private val retry = Runnable { connect() }
    private val names = HashMap<String, String?>()
    private var failures = 0
    private var socket: WebSocket? = null

    @Volatile
    private var session: FiCrypto.Session? = null
    // Addresses to try, most likely first. The current one is hosts[hostIdx].
    private var hosts: List<String> = emptyList()
    private var hostIdx = 0
    private val host: String? get() = hosts.getOrNull(hostIdx)
    private var token: String? = null
    private var wanted = false
    private var phoneReceiver: BroadcastReceiver? = null
    private var smsReceiver: BroadcastReceiver? = null
    private var cid: String? = null
    private var nsdListener: NsdManager.DiscoveryListener? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        CrashRecorder.install(filesDir)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                ReconnectWorker.cancel(this)
                shutdown()
                return START_NOT_STICKY
            }
            ACTION_RESUME -> setPause(this, 0)
            ACTION_FORGET -> {
                send(o("t", "unpair"))
                SecretStore.delete(this, SecretStore.nameFor(cid))
                ReconnectWorker.cancel(this)
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply()
                shutdown()
                return START_NOT_STICKY
            }
        }
        val p = getSharedPreferences(PREFS, MODE_PRIVATE)
        intent?.getStringExtra("cid")?.let { p.edit().putString("cid", it).apply() }
        intent?.getStringExtra("hosts")?.takeIf { it.isNotBlank() }?.let { p.edit().putString("hosts", it).apply() }
        cid = p.getString("cid", null)
        // Older versions kept the token in plain preferences: move it into the Keystore store once.
        p.getString("token", null)?.let { old ->
            SecretStore.save(this, SecretStore.nameFor(cid), old)
            p.edit().remove("token").apply()
        }
        token = SecretStore.load(this, SecretStore.nameFor(cid))
        hosts = (p.getString("hosts", "") ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() }
        hostIdx = 0
        if (hosts.isEmpty() || token == null) {
            goForeground("Not paired")
            shutdown()
            return START_NOT_STICKY
        }
        wanted = true
        running = true
        failures = 0
        ReconnectWorker.schedule(this)
        intent?.getStringExtra("mac")?.let { p.edit().putString("mac", it).apply() }
        if (intent?.hasExtra("autowake") == true) p.edit().putBoolean("autowake", intent.getBooleanExtra("autowake", false)).apply()
        goForeground("Connecting to $host…")
        register()
        connect()
        return START_STICKY   // Android restarts the service if it is killed
    }

    override fun onDestroy() {
        instance = null
        shutdown()
        work.shutdownNow()
        super.onDestroy()
    }

    // ---------- notification
    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(NotificationChannel(CHANNEL, "Computer link", NotificationManager.IMPORTANCE_LOW))
        }
    }

    private fun note(text: String): Notification {
        val stop = PendingIntent.getService(
            this, 0, Intent(this, BridgeService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("fisync")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .addAction(0, "Disconnect", stop)
            .addAction(0, "Pause 1 hour", PendingIntent.getBroadcast(
                this, 1, Intent(ControlReceiver.ACTION_PAUSE).setPackage(packageName), PendingIntent.FLAG_IMMUTABLE))
            .addAction(0, "Lock computer", PendingIntent.getBroadcast(
                this, 2, Intent(ControlReceiver.ACTION_LOCK).setPackage(packageName), PendingIntent.FLAG_IMMUTABLE))
            .build()
    }

    private fun goForeground(text: String) {
        ensureChannel()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTE_ID, note(text), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTE_ID, note(text))
        }
    }

    private fun updateNote(text: String) {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTE_ID, note(text))
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(WIDGET_KEY, text).apply()
        FisyncWidget.refresh(this)
    }

    // Events reach the web page on the UI thread, where Capacitor expects them.
    private fun postStatus(connected: Boolean, revoked: Boolean) {
        val h = host
        ui.post { FiBridgePlugin.emit("status", o("connected", connected, "revoked", revoked, "host", h)) }
    }

    // ---------- encrypted link to the computer
    private fun connect() {
        ui.removeCallbacks(retry)
        socket?.cancel()
        socket = null
        session = null
        if (!wanted) return
        if (pausedUntil(this) > System.currentTimeMillis()) {
            applyPause()
            return
        }
        val current = host ?: return
        // "relay:<address>" entries reach the computer through the relay; everything else is a direct address.
        val url = if (current.startsWith("relay:")) {
            val computer = cid ?: return
            "wss://" + current.removePrefix("relay:").trimEnd('/') + "/phone/" + BeaconScanner.relayAddress(computer) + "?route=/bridge"
        } else {
            "ws://$current/bridge"
        }
        val req = Request.Builder().url(url).build()
        socket = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                if (ws != socket) return
                try {
                    val s = FiCrypto.Session(token ?: return)
                    session = s
                    ws.send(s.hello())
                } catch (e: Exception) {
                    ws.close(1011, null)
                }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                val s = session ?: return
                if (ws != socket || s.ready) return
                try {
                    val m = JSONObject(text)
                    if (m.optString("t") == "hello-ack" && s.acceptAck(m)) {
                        ws.send(s.auth())
                        failures = 0
                        updateNote("Connected to $host")
                        postStatus(true, false)
                    } else {
                        ws.close(1008, null)
                    }
                } catch (e: Exception) {
                    ws.close(1008, null)
                }
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                val s = session ?: return
                if (ws != socket || !s.ready) return
                try {
                    val pt = s.decrypt(bytes.toByteArray())
                    if (pt.isNotEmpty() && pt[0].toInt() == 1) {
                        handle(String(pt, 1, pt.size - 1, StandardCharsets.UTF_8))
                    }
                } catch (e: Exception) {
                    ws.close(1002, null)
                }
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                if (ws != socket) return
                if (code == 4401) {   // the computer no longer knows this phone
                    revoked()
                    return
                }
                updateNote("Connecting to $host…")
                postStatus(false, false)
                scheduleRetry()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                if (ws != socket) return
                updateNote("Connecting to $host…")
                postStatus(false, false)
                scheduleRetry()
            }
        })
    }

    private fun scheduleRetry() {
        if (!wanted) return
        failures++
        if (failures >= 2) {
            // The address may have changed: first listen for the computer's nearby beacon, then search the network.
            cid?.let { id ->
                BeaconScanner.lookup(this, id, 15) { addr ->
                    promote(addr)
                    if (wanted) connect()
                }
            }
            findComputer()
        }
        if (hosts.size > 1) hostIdx = (hostIdx + 1) % hosts.size   // try the next known address
        if (failures == 3) autoWake()
        ui.postDelayed(retry, minOf(60_000L, 3_000L * failures))   // backs off up to one minute
    }

    private fun revoked() {
        shutdown()
        postStatus(false, true)
    }

    private fun shutdown() {
        wanted = false
        ui.removeCallbacks(retry)
        socket?.close(1000, null)
        socket = null
        session = null
        unregister()
        running = false
        stopForeground(true)
        stopSelf()
    }

    // The computer issued a new token: keep it in the Keystore, then confirm, so the computer can switch over.
    private fun applyRekey(newToken: String) {
        SecretStore.save(this, SecretStore.nameFor(cid), newToken)
        token = newToken
        send(o("t", "rekey-ack"))
    }

    // Wakes the computer after a few failed attempts, if the user chose that and the computer's address is known.
    private var lastWake = 0L
    private fun autoWake() {
        val p = getSharedPreferences(PREFS, MODE_PRIVATE)
        val mac = p.getString("mac", null) ?: return
        if (!p.getBoolean("autowake", false)) return
        if (System.currentTimeMillis() - lastWake < 600_000L) return
        lastWake = System.currentTimeMillis()
        Wol.send(mac)
    }

    // A newly found address (from the beacon or the network search) is tried first from now on.
    private fun promote(addr: String) {
        hosts = listOf(addr) + hosts.filter { it != addr }
        hostIdx = 0
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("hosts", hosts.joinToString(",")).apply()
    }

    // Stops the phone link until the pause ends, then it comes back on its own.
    fun applyPause() {
        ui.removeCallbacks(retry)
        socket?.cancel()
        socket = null
        session = null
        val until = pausedUntil(this)
        val left = until - System.currentTimeMillis()
        if (left > 0) {
            val at = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(until))
            updateNote("Paused until $at")
            postStatus(false, false)
            ui.postDelayed(retry, left)
        }
    }

    fun resumeNow() {
        setPause(this, 0)
        connect()
    }

    fun lockComputer() {
        send(o("t", "lock", "on", true))
    }

    private fun send(msg: JSObject) {
        val s = socket ?: return
        val se = session ?: return
        if (!se.ready) return
        try {
            s.send(se.encrypt(1, msg.toString().toByteArray(StandardCharsets.UTF_8)).toByteString())
        } catch (e: Exception) {
            // the next request will try again
        }
    }

    // ---------- events from the phone
    private fun register() {
        if (phoneReceiver != null) return
        phoneReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                val state = i.getStringExtra(TelephonyManager.EXTRA_STATE)
                val number = i.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
                work.execute { send(o("t", "call", "state", state, "number", number, "name", lookupName(number))) }
            }
        }
        smsReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                val parts = Telephony.Sms.Intents.getMessagesFromIntent(i) ?: return
                if (parts.isEmpty()) return
                val body = parts.joinToString("") { it.messageBody ?: "" }
                val from = parts[0].originatingAddress
                val time = System.currentTimeMillis()
                work.execute { send(o("t", "smsin", "from", from, "name", lookupName(from), "body", body, "date", time)) }
            }
        }
        val pf = IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED)
        val sf = IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(phoneReceiver, pf, Context.RECEIVER_EXPORTED)
            registerReceiver(smsReceiver, sf, Context.RECEIVER_EXPORTED)
        } else {
            registerReceiver(phoneReceiver, pf)
            registerReceiver(smsReceiver, sf)
        }
    }

    private fun unregister() {
        phoneReceiver?.let { try { unregisterReceiver(it) } catch (e: IllegalArgumentException) { } }
        smsReceiver?.let { try { unregisterReceiver(it) } catch (e: IllegalArgumentException) { } }
        phoneReceiver = null
        smsReceiver = null
    }

    // ---------- requests from the computer
    private fun handle(text: String) {
        work.execute {
            try {
                val m = JSONObject(text)
                when (m.optString("t")) {
                    "dial" -> dial(m.getString("n"))
                    "rekey" -> applyRekey(m.getString("token"))
                    "answer" -> telecom().acceptRingingCall()
                    "hangup" -> telecom().endCall()
                    "calls" -> {
                        names.clear()
                        send(callsMsg())
                    }
                    "sms" -> {
                        names.clear()
                        send(inboxMsg(m.optLong("before", 0L)))
                    }
                    "sendsms" -> sendText(m.getString("to"), m.getString("body"))
                    "syncphotos" -> syncPhotos()
                    "phonestatus" -> send(phoneStatus())
                    "contacts" -> send(searchContacts(m.optString("q").take(60)))
                    else -> { }
                }
            } catch (e: Exception) {
                send(o("t", "error", "msg", e.message ?: "Something went wrong"))
            }
        }
    }

    // Finds this computer again on the local network. Matches on the computer's public id, not its address.
    private fun findComputer() {
        val wanted = cid ?: return
        if (nsdListener != null) return
        val nsd = getSystemService(Context.NSD_SERVICE) as NsdManager
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { nsdListener = null }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                nsd.resolveService(info, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {}
                    override fun onServiceResolved(resolved: NsdServiceInfo) {
                        val found = resolved.attributes["cid"]?.let { String(it, StandardCharsets.UTF_8) }
                        if (found != wanted) return
                        promote("${resolved.host.hostAddress}:${resolved.port}")
                        ui.post {
                            stopDiscovery(nsd)
                            connect()
                        }
                    }
                })
            }
        }
        nsdListener = listener
        nsd.discoverServices("_fisync._tcp", NsdManager.PROTOCOL_DNS_SD, listener)
        ui.postDelayed({ stopDiscovery(nsd) }, 20_000L)
    }

    private fun stopDiscovery(nsd: NsdManager) {
        val l = nsdListener ?: return
        nsdListener = null
        try { nsd.stopServiceDiscovery(l) } catch (e: Exception) { }
    }

    // Battery level, charging state and mobile network type, for the status line on the computer.
    private fun phoneStatus(): JSObject {
        val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = bm.isCharging
        val tm = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        val network = try {
            when (tm.dataNetworkType) {
                TelephonyManager.NETWORK_TYPE_NR -> "5G"
                TelephonyManager.NETWORK_TYPE_LTE -> "4G"
                TelephonyManager.NETWORK_TYPE_UNKNOWN -> "no data"
                else -> "3G or older"
            }
        } catch (e: SecurityException) {
            "unknown"
        }
        return o("t", "phonestatus", "battery", level, "charging", charging, "network", network)
    }

    // Contacts whose name contains the text typed on the computer.
    private fun searchContacts(q: String): JSObject {
        val items = JSArray()
        val nameCol = ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME
        try {
            contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(nameCol, ContactsContract.CommonDataKinds.Phone.NUMBER),
                "$nameCol LIKE ?", arrayOf("%$q%"), "$nameCol ASC"
            )?.use { c ->
                while (c.moveToNext() && items.length() < 30) {
                    items.put(o("name", c.getString(0), "number", c.getString(1)))
                }
            }
        } catch (e: SecurityException) {
            return o("t", "error", "msg", "Contacts permission denied")
        }
        return o("t", "contacts", "items", items)
    }

    // Notifications from other apps, sent to the computer (see NotifListener).
    fun forwardNotification(app: String, title: String, text: String, time: Long) {
        work.execute {
            send(o("t", "notif", "app", app, "title", title.take(200), "text", text.take(500), "date", time))
        }
    }

    // Battery below 20% and not charging: pause the heavier work.
    private fun lowBattery(): Boolean {
        val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) < 20 && !bm.isCharging
    }

    private fun telecom(): TelecomManager = getSystemService(Context.TELECOM_SERVICE) as TelecomManager

    private fun dial(number: String) {
        startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    // Contact name for a number, or null. Cached until the next calls or messages request.
    private fun lookupName(number: String?): String? {
        if (number.isNullOrEmpty()) return null
        if (names.containsKey(number)) return names[number]
        var name: String? = null
        val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
        try {
            contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) name = c.getString(0)
            }
        } catch (e: SecurityException) {
            // no contacts permission: show the number instead
        }
        names[number] = name
        return name
    }

    private fun callsMsg(): JSObject {
        val items = JSArray()
        try {
            contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION),
                null, null, "${CallLog.Calls.DATE} DESC"
            )?.use { c ->
                while (c.moveToNext() && items.length() < 50) {
                    val number = c.getString(0)
                    val cached = c.getString(1)
                    items.put(
                        o(
                            "number", number,
                            "name", cached ?: lookupName(number),
                            "type", c.getInt(2),
                            "date", c.getLong(3),
                            "duration", c.getLong(4)
                        )
                    )
                }
            }
        } catch (e: SecurityException) {
            return o("t", "error", "msg", "Call log permission denied")
        }
        return o("t", "calls", "items", items)
    }

    private fun inboxMsg(before: Long): JSObject {
        val items = JSArray()
        try {
            contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE),
                if (before > 0) "${Telephony.Sms.DATE} < ?" else null,
                if (before > 0) arrayOf(before.toString()) else null,
                "${Telephony.Sms.DATE} DESC"
            )?.use { c ->
                while (c.moveToNext() && items.length() < 300) {
                    val address = c.getString(0)
                    items.put(
                        o(
                            "address", address,
                            "name", lookupName(address),
                            "body", c.getString(1),
                            "date", c.getLong(2),
                            "type", c.getInt(3)
                        )
                    )
                }
            }
        } catch (e: SecurityException) {
            return o("t", "error", "msg", "SMS permission denied")
        }
        return o("t", "sms", "items", items, "older", before > 0)
    }

    private fun sendText(to: String, body: String) {
        val sm: SmsManager = if (Build.VERSION.SDK_INT >= 31) {
            getSystemService(SmsManager::class.java)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getDefault()
        }
        sm.sendMultipartTextMessage(to, null, sm.divideMessage(body), null, null)
    }

    private fun syncPhotos() {
        if (lowBattery()) {
            send(o("t", "error", "msg", "Photo sync is paused to save battery. It continues when the battery is charged."))
            return
        }
        val p = getSharedPreferences(PREFS, MODE_PRIVATE)
        val sent = HashSet(p.getStringSet("sent", emptySet()) ?: emptySet())
        var sentNow = 0
        contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME),
            null, null, "${MediaStore.Images.Media.DATE_ADDED} DESC"
        )?.use { c ->
            while (c.moveToNext() && sentNow < 30) {
                val id = c.getLong(0)
                val key = id.toString()
                if (sent.contains(key)) continue
                val bytes = readPhoto(id) ?: continue
                send(o("t", "photo", "name", c.getString(1), "data", Base64.encodeToString(bytes, Base64.NO_WRAP)))
                sent.add(key)
                p.edit().putStringSet("sent", HashSet(sent)).apply()
                sentNow++
            }
        }
        send(o("t", "photosdone"))
    }

    // Reads one photo, or returns null if it is too large or unreadable.
    private fun readPhoto(id: Long): ByteArray? {
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        return contentResolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(65536)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                out.write(buf, 0, n)
                if (out.size() > MAX_PHOTO_BYTES) return null
            }
            out.toByteArray()
        }
    }
}
