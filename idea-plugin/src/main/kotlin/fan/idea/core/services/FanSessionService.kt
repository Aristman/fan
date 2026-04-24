package fan.idea.core.services

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import fan.idea.api.SessionMessage
import fan.idea.api.SessionSummary
import fan.idea.core.events.SessionListener
import fan.idea.settings.FanPluginSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

@Service(Service.Level.PROJECT)
class FanSessionService(private val project: Project) {

    private val log = Logger.getInstance(FanSessionService::class.java)
    private val settings: FanPluginSettings get() = FanPluginSettings.getInstance()

    private val connectionService: FanConnectionService
        get() = ApplicationManager.getApplication().getService(FanConnectionService::class.java)

    private val _sessions = MutableStateFlow<List<SessionSummary>>(emptyList())
    val sessions: StateFlow<List<SessionSummary>> = _sessions.asStateFlow()

    private val _currentSessionId = MutableStateFlow<String?>(null)
    val currentSessionId: StateFlow<String?> = _currentSessionId.asStateFlow()

    suspend fun loadSessions(): Result<Unit> = withContext(Dispatchers.IO) {
        val client = connectionService.getApiClient(project)
            ?: return@withContext Result.failure(Exception("Not connected"))

        val result = client.listSessions()
        if (result.isSuccess) {
            val projectPath = project.basePath ?: ""
            _sessions.value = filterSessionsForProject(result.getOrThrow().sessions, projectPath)
            log.info("Loaded ${_sessions.value.size} sessions for project")
            publishSessionsUpdated()
        }
        result.map { }
    }

    suspend fun createSession(title: String? = null): Result<String> = withContext(Dispatchers.IO) {
        val client = connectionService.getApiClient(project)
            ?: return@withContext Result.failure(Exception("Not connected"))

        val result = client.createSession(title)
        if (result.isFailure) return@withContext Result.failure(result.exceptionOrNull()!!)

        val session = result.getOrThrow()
        refreshSessions()
        _currentSessionId.value = session.id
        settings.lastSessionId = session.id

        val summary = SessionSummary(
            id = session.id,
            title = session.title,
            model = session.model,
            provider = session.provider,
            createdAt = session.createdAt,
            updatedAt = session.updatedAt,
            messageCount = 0,
            sessionFile = null
        )
        publishSessionCreated(summary)

        Result.success(session.id)
    }

    suspend fun selectSession(sessionId: String): Result<Unit> = withContext(Dispatchers.IO) {
        val client = connectionService.getApiClient(project)
            ?: return@withContext Result.failure(Exception("Not connected"))

        try {
            connectionService.disconnectWs(project)

            val result = client.getSession(sessionId)
            if (result.isFailure) return@withContext Result.failure(result.exceptionOrNull()!!)

            _currentSessionId.value = sessionId
            settings.lastSessionId = sessionId

            connectionService.connectWs(project, sessionId)

            val session = _sessions.value.find { it.id == sessionId }
            if (session != null) {
                publishSessionSelected(session)
            }

            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun deleteSession(sessionId: String): Result<Unit> = withContext(Dispatchers.IO) {
        val client = connectionService.getApiClient(project)
            ?: return@withContext Result.failure(Exception("Not connected"))

        val result = client.deleteSession(sessionId)
        if (result.isFailure) return@withContext Result.failure(result.exceptionOrNull()!!)

        _sessions.value = _sessions.value.filter { it.id != sessionId }
        publishSessionsUpdated()
        publishSessionDeleted(sessionId)

        if (_currentSessionId.value == sessionId) {
            connectionService.disconnectWs(project)
            _currentSessionId.value = null
            settings.lastSessionId = null
        }

        Result.success(Unit)
    }

    suspend fun refreshSessions(): Result<Unit> = withContext(Dispatchers.IO) {
        val client = connectionService.getApiClient(project)
            ?: return@withContext Result.failure(Exception("Not connected"))

        val result = client.listSessions()
        if (result.isSuccess) {
            val projectPath = project.basePath ?: ""
            _sessions.value = filterSessionsForProject(result.getOrThrow().sessions, projectPath)
            publishSessionsUpdated()
        }
        result.map { }
    }

    suspend fun getSessionMessages(): Result<List<SessionMessage>> = withContext(Dispatchers.IO) {
        val client = connectionService.getApiClient(project)
            ?: return@withContext Result.failure(Exception("Not connected"))
        val sessionId = _currentSessionId.value
            ?: return@withContext Result.failure(Exception("No session"))

        val result = client.getSession(sessionId)
        if (result.isFailure) return@withContext Result.failure(result.exceptionOrNull()!!)

        Result.success(result.getOrThrow().messages)
    }

    fun navigateToSessionList() {
        connectionService.disconnectWs(project)
        _currentSessionId.value = null
    }

    fun dispose() {
        _sessions.value = emptyList()
        _currentSessionId.value = null
    }

    private fun filterSessionsForProject(
        sessions: List<SessionSummary>,
        projectPath: String
    ): List<SessionSummary> {
        if (projectPath.isBlank()) return sessions
        val encodedCwd = "--${projectPath.removePrefix("/").replace("/", "-").replace(":", "-")}--"
        return sessions.filter { session ->
            val file = session.sessionFile ?: return@filter false
            file.contains(encodedCwd)
        }
    }

    private fun publishSessionCreated(session: SessionSummary) {
        try {
            project.messageBus.syncPublisher(SessionListener.TOPIC).onSessionCreated(session)
        } catch (e: Exception) {
            log.info("Failed to publish session created: ${e.message}")
        }
    }

    private fun publishSessionDeleted(id: String) {
        try {
            project.messageBus.syncPublisher(SessionListener.TOPIC).onSessionDeleted(id)
        } catch (e: Exception) {
            log.info("Failed to publish session deleted: ${e.message}")
        }
    }

    private fun publishSessionSelected(session: SessionSummary) {
        try {
            project.messageBus.syncPublisher(SessionListener.TOPIC).onSessionSelected(session)
        } catch (e: Exception) {
            log.info("Failed to publish session selected: ${e.message}")
        }
    }

    private fun publishSessionsUpdated() {
        try {
            project.messageBus.syncPublisher(SessionListener.TOPIC).onSessionsUpdated(_sessions.value)
        } catch (e: Exception) {
            log.info("Failed to publish sessions updated: ${e.message}")
        }
    }
}
