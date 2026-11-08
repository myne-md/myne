// SPDX-License-Identifier: AGPL-3.0
//
// ⚠️ DEVICE-VERIFY-PENDING. The effect of this Kotlin on a real handset is owed
// to `myne-agents/docs/dev/device-matrix.md` §8 row 8.8, NOT to the change that adds it. The
// module compiles against the generated gradle project; no CI lane in this repo
// runs an Android device.
//
// Android OUTBOUND "hand the user the file" bridge (myne-md/myne#505). Every
// mobile export writes into the app's own Documents directory
// (`getExternalFilesDir(DIRECTORY_DOCUMENTS)`), which the system Files app has
// refused to open since Android 11 (API 30) while `minSdk` is 24. Before this the
// write WAS the delivery and nothing delivered. `ACTION_CREATE_DOCUMENT` is
// the platform's own "where do you want this?" dialog: the user picks a
// destination and the bytes are written there.
//
// Loaded reflectively by the Tauri PluginManager (consumer-rules.pro keeps it
// through R8) and reachable ONLY from the Rust backend. There is no WebView-facing
// command, no ACL surface. `saveFile` is called via `run_mobile_plugin` from
// `src-tauri/src/share_file.rs` (the deep-link precedent).
//
// Flow: launch the picker, and on its result copy the file to the chosen
// document OFF THE MAIN THREAD (an attachment can be large, and a whole-vault
// markdown export is a directory that is zipped first). The invoke resolves once
// the copy is done, with `{saved, cancelled, error}`. `cancelled` is a user
// decision, not a failure, and the app's own copy is kept for both.

package md.myne.savefile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

@InvokeArg
class SaveFileArgs {
    lateinit var path: String
    lateinit var mime: String
    lateinit var suggestedName: String

    // Decided in Rust (`share_file::destination_hint`) rather than re-derived
    // here from `File(path).isDirectory`. Two copies of that question can
    // disagree, and the disagreement would be a document whose name and type
    // promise one shape while its bytes are the other.
    var zips: Boolean = false
}

@TauriPlugin
class SaveFilePlugin(private val activity: Activity) : Plugin(activity) {

    // A temporary archive survives a process kill: `finally` covers every exit
    // this process lives through, and a swipe-away or an OOM kill is not one.
    // The archive holds every note in plaintext, so the next launch sweeps it
    // BEFORE any export runs. Cheap (a directory listing) and off the main
    // thread, because it is startup work on a client that must paint first.
    override fun load(webView: WebView) {
        super.load(webView)
        Thread {
            try {
                activity.cacheDir.listFiles()
                    ?.filter { it.name.startsWith(ARCHIVE_PREFIX) && it.name.endsWith(ARCHIVE_SUFFIX) }
                    ?.forEach { it.delete() }
            } catch (e: Exception) {
                // A failed sweep costs one stale archive, never a crash.
            }
        }.start()
    }

    // Internal-only (NOT in the plugin build.rs / not exposed to the WebView):
    // the Rust backend calls it via `run_mobile_plugin`.
    @Command
    fun saveFile(invoke: Invoke) {
        val args = invoke.parseArgs(SaveFileArgs::class.java)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = args.mime
            putExtra(Intent.EXTRA_TITLE, args.suggestedName)
        }
        // The lambda-style callback name is what `startActivityForResult` resolves
        // through `@ActivityCallback`; the invoke is carried through so the args
        // (path/mime/name) are still readable here.
        startActivityForResult(invoke, intent, "onCreateDocument")
    }

    @ActivityCallback
    fun onCreateDocument(invoke: Invoke, result: ActivityResult) {
        val args = invoke.parseArgs(SaveFileArgs::class.java)
        val target: Uri? = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || target == null) {
            // A dismissed picker is a decision, not an error: the caller reports
            // it as cancelled and the app's own copy of the export stays put.
            invoke.resolve(outcome(saved = false, cancelled = true, error = null))
            return
        }
        // Copying can be large and can block on a slow/remote provider, so NEVER on
        // the main thread. A worker thread is enough (the response channel is
        // thread-safe), so no coroutine/executor dependency is needed.
        Thread {
            try {
                val source = File(args.path)
                if (args.zips) {
                    writeZip(source, target)
                } else {
                    activity.contentResolver.openOutputStream(target)?.use { output ->
                        source.inputStream().use { it.copyTo(output, COPY_BUF_LEN) }
                    } ?: throw IOException("the chosen document has no output stream")
                }
                invoke.resolve(outcome(saved = true, cancelled = false, error = null))
            } catch (e: Exception) {
                // Class name only: this string reaches the diagnostic log, and the
                // export's path and filename are never named there.
                invoke.resolve(outcome(saved = false, cancelled = false, error = e.javaClass.simpleName))
            }
        }.start()
    }

    // `ACTION_CREATE_DOCUMENT` saves exactly ONE document, so a directory export
    // (the whole-vault markdown tree) is zipped into the app cache first. The
    // archive holds every note in plaintext, so it is deleted on every path this
    // process survives, which is why the removal is in `finally`; `load` sweeps
    // what a process kill leaves behind.
    private fun writeZip(source: File, target: Uri) {
        val archive = File.createTempFile(ARCHIVE_PREFIX, ARCHIVE_SUFFIX, activity.cacheDir)
        try {
            ZipOutputStream(archive.outputStream().buffered()).use { zip ->
                val root = source.absolutePath
                source.walkTopDown().forEach { file ->
                    if (file == source) return@forEach
                    val entryName = file.absolutePath.removePrefix(root).removePrefix(File.separator)
                    if (file.isDirectory) {
                        zip.putNextEntry(ZipEntry("$entryName/"))
                        zip.closeEntry()
                    } else {
                        zip.putNextEntry(ZipEntry(entryName))
                        file.inputStream().use { it.copyTo(zip, COPY_BUF_LEN) }
                        zip.closeEntry()
                    }
                }
            }
            activity.contentResolver.openOutputStream(target)?.use { output ->
                archive.inputStream().use { it.copyTo(output, COPY_BUF_LEN) }
            } ?: throw IOException("the chosen document has no output stream")
        } finally {
            archive.delete()
        }
    }

    private fun outcome(saved: Boolean, cancelled: Boolean, error: String?): JSObject {
        val result = JSObject()
        result.put("saved", saved)
        result.put("cancelled", cancelled)
        if (error != null) result.put("error", error)
        return result
    }

    private companion object {
        const val COPY_BUF_LEN = 64 * 1024
        // `File.createTempFile` appends random characters, so the sweep matches a
        // prefix and suffix rather than the name.
        const val ARCHIVE_PREFIX = "myne-export"
        const val ARCHIVE_SUFFIX = ".zip"
    }
}
