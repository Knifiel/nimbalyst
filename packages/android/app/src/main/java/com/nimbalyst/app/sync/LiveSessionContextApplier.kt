package com.nimbalyst.app.sync

import android.util.Log
import com.google.gson.Gson
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.NimbalystRepository
import java.util.concurrent.ConcurrentHashMap

/**
 * Applies `sessionContextBroadcast`: the desktop's live context-window usage,
 * relayed mid-turn by the server without being stored. The index row still
 * carries the turn-end value, so this only keeps the context % live between
 * turn boundaries.
 *
 * Caveat: only the `contextTokens`/`contextWindow` columns change.
 * `SessionStatePublisher` re-encrypts from `clientMetadataBase`, so that blob
 * keeps the previous turn's `currentContext` until the desktop's turn-end
 * index write replaces it.
 */
internal class LiveSessionContextApplier(
    private val repository: NimbalystRepository,
    private val gson: Gson,
) {
    private companion object {
        const val TAG = "LiveSessionContext"
    }

    /** Last applied `at` per session. In memory: a frame is only meaningful while a turn runs. */
    private val lastAppliedAt = ConcurrentHashMap<String, Long>()

    /** Returns whether the frame was written to the local session row. */
    suspend fun apply(update: LiveSessionContext, crypto: CryptoManager): Boolean {
        val last = lastAppliedAt[update.sessionId]
        if (last != null && update.at <= last) return false
        // Display-only data the next frame or the turn-end index write replaces,
        // so a frame we cannot read is dropped rather than reported.
        val json = crypto.decryptOrNull(update.encryptedContext, update.contextIv) ?: run {
            Log.w(TAG, "Dropping unreadable context frame for ${update.sessionId}")
            return false
        }
        val context = gson.parseOrNull<ClientMetadata>(json, TAG)?.currentContext ?: return false
        // A session not in the local DB is not ours to create from a relay frame.
        if (!repository.updateLiveContext(update.sessionId, context.tokens, context.contextWindow)) return false
        lastAppliedAt[update.sessionId] = update.at
        return true
    }
}
