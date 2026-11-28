// SPDX-License-Identifier: AGPL-3.0-only
// Android half of the label store's platform reach (myne-md/myne#1091,
// `decisions/clients/0795`): each vault's cached name and the account record.
//
// The Keystore cannot hold an arbitrary symmetric key exposed to the app, so this class
// holds ONE non-exportable AES/GCM **wrapping** key and persists each item as an
// AEAD-sealed blob in private prefs, keyed by its account name. The wrapping key never
// leaves the Keystore, so an item is never readable as a file, which is the rung's whole
// requirement.
//
// Its OWN alias and prefs namespace, distinct from `md.myne.devicekey.wrap`,
// `md.myne.shareimport.wrap` and any captures/quick-unlock alias: one shared alias would
// let one family's wipe take another's key.
//
// `setUserAuthenticationRequired(false)` is deliberate and load-bearing: the picker draws
// before any unlock and a background unlock re-caches a name, so a biometric gate would
// either fail that write or prompt at a moment the user did not choose. Keystore keys are
// inherently device-bound and non-syncing, the Android analog of the Apple
// `AfterFirstUnlockThisDeviceOnly` this family's sibling uses.
//
// Reachable ONLY from the Rust backend (no WebView-facing command, no ACL surface),
// loaded reflectively by the Tauri PluginManager.
//
// Deleting one item removes its blob and leaves the wrapping key and every other item:
// that is what makes a per-vault erase real on this platform.

package md.myne.labelstore

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
class ItemArgs {
    /** The account name this item is addressed by. */
    var item: String = ""
}

@InvokeArg
class SealArgs {
    var item: String = ""

    /** The item's plaintext as bytes 0..=255, so no base64 layer is invented. */
    var key: List<Int> = emptyList()
}

@TauriPlugin
class LabelStorePlugin(private val activity: Activity) : Plugin(activity) {

    /**
     * Read one item. Resolves `{ "key": null }` when nothing is stored under this name,
     * which Rust maps to `Ok(None)` and not to a fault.
     */
    @Command
    fun open(invoke: Invoke) {
        try {
            val args: ItemArgs = invoke.parseArgs(ItemArgs::class.java)
            val ret = JSObject()
            val stored = if (safeName(args.item)) readSealed(args.item) else null
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

    /** Seal and persist one item, replacing any previous bytes under this name. */
    @Command
    fun seal(invoke: Invoke) {
        try {
            val args: SealArgs = invoke.parseArgs(SealArgs::class.java)
            if (!safeName(args.item)) {
                invoke.reject("IllegalArgumentException: item name refused")
                return
            }
            val plaintext = ByteArray(args.key.size)
            for ((i, v) in args.key.withIndex()) plaintext[i] = (v and 0xFF).toByte()

            val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateWrappingKey())
            val iv = cipher.iv
            val ct = cipher.doFinal(plaintext)
            val stored = prefs().edit()
                .putString(PREF_ITEM_PREFIX + args.item, Base64.encodeToString(iv + ct, Base64.NO_WRAP))
                .commit()
            if (!stored) {
                invoke.reject("IOException: the sealed item could not be persisted")
                return
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.javaClass.simpleName + ": " + (e.message ?: "keystore failure"))
        }
    }

    /**
     * Delete one item. The wrapping key stays: deleting a Keystore entry is not something
     * an erase needs, and re-minting one costs a keystore round-trip on the next write.
     */
    @Command
    fun delete(invoke: Invoke) {
        try {
            val args: ItemArgs = invoke.parseArgs(ItemArgs::class.java)
            if (!safeName(args.item)) {
                invoke.reject("IllegalArgumentException: item name refused")
                return
            }
            // `commit`, not `apply`: the erase's guarantee is that the blob is GONE, and an
            // asynchronous write that a process death can drop would leave the name on disk
            // beside a live wrapping key while the caller reported success.
            val removed = prefs().edit().remove(PREF_ITEM_PREFIX + args.item).commit()
            if (!removed) {
                invoke.reject("IOException: the sealed item could not be removed")
                return
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.javaClass.simpleName + ": " + (e.message ?: "keystore failure"))
        }
    }

    private fun prefs() = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun keystore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    /**
     * The wrapping key IF the Keystore holds one, and nothing else. The read path uses this
     * so a missing alias answers "no item" instead of minting a key that cannot open the
     * blobs already on disk.
     */
    private fun existingWrappingKey(): SecretKey? =
        (keystore().getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey

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
            // Non-biometric on purpose: the picker reads this before any unlock, so a
            // prompt here would fire at a moment the user did not choose.
            .setUserAuthenticationRequired(false)
            .build()
        generator.init(spec)
        return generator.generateKey()
    }

    /**
     * Decrypt one item, treating an UNDECRYPTABLE blob as absent and clearing it.
     *
     * That is the restore path, not a corruption path: `md.myne.labelstore` is excluded
     * from Auto Backup, but a device transfer on some OEM builds, or a Keystore reset
     * (lock-screen change, an OS upgrade that drops the alias), leaves a blob whose
     * wrapping key is gone. Failing closed to "no cached name" shows the neutral label,
     * which is the same state the erase produces and the honest one: the name is not
     * recoverable on this device, and rejecting would warn forever about a blob nobody
     * can remove.
     */
    private fun readSealed(item: String): ByteArray? {
        val key = PREF_ITEM_PREFIX + item
        val stored = prefs().getString(key, null) ?: return null
        // A READ never mints: `getOrCreateWrappingKey` here would generate a key that cannot
        // open the blob, and the tag failure below would then be read as a stale item. The
        // wrapping key is created by the first WRITE and by nothing else.
        val wrapping = existingWrappingKey() ?: return null
        val blob = try {
            Base64.decode(stored, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            prefs().edit().remove(key).apply()
            return null
        }
        if (blob.size <= GCM_IV_LEN) {
            prefs().edit().remove(key).apply()
            return null
        }
        val iv = blob.copyOfRange(0, GCM_IV_LEN)
        val ct = blob.copyOfRange(GCM_IV_LEN, blob.size)
        return try {
            val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                wrapping,
                GCMParameterSpec(GCM_TAG_BITS, iv),
            )
            cipher.doFinal(ct)
        } catch (e: java.security.GeneralSecurityException) {
            prefs().edit().remove(key).apply()
            null
        }
    }

    /**
     * Whether a name may become a preferences key.
     *
     * Names come from `myne-core` and are a `VaultId` rendering or `account-record`, so
     * this is a belt on a caller that already cannot pass anything else. It is here
     * because the name is CONCATENATED into a preferences key, and a store that accepted
     * an arbitrary string would let one caller address another's item.
     */
    private fun safeName(item: String): Boolean {
        if (item.isEmpty() || item.length > MAX_NAME_LEN) return false
        for (c in item) {
            if (!(c.isLetterOrDigit() || c == '-')) return false
        }
        return true
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        // Its OWN alias and prefs namespace, distinct from `md.myne.devicekey.wrap`,
        // `md.myne.shareimport.wrap` and any captures/quick-unlock alias.
        const val KEY_ALIAS = "md.myne.vaultlabel.wrap"
        const val PREFS_NAME = "md.myne.labelstore"
        const val PREF_ITEM_PREFIX = "item:"
        const val MAX_NAME_LEN = 64
        const val AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_IV_LEN = 12
        const val GCM_TAG_BITS = 128
    }
}
