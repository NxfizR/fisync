package com.fisync.app

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

// Wake-on-LAN: a broadcast packet that wakes a sleeping computer whose network card is set to listen for it.
object Wol {
    // Sends the packet on a background thread. Failures are ignored: waking is best effort.
    fun send(mac: String) {
        val hex = mac.filter { it.isLetterOrDigit() }.lowercase()
        if (hex.length != 12) return
        Thread {
            try {
                val address = ByteArray(6) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
                val packet = ByteArray(6 + 16 * 6)
                for (i in 0 until 6) packet[i] = 0xff.toByte()
                for (r in 0 until 16) System.arraycopy(address, 0, packet, 6 + r * 6, 6)
                DatagramSocket().use { socket ->
                    socket.broadcast = true
                    socket.send(DatagramPacket(packet, packet.size, InetAddress.getByName("255.255.255.255"), 9))
                }
            } catch (e: Exception) {
                // no network right now: nothing to do
            }
        }.start()
    }
}
