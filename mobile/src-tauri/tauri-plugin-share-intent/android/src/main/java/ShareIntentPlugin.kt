// SPDX-License-Identifier: AGPL-3.0
//
// ⚠️ DEVICE-VERIFY-PENDING — this Kotlin cannot be gradle-built in the mobile
// repo (no gradle here); it is committed source at the `tauri-plugin-screen-
// guard` bar and is verified on a real Android device via
// `dev-notes/device-matrix.md`, NOT in the change that adds it.
//
// Android inbound OS-share-sheet receiver for the share-import feature (SF3,
// MYND-511). The `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intent-filters that make
// Myne appear in the share sheet are injected onto MainActivity by the app's
// committed `src-tauri/build.rs` (image/* + application/*, no text, no
// permission) — this class only RECEIVES the delivered intent.
//
// It is loaded reflectively by the Tauri PluginManager (consumer-rules.pro keeps
// it through R8) and is reachable ONLY from the Rust backend — no WebView-facing
// command, no ACL surface. `setEventHandler` / `getOrCreateDeviceKey` are called
// via `run_mobile_plugin` (the tauri-plugin-deep-link precedent).
//
// Flow: on a share intent (cold launch → `load`; warm, singleTask → `onNewIntent`)
// read each `EXTRA_STREAM` `content://` URI OFF THE MAIN THREAD, base64 the
// bytes, and `channel.send({filename, mime, dataB64})`. The Rust bridge re-emits
// that as a global `share-intent` event; the JS half seals it via
// `plugin:share-import|seal_share`.

package md.myne.shareintent

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SetEventHandlerArgs {
    lateinit var handler: Channel
}

@TauriPlugin
class ShareIntentPlugin(private val activity: Activity) : Plugin(activity) {

    // Delivery channel handed in by the Rust backend (`setEventHandler`, the
    // deep-link precedent). Null until the backend wires it during plugin setup;
    // any share that lands before then is re-checked on the next `load`.
    private var channel: Channel? = null

    // This command is internal-only (NOT in build.rs / not exposed to the
    // WebView) — the Rust backend calls it via `run_mobile_plugin`.
    @Command
    fun setEventHandler(invoke: Invoke) {
        val args = invoke.parseArgs(SetEventHandlerArgs::class.java)
        this.channel = args.handler
        invoke.resolve()
    }

    // Cold launch: the share intent that started the activity.
    override fun load(webView: WebView) {
        super.load(webView)
        handleIntent(activity.intent)
    }

    // Warm delivery (launchMode singleTask): a share arriving while Myne is
    // already running.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val uris = extractStreamUris(intent)
        if (uris.isEmpty()) return
        // `openInputStream` reads (potentially large, up to 64 MiB) file bytes
        // and can block on a slow/remote ContentProvider — NEVER on the main
        // thread. A worker thread is enough (Channel.send is thread-safe: it
        // posts to the WebView), so no coroutine/executor dependency is needed.
        Thread {
            for (uri in uris) {
                try {
                    deliver(uri)
                } catch (e: Exception) {
                    // Best-effort per item: a single unreadable/revoked URI must
                    // not sink the rest of a multi-share batch.
                }
            }
        }.start()
    }

    @Suppress("DEPRECATION") // typed getParcelable* is API 33+; minSdk is 24.
    private fun extractStreamUris(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> {
            val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            if (uri != null) listOf(uri) else emptyList()
        }
        Intent.ACTION_SEND_MULTIPLE ->
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
        else -> emptyList()
    }

    private fun deliver(uri: Uri) {
        val resolver = activity.contentResolver
        // `readCapped` aborts (null) once the stream exceeds MAX_SHARE_BYTES, so a
        // huge/hostile content:// stream cannot OOM the app before the Rust seal
        // caps it. An over-cap item is dropped (best-effort per item, like a read
        // failure) — it never sinks the rest of a multi-share batch.
        val bytes = resolver.openInputStream(uri)?.use { readCapped(it) } ?: return
        // An empty stream would seal to nothing (the Rust `seal_share` drops it),
        // so skip it early.
        if (bytes.isEmpty()) return

        val mime = resolver.getType(uri) ?: "application/octet-stream"
        val name = displayName(resolver, uri)

        val payload = JSObject()
        payload.put("filename", name)
        payload.put("mime", mime)
        payload.put("dataB64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        channel?.send(payload)
    }

    /** Read the whole stream into memory, aborting (returning null) the moment it
     *  exceeds [MAX_SHARE_BYTES]. The ceiling is enforced during the copy — NOT
     *  from `OpenableColumns.SIZE`, which a hostile provider can under-report — so
     *  an unbounded `content://` stream cannot OOM the app before the Rust
     *  `seal_share` codec cap (64 MiB) would reject it. */
    private fun readCapped(input: InputStream): ByteArray? {
        val sink = ByteArrayOutputStream()
        val buf = ByteArray(COPY_BUF_LEN)
        var total = 0L
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > MAX_SHARE_BYTES) return null
            sink.write(buf, 0, n)
        }
        return sink.toByteArray()
    }

    // Resolve the human display name via OpenableColumns.DISPLAY_NAME, falling
    // back to the last path segment. content:// URIs rarely carry a usable path,
    // so DISPLAY_NAME is the reliable source.
    private fun displayName(resolver: ContentResolver, uri: Uri): String {
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (idx >= 0) {
                            val n = cursor.getString(idx)
                            if (!n.isNullOrBlank()) return n
                        }
                    }
                }
        } catch (e: Exception) {
            // Some providers reject the query — fall through to the path segment.
        }
        return uri.lastPathSegment ?: "shared-file"
    }

    // --- Android Keystore device-key seam (SF/SYNC-3) — see KEYSTORE_TODO.md ---
    //
    // Get-or-create the non-biometric, device-only 32-byte wrap key the
    // share-import staging queue seals under while the vault is locked (the
    // Apple-Keychain `md.myne.shareimport` provider's Android peer). Called from
    // Rust via `run_mobile_plugin` (off the main thread) — internal-only, NOT in
    // build.rs. Returns the raw key as a JSON int array (no base64 decode on the
    // Rust side).
    //
    // Envelope pattern: Android Keystore AES keys are non-exportable, so a
    // hardware-held AES/GCM *wrapping* key encrypts a locally-minted random
    // 32-byte *data* key whose ciphertext is persisted in private prefs. The
    // wrapping key never leaves the Keystore; the data key is what Rust's
    // XChaCha20-Poly1305 needs. `setUserAuthenticationRequired(false)` keeps it
    // non-biometric (a background share-seal must never prompt), and Keystore
    // keys are inherently device-bound + non-syncing (the Apple
    // `AfterFirstUnlockThisDeviceOnly` analog).
    @Command
    fun getOrCreateDeviceKey(invoke: Invoke) {
        try {
            val key = getOrCreateDataKey()
            val arr = JSONArray()
            for (b in key) arr.put(b.toInt() and 0xFF)
            val ret = JSObject()
            ret.put("key", arr)
            invoke.resolve(ret)
        } catch (e: Exception) {
            // A status/class name is not key material — safe diagnostic.
            invoke.reject(e.javaClass.simpleName + ": " + (e.message ?: "keystore failure"))
        } finally {
            // Nothing to zeroize here — the ByteArray is GC'd; Rust holds the
            // zeroizing copy.
        }
    }

    private fun keystore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun getOrCreateWrappingKey(): SecretKey {
        val ks = keystore()
        (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false) // non-biometric — no prompt
            .build()
        generator.init(spec)
        return generator.generateKey()
    }

    private fun getOrCreateDataKey(): ByteArray {
        val prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val wrappingKey = getOrCreateWrappingKey()

        prefs.getString(PREF_WRAPPED_KEY, null)?.let { stored ->
            val blob = Base64.decode(stored, Base64.NO_WRAP)
            val iv = blob.copyOfRange(0, GCM_IV_LEN)
            val ct = blob.copyOfRange(GCM_IV_LEN, blob.size)
            val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey, GCMParameterSpec(GCM_TAG_BITS, iv))
            return cipher.doFinal(ct)
        }

        // First use — mint the 32-byte data key and wrap it.
        val dataKey = ByteArray(DEVICE_KEY_LEN)
        SecureRandom().nextBytes(dataKey)
        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey)
        val iv = cipher.iv
        val ct = cipher.doFinal(dataKey)
        val blob = iv + ct
        prefs.edit()
            .putString(PREF_WRAPPED_KEY, Base64.encodeToString(blob, Base64.NO_WRAP))
            .apply()
        return dataKey
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        // Distinct from any captures/quick-unlock alias so the device-local keys
        // never collide (the Apple `md.myne.shareimport` service-string peer).
        const val KEY_ALIAS = "md.myne.shareimport.wrap"
        const val PREFS_NAME = "md.myne.shareimport"
        const val PREF_WRAPPED_KEY = "device-wrap-key"
        const val AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_IV_LEN = 12
        const val GCM_TAG_BITS = 128
        const val DEVICE_KEY_LEN = 32
        // Accept cap (matches the iOS extension's 48 MiB `maxShareBytes`, and stays
        // under the 64 MiB MYF1 codec cap). Enforced DURING the copy so a hostile
        // or lying `content://` provider cannot buffer an unbounded stream into
        // the heap (OOM/DoS) before the Rust `seal_share` would reject it.
        const val MAX_SHARE_BYTES = 48L * 1024 * 1024
        const val COPY_BUF_LEN = 64 * 1024
    }
}
