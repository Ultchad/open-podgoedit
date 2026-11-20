package dev.openpodgo.edit

import android.os.Environment
import android.util.Base64
import android.webkit.JavascriptInterface
import java.io.File

/**
 * File bridge for the page: `window.podgoAndroidFiles`.
 *
 * A WebView cannot save a `blob:` link, so exports (presets, backups) are
 * written here into the app's own Downloads folder instead of the user's
 * shared storage, which keeps them with the app and needs no permission on any
 * supported Android version.
 */
class PodgoFileBridge(private val activity: MainActivity) {

    /** Write `base64` as `name`; rejects (throws) on failure. */
    @JavascriptInterface
    fun save(name: String, base64: String) {
        val safeName = sanitize(name)
        val bytes = Base64.decode(base64, Base64.NO_WRAP)
        val directory = File(
            activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                ?: activity.filesDir,
            "exports",
        )
        directory.mkdirs()
        val target = File(directory, safeName)
        target.writeBytes(bytes)
        activity.notifySaved(target.absolutePath)
    }

    companion object {
        const val JS_NAME = "podgoAndroidFiles"

        /** Strip separators so a crafted name cannot leave the exports folder. */
        fun sanitize(name: String): String {
            val base = name.substringAfterLast('/').substringAfterLast('\\')
            val cleaned = base.filter { it.isLetterOrDigit() || it in "._- " }.trim()
            return if (cleaned.isEmpty()) "podgo-export.bin" else cleaned.take(120)
        }
    }
}
