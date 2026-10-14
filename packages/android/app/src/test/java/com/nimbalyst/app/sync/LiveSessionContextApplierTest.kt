package com.nimbalyst.app.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.google.gson.Gson
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.NimbalystDatabase
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.ProjectEntity
import com.nimbalyst.app.data.SessionEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class LiveSessionContextApplierTest {
    private lateinit var db: NimbalystDatabase
    private lateinit var repository: NimbalystRepository
    private lateinit var applier: LiveSessionContextApplier
    private val crypto = CryptoManager.fromSeed("dGVzdC1lbmNyeXB0aW9uLWtleS1zZWVkLWZvci10ZXN0cw==", "user-test-12345")

    @Before
    fun setUp() = runTest {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        db = Room.inMemoryDatabaseBuilder(context, NimbalystDatabase::class.java).allowMainThreadQueries().build()
        repository = NimbalystRepository(db)
        applier = LiveSessionContextApplier(repository, Gson())
        db.projectDao().upsertAll(listOf(ProjectEntity(id = "/p", name = "p", sessionCount = 1, lastUpdatedAt = 1L, sortOrder = 0)))
        db.sessionDao().upsertAll(
            listOf(SessionEntity(id = "s1", projectId = "/p", createdAt = 1L, updatedAt = 2L, lastSyncedSeq = 7))
        )
    }

    @After
    fun tearDown() = db.close()

    private fun frame(sessionId: String, tokens: Int, at: Long): LiveSessionContext {
        val payload = crypto.encrypt("""{"currentContext":{"tokens":$tokens,"contextWindow":200000}}""")
        return LiveSessionContext(sessionId, payload.encrypted, payload.iv, at)
    }

    @Test
    fun `applies newer frames, rejects stale or replayed ones, and ignores unknown or unreadable sessions`() = runTest {
        applier.apply(frame("s1", 1_000, at = 100), crypto)
        applier.apply(frame("s1", 5_000, at = 300), crypto)
        // Late and replayed frames must not rewind the live reading.
        assertFalse(applier.apply(frame("s1", 2_000, at = 200), crypto))
        assertFalse(applier.apply(frame("s1", 9_000, at = 300), crypto))

        val row = repository.getSession("s1")!!
        assertEquals(5_000, row.contextTokens)
        assertEquals(200_000, row.contextWindow)
        assertEquals(7, row.lastSyncedSeq)

        assertFalse(applier.apply(frame("unknown", 1_000, at = 400), crypto))
        assertNull(repository.getSession("unknown"))
        assertFalse(applier.apply(frame("s1", 1, at = 500).copy(contextIv = "AAAAAAAAAAAAAAAA"), crypto))
        assertEquals(5_000, repository.getSession("s1")!!.contextTokens)
    }
}
