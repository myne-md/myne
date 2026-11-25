// SPDX-License-Identifier: AGPL-3.0-only
// Android half of the device signing key's storage (`decisions/protocol/0733`
// decision 4, rung 2 on Android; `identity-seat-portability` task 9).
//
// The device signing key is an Ed25519 + ML-DSA-65 pair minted by `protocol`, so it
// cannot LIVE in the Keystore as a signing key: the Keystore holds a non-exportable
// AES/GCM **wrapping** key and this class persists the AEAD-sealed 64-byte plaintext
// in private prefs. The wrapping key never leaves the Keystore, so the plaintext is
// never readable as a file, which is the rung's whole requirement.
//
// `setUserAuthenticationRequired(false)` is deliberate and load-bearing: a head is
// authored on a BACKGROUND sync cycle, so a biometric gate would either fail the
// cycle or prompt the user at a moment they did not choose. Keystore keys are
// inherently device-bound and non-syncing, the Android analog of the Apple
// `AfterFirstUnlockThisDeviceOnly` this rung's sibling uses.
//
// Reachable ONLY from the Rust backend (no WebView-facing command, no ACL surface),
// loaded reflectively by the Tauri PluginManager; `consumer-rules.pro` keeps it
// through R8.

package md.myne.devicekey

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SealArgs {
    /** The device-key plaintext as bytes 0..=255, so no base64 layer is invented. */
    var key: List<Int> = emptyList()
}

@TauriPlugin
class DeviceKeyPlugin(private val activity: Activity) : Plugin(activity) {

    /**
     * Read the sealed device key. Resolves `{ "key": null }` when nothing is stored,
     * the ordinary first-run state, which Rust maps to `Ok(None)` and not to a fault.
     */
    @Command
    fun open(invoke: Invoke) {
        try {
            val ret = JSObject()
            val stored = readSealed()
            if (stored == null) {
                ret.put("key", null)
            } else {
                val arr = JSArray()
                for (b in stored) arr.put(b.toInt() and 0xFF)
                ret.put("key", arr)
            }
            invoke.resolve(ret)
        } catch (e: Exception) {
            // A status/class name is not key material, so it is a safe diagnostic.
            invoke.reject(e.javaClass.simpleName + ": " + (e.message ?: "keystore failure"))
        }
    }

    /** Seal and persist the device key, replacing any previous one. */
    @Command
    fun seal(invoke: Invoke) {
        try {
            val args: SealArgs = invoke.parseArgs(SealArgs::class.java)
            val plaintext = ByteArray(args.key.size)
            for ((i, v) in args.key.withIndex()) plaintext[i] = (v and 0xFF).toByte()

            val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateWrappingKey())
            val iv = cipher.iv
            val ct = cipher.doFinal(plaintext)
            prefs().edit()
                .putString(PREF_SEALED_KEY, Base64.encodeToString(iv + ct, Base64.NO_WRAP))
                .apply()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.javaClass.simpleName + ": " + (e.message ?: "keystore failure"))
        }
    }

    /**
     * Delete the sealed key. Best-effort, like every erase on the storage ladder: the
     * caller's guarantee is about vault content, so a failure here must not fail it.
     * The wrapping key stays: deleting a Keystore entry is not something an erase needs,
     * and re-minting one costs a keystore round-trip on the next write.
     */
    @Command
    fun delete(invoke: Invoke) {
        try {
            prefs().edit().remove(PREF_SEALED_KEY).apply()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.javaClass.simpleName + ": " + (e.message ?: "keystore failure"))
        }
    }

    private fun prefs() = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

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
            // Non-biometric on purpose: a background sync cycle authors heads, so a
            // prompt here would fire at a moment the user did not choose.
            .setUserAuthenticationRequired(false)
            .build()
        generator.init(spec)
        return generator.generateKey()
    }

    /**
     * Decrypt the stored blob, treating an UNDECRYPTABLE one as absent and clearing it.
     *
     * That is the restore path, not a corruption path: `md.myne.devicekey` is excluded
     * from Auto Backup, but a device transfer on some OEM builds, or a Keystore reset
     * (lock-screen change, factory reset of the keystore, an OS upgrade that drops
     * the alias), leaves a blob whose wrapping key is gone. Failing closed to "no
     * device key" is rung 4: the person key signs `0x02` and the device re-binds on
     * its next roster read, whereas rejecting would make every load warn forever
     * about a blob nobody can remove. A device key holds no vault content, so losing
     * it costs attribution and nothing else.
     */
    private fun readSealed(): ByteArray? {
        val stored = prefs().getString(PREF_SEALED_KEY, null) ?: return null
        val blob = try {
            Base64.decode(stored, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            prefs().edit().remove(PREF_SEALED_KEY).apply()
            return null
        }
        if (blob.size <= GCM_IV_LEN) {
            prefs().edit().remove(PREF_SEALED_KEY).apply()
            return null
        }
        val iv = blob.copyOfRange(0, GCM_IV_LEN)
        val ct = blob.copyOfRange(GCM_IV_LEN, blob.size)
        return try {
            val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateWrappingKey(),
                GCMParameterSpec(GCM_TAG_BITS, iv),
            )
            cipher.doFinal(ct)
        } catch (e: java.security.GeneralSecurityException) {
            // GCM tag failure (the wrapping key changed) or a Keystore refusal. The
            // blob is worthless from here on: drop it so the next read is a clean
            // absent and the rung re-mints instead of warning on every load.
            prefs().edit().remove(PREF_SEALED_KEY).apply()
            null
        }
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        // Its OWN alias and prefs namespace, distinct from
        // `md.myne.shareimport.wrap` and any captures/quick-unlock alias: one shared
        // alias would let one family's wipe take another's key.
        const val KEY_ALIAS = "md.myne.devicekey.wrap"
        const val PREFS_NAME = "md.myne.devicekey"
        const val PREF_SEALED_KEY = "sealed-device-key"
        const val AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_IV_LEN = 12
        const val GCM_TAG_BITS = 128
    }
}
