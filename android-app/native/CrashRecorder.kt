package com.fisync.app

import java.io.File
import java.util.Date

// Writes uncaught errors to a file on the phone. Nothing is sent anywhere; you can export it yourself.
object CrashRecorder {
    private var installed = false

    fun install(dir: File) {
        if (installed) return
        installed = true
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                File(dir, "crash.log").appendText("${Date()}\t${error.stackTraceToString()}\n\n")
            } catch (e: Exception) {
                // nothing else to do
            }
            previous?.uncaughtException(thread, error)
        }
    }
}
