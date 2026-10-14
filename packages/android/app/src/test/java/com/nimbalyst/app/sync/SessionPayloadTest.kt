package com.nimbalyst.app.sync

import com.google.gson.Gson
import java.io.File
import java.nio.file.Files
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.*
import org.junit.Test

class SessionPayloadTest {
    private data class Fixture(val key: String, val content: String, val entry: ServerMessageEntry, val parts: List<SessionPayloadPart>)
    @Test fun `shared encrypted fixture resumes and preserves schema while refusing corrupt or incomplete content`() {
        val gson = Gson()
        val fixture = gson.fromJson(File("../../collab-protocol/fixtures/payload/encrypted-form.json").readText(), Fixture::class.java)
        val directory = Files.createTempDirectory("github-1711").toFile()
        try {
            val key = SecretKeySpec(Base64.getDecoder().decode(fixture.key), "AES")
            val decrypt: (String, String) -> String = { ciphertext, iv ->
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.getDecoder().decode(iv)))
                String(cipher.doFinal(Base64.getDecoder().decode(ciphertext)), Charsets.UTF_8)
            }
            val first = SessionPayloadStore(directory, gson)
            first.accept(fixture.parts[1], "s")
            assertTrue(runCatching { first.decrypt(fixture.entry, "s", decrypt) }.isFailure)
            val resumed = SessionPayloadStore(directory, gson)
            resumed.accept(fixture.parts[1], "s")
            resumed.accept(fixture.parts[0], "s")
            assertEquals(fixture.content, resumed.decrypt(fixture.entry, "s", decrypt))
            assertTrue(runCatching { resumed.decrypt(fixture.entry, "other", decrypt) }.isFailure)
            val corrupt = fixture.parts[0].copy(encryptedContent = "AAAA" + fixture.parts[0].encryptedContent.drop(4))
            assertTrue(runCatching { resumed.accept(corrupt, "s") }.isFailure)
            val corrupted = SessionPayloadStore(File(directory, "corrupt"), gson)
            corrupted.accept(corrupt, "s"); corrupted.accept(fixture.parts[1], "s")
            assertTrue(runCatching { corrupted.decrypt(fixture.entry, "s", decrypt) }.isFailure)
        } finally { directory.deleteRecursively() }
    }
    @Test fun `legacy or delayed projection cannot replace repaired revision`() {
        assertEquals("r:31", mergeTranscriptCursor("r:31", "r:30"))
        assertEquals("r:31", mergeTranscriptCursor("r:31", null))
        assertEquals("r:32", mergeTranscriptCursor("r:31", "r:32"))
        val repaired = SyncProjectionStamp(1, 10)
        assertTrue(repaired.isNewerThan(SyncProjectionStamp.parse(null)))
        assertFalse(SyncProjectionStamp(0, 99).isNewerThan(repaired))
        assertFalse(SyncProjectionStamp(1, 9).isNewerThan(repaired))
        assertFalse(repaired.isNewerThan(repaired))
        assertTrue(SyncProjectionStamp(1, 11).isNewerThan(repaired))
    }
}
