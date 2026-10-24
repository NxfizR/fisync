package com.fisync.app

import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID

// Listens briefly for the computer's nearby Bluetooth beacon, which carries its current address.
// The beacon is sent as a service ID by Windows, macOS and Linux, and holds the same 16 bytes as remote.js.
// The beacon is only a hint: the link still checks the pairing keys before anything is shared.
object BeaconScanner {
    private val MAGIC = byteArrayOf(0x46, 0x53, 1)
    private val ui = Handler(Looper.getMainLooper())
    private const val COOLDOWN_MS = 120_000L   // at most one listen every two minutes
    private var lastListen = 0L

    // Calls onFound with "ip:port" if this computer's beacon is heard within the time limit.
    fun lookup(ctx: Context, computerId: String, seconds: Long, onFound: (String) -> Unit) {
        val now = System.currentTimeMillis()
        if (now - lastListen < COOLDOWN_MS) return
        lastListen = now
        val adapter = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter ?: return
        if (!adapter.isEnabled) return
        val scanner = adapter.bluetoothLeScanner ?: return
        val want = cidHash(computerId)
        var done = false
        lateinit var callback: ScanCallback
        callback = object : ScanCallback() {
            override fun onScanResult(type: Int, result: ScanResult?) {
                val r = result ?: return
                if (done) return
                var addr: String? = null
                r.scanRecord?.serviceUuids?.forEach { pu ->
                    if (addr == null) addr = decode(uuidBytes(pu.uuid), want)
                }
                val found = addr ?: return
                done = true
                try { scanner.stopScan(callback) } catch (e: SecurityException) { }
                ui.post { onFound(found) }
            }
        }
        // Only beacons whose first three bytes are "FS" + version 1 match.
        val marker = ParcelUuid(UUID(0x4653010000000000L, 0L))
        val mask = ParcelUuid(UUID(-0x10000000000L, 0L))
        val filters = listOf(ScanFilter.Builder().setServiceUuid(marker, mask).build())
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        try {
            scanner.startScan(filters, settings, callback)
            ui.postDelayed({
                if (!done) {
                    done = true
                    try { scanner.stopScan(callback) } catch (e: SecurityException) { }
                }
            }, seconds * 1000)
        } catch (e: SecurityException) {
            // Bluetooth permission not granted: the network search still runs
        }
    }

    // Beacon: "FS" + version (3 bytes), id hash (7), IPv4 address (4), port (2, big-endian). Same layout as remote.js.
    fun decode(d: ByteArray, want: ByteArray): String? {
        if (d.size < 16 || !d.copyOfRange(0, 3).contentEquals(MAGIC)) return null
        if (!d.copyOfRange(3, 10).contentEquals(want)) return null
        val ip = (10 until 14).joinToString(".") { (d[it].toInt() and 0xFF).toString() }
        val port = ((d[14].toInt() and 0xFF) shl 8) or (d[15].toInt() and 0xFF)
        return "$ip:$port"
    }

    private fun uuidBytes(u: UUID): ByteArray =
        ByteBuffer.allocate(16).putLong(u.mostSignificantBits).putLong(u.leastSignificantBits).array()

    // The relay's name for this computer: SHA-256 of its ID, in hex. Must match remote/relay-client.js.
    fun relayAddress(id: String): String =
        MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun cidHash(id: String): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8)).copyOf(7)
}
