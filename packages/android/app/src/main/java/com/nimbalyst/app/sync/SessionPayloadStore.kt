package com.nimbalyst.app.sync

import com.google.gson.Gson
import java.io.File
import java.security.MessageDigest
import java.util.Base64

data class SessionPayloadReference(val transferId: String, val count: Int)
data class SessionPayloadPart(val transferId: String, val count: Int, val messageId: String, val index: Int, val encryptedContent: String, val iv: String)
private data class PayloadManifest(val format: String, val transferId: String, val count: Int, val messageId: String, val projectionVersion: Int, val sha256: String, val bytes: Int)
private data class PlainPart(val transferId: String, val count: Int, val messageId: String, val index: Int, val data: String)

/** Only ciphertext is staged on disk. The complete authenticated envelope is the unit of persistence. */
internal class SessionPayloadStore(private val directory: File, private val gson: Gson) {
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun file(sessionId: String, transferId: String, index: Int): File {
        require(transferId.matches(Regex("[a-f0-9]{32}")) && index in 0 until 128) { "Invalid transcript part identity" }
        return File(directory, "${hash(sessionId.toByteArray(Charsets.UTF_8))}-$transferId-$index.json")
    }

    fun accept(part: SessionPayloadPart, sessionId: String) {
        require(part.count in 1..128 && part.index in 0 until part.count && part.messageId.length in 1..256
            && part.encryptedContent.length <= 512 * 1024 && part.iv.length == 16) { "Invalid transcript part" }
        check(directory.isDirectory || directory.mkdirs()) { "Cannot create transcript staging directory" }
        val target = file(sessionId, part.transferId, part.index)
        if (target.exists()) {
            require(gson.fromJson(target.readText(), SessionPayloadPart::class.java) == part) { "Conflicting transcript part retry" }
            return
        }
        val files = directory.listFiles() ?: error("Cannot read transcript staging directory")
        var bytes = 0L
        files.forEach {
            if (it.lastModified() < System.currentTimeMillis() - 86_400_000) check(it.delete()) else bytes += it.length()
        }
        val json = gson.toJson(part)
        require(bytes + json.toByteArray(Charsets.UTF_8).size <= 25 * 1024 * 1024) { "Transcript staging quota exceeded" }
        val temporary = File(directory, "${target.name}.tmp")
        temporary.writeText(json)
        check(temporary.renameTo(target)) { "Cannot persist transcript part" }
    }

    fun release(entry: ServerMessageEntry, sessionId: String) {
        val reference = entry.payload ?: return
        repeat(reference.count.coerceIn(0, 128)) { index -> file(sessionId, reference.transferId, index).delete() }
    }

    fun decrypt(entry: ServerMessageEntry, sessionId: String, decrypt: (String, String) -> String): String {
        val plaintext = decrypt(entry.encryptedContent, entry.iv)
        val reference = entry.payload ?: return plaintext
        val manifest = gson.fromJson(plaintext, PayloadManifest::class.java)
        require(manifest.format == "session-payload-v1" && manifest.projectionVersion == 1 && manifest.messageId == entry.id
            && manifest.transferId == reference.transferId && manifest.count == reference.count
            && reference.count in 1..128 && manifest.bytes in 1..(16 * 1024 * 1024)) { "Invalid transcript manifest" }
        val output = java.io.ByteArrayOutputStream(manifest.bytes)
        repeat(reference.count) { index ->
            val part = gson.fromJson(file(sessionId, reference.transferId, index).readText(), SessionPayloadPart::class.java)
            require(part.messageId == entry.id && part.transferId == reference.transferId && part.index == index && part.count == reference.count)
            val decoded = gson.fromJson(decrypt(part.encryptedContent, part.iv), PlainPart::class.java)
            require(decoded.messageId == entry.id && decoded.transferId == reference.transferId && decoded.index == index && decoded.count == reference.count)
            val bytes = Base64.getDecoder().decode(decoded.data)
            require(bytes.size <= 128 * 1024 && output.size() + bytes.size <= manifest.bytes)
            output.write(bytes)
        }
        val bytes = output.toByteArray()
        require(bytes.size == manifest.bytes && hash(bytes) == manifest.sha256) { "Transcript integrity check failed" }
        return Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
    }
}

internal data class SyncProjectionStamp(val version: Int = 0, val revision: Long = 0) {
    fun isNewerThan(other: SyncProjectionStamp) = version > other.version || (version == other.version && revision > other.revision)
    companion object {
        fun parse(json: String?): SyncProjectionStamp = if (json == null) SyncProjectionStamp() else
            runCatching { Gson().fromJson(json, SyncProjectionStamp::class.java) }.getOrNull() ?: SyncProjectionStamp()
    }
}

data class SessionPayloadAppendPart(val type: String, val part: SessionPayloadPart)
data class SessionPayloadGetParts(val type: String, val transferId: String, val indexes: List<Int>)
data class SessionProjectionRequest(val type: String, val messageId: String)
data class SessionProjectionResponse(val type: String, val messageId: String, val revision: Long)
data class SessionPayloadReady(val type: String, val version: Int)
data class SessionPayloadPartMessage(val type: String, val part: SessionPayloadPart)
data class SessionPayloadPartAck(val type: String, val transferId: String, val index: Int)
data class SessionMessageAppendAck(val type: String, val messageId: String, val revision: Long)

internal fun mergeTranscriptCursor(previous: String?, incoming: String?): String? {
    val oldRevision = previous?.takeIf { it.startsWith("r:") }?.drop(2)?.toLongOrNull()
    val newRevision = incoming?.takeIf { it.startsWith("r:") }?.drop(2)?.toLongOrNull()
    return if (oldRevision != null) "r:${maxOf(oldRevision, newRevision ?: 0)}" else incoming ?: previous
}
