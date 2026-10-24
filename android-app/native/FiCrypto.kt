package com.fisync.app

import android.util.Base64
import org.json.JSONObject
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// Encrypted channel to the computer. Must match server.js and src/crypto-core.js exactly:
// P-256 key agreement, HKDF-SHA256 keys, AES-256-GCM with a counter nonce, one key per direction.
internal object FiCrypto {
    private val CURVE: ECParameterSpec = run {
        val ap = AlgorithmParameters.getInstance("EC")
        ap.init(ECGenParameterSpec("secp256r1"))
        ap.getParameterSpec(ECParameterSpec::class.java)
    }

    fun utf8(s: String): ByteArray = s.toByteArray(StandardCharsets.UTF_8)

    fun concat(vararg parts: ByteArray): ByteArray {
        val out = ByteArray(parts.sumOf { it.size })
        var o = 0
        for (p in parts) {
            System.arraycopy(p, 0, out, o, p.size)
            o += p.size
        }
        return out
    }

    fun random(n: Int): ByteArray = ByteArray(n).also { SecureRandom().nextBytes(it) }

    fun sha256(d: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(d)

    fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val m = Mac.getInstance("HmacSHA256")
        m.init(SecretKeySpec(key, "HmacSHA256"))
        return m.doFinal(data)
    }

    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, len: Int): ByteArray {
        val prk = hmac(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
        val out = ByteArray(len)
        var t = ByteArray(0)
        var pos = 0
        var i = 1
        while (pos < len) {
            t = hmac(prk, concat(t, info, byteArrayOf(i.toByte())))
            val n = minOf(t.size, len - pos)
            System.arraycopy(t, 0, out, pos, n)
            pos += n
            i++
        }
        return out
    }

    fun nonce(counter: Long): ByteArray = ByteBuffer.allocate(12).putInt(0).putLong(counter).array()

    fun seal(key: ByteArray, counter: Long, plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce(counter)))
        return c.doFinal(plain)
    }

    fun unseal(key: ByteArray, counter: Long, data: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce(counter)))
        return c.doFinal(data)
    }

    fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    fun unb64(s: String): ByteArray = Base64.decode(s, Base64.URL_SAFE or Base64.NO_WRAP)

    private fun pad32(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        val out = ByteArray(32)
        val n = minOf(32, b.size)
        System.arraycopy(b, b.size - n, out, 32 - n, n)
        return out
    }

    // 65-byte uncompressed point: 0x04 || x || y
    fun publicBytes(pk: PublicKey): ByteArray {
        val w = (pk as ECPublicKey).w
        return concat(byteArrayOf(4), pad32(w.affineX), pad32(w.affineY))
    }

    fun parsePublic(p: ByteArray): PublicKey {
        require(p.size == 65 && p[0] == 4.toByte()) { "bad public key" }
        val x = BigInteger(1, p.copyOfRange(1, 33))
        val y = BigInteger(1, p.copyOfRange(33, 65))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), CURVE))
    }

    fun ecdh(priv: PrivateKey, pub: PublicKey): ByteArray {
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(priv)
        ka.doPhase(pub, true)
        return ka.generateSecret()
    }

    // One connection's state. Use hello(), then acceptAck() on the reply, then auth().
    class Session(token: String) {
        private val nC: ByteArray = random(16)
        private val eph: KeyPair
        private val id: ByteArray
        private val key: ByteArray
        private var transcript: ByteArray = ByteArray(0)
        private var sendKey: ByteArray = ByteArray(0)
        private var recvKey: ByteArray = ByteArray(0)
        private var sn = 0L
        private var rn = 0L

        @Volatile
        var ready = false

        init {
            val g = KeyPairGenerator.getInstance("EC")
            g.initialize(ECGenParameterSpec("secp256r1"), SecureRandom())
            eph = g.generateKeyPair()
            val tok = utf8(token)
            id = sha256(concat(utf8("fisync/1 id"), tok))
            key = hkdf(tok, ByteArray(0), utf8("fisync/1 auth"), 32)
        }

        fun hello(): String {
            val m = JSONObject()
            m.put("t", "hello")
            m.put("v", 1)
            m.put("id", b64(id))
            m.put("eph", b64(publicBytes(eph.public)))
            m.put("n", b64(nC))
            return m.toString()
        }

        // Returns false if the computer cannot prove it knows this phone's secret.
        fun acceptAck(m: JSONObject): Boolean {
            val pubS = unb64(m.getString("eph"))
            val nS = unb64(m.getString("n"))
            val proof = unb64(m.getString("mac"))
            if (pubS.size != 65 || nS.size != 16) return false
            transcript = concat(utf8("fisync/1"), id, publicBytes(eph.public), nC, pubS, nS)
            if (!MessageDigest.isEqual(hmac(key, concat(utf8("server"), transcript)), proof)) return false
            val okm = hkdf(ecdh(eph.private, parsePublic(pubS)), concat(nC, nS), utf8("fisync/1 keys"), 64)
            sendKey = okm.copyOfRange(0, 32)
            recvKey = okm.copyOfRange(32, 64)
            return true
        }

        fun auth(): String {
            val m = JSONObject()
            m.put("t", "auth")
            m.put("mac", b64(hmac(key, concat(utf8("client"), transcript))))
            ready = true
            return m.toString()
        }

        @Synchronized
        fun encrypt(type: Int, body: ByteArray): ByteArray =
            seal(sendKey, sn++, concat(byteArrayOf(type.toByte()), body))

        @Synchronized
        fun decrypt(data: ByteArray): ByteArray = unseal(recvKey, rn++, data)
    }
}
