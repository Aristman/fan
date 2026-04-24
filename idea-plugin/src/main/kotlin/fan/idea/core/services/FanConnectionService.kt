package fan.idea.core.services

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import fan.idea.api.ConnectionStatus
import fan.idea.api.FanApiClient
import fan.idea.api.FanEvent
import fan.idea.api.FanWsClient
import fan.idea.core.events.ConnectionListener
import fan.idea.settings.FanPluginSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap

@Service(Service.Level.APP)
class FanConnectionService {

    private val log = Logger.getInstance(FanConnectionService::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private data class ProjectConnection(
        val apiClient: FanApiClient,
        val wsClient: FanWsClient,
        val _connectionStatus: MutableStateFlow<ConnectionStatus>,
        val baseUrl: String,
        val statusObserverJob: Job
    )

    private val connections = ConcurrentHashMap<Project, ProjectConnection>()

    suspend fun connect(project: Project, port: Int): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            disposeConnection(project)

            val settings = FanPluginSettings.getInstance()
            val baseUrl = "http://localhost:$port"
            val token = if (!settings.authToken.isNullOrBlank()) settings.authToken else ""

            val statusFlow = MutableStateFlow(ConnectionStatus.CONNECTING)
            val apiClient = FanApiClient(baseUrl, token)

            val healthResult = apiClient.healthCheck()
            if (healthResult.isFailure) {
                statusFlow.value = ConnectionStatus.ERROR
                val error = healthResult.exceptionOrNull() ?: Exception("Health check failed")
                log.info("Health check failed for $baseUrl: ${error.message}")
                publishConnectionError(error.message ?: "Health check failed")
                return@withContext Result.failure(error)
            }

            log.info("Connected to FAN Server at $baseUrl")

            val wsClient = FanWsClient()

            val observerJob = scope.launch {
                wsClient.connectionState.collect { status ->
                    statusFlow.value = status
                    publishConnectionStateChanged(status)
                }
            }

            connections[project] = ProjectConnection(apiClient, wsClient, statusFlow, baseUrl, observerJob)

            statusFlow.value = ConnectionStatus.CONNECTED
            publishConnectionStateChanged(ConnectionStatus.CONNECTED)

            Result.success(Unit)
        } catch (e: Exception) {
            log.info("Failed to connect: ${e.message}")
            publishConnectionError(e.message ?: "Unknown error")
            Result.failure(e)
        }
    }

    fun connectWs(project: Project, sessionId: String) {
        val settings = FanPluginSettings.getInstance()
        val conn = connections[project] ?: return
        val port = settings.serverPort
        val wsUrl = "ws://localhost:$port/api/ws/$sessionId"
        conn.wsClient.connect(wsUrl, sessionId, settings.authToken ?: "")
    }

    fun disconnectWs(project: Project) {
        connections[project]?.wsClient?.disconnect()
    }

    fun disposeConnection(project: Project) {
        val conn = connections.remove(project) ?: return
        conn.statusObserverJob.cancel()
        conn.wsClient.destroy()
        log.info("Disposed connection for project")
    }

    fun getConnectionStatus(project: Project): StateFlow<ConnectionStatus> {
        return connections[project]?._connectionStatus?.asStateFlow()
            ?: MutableStateFlow(ConnectionStatus.DISCONNECTED).asStateFlow()
    }

    fun getApiClient(project: Project): FanApiClient? = connections[project]?.apiClient

    fun getWsClient(project: Project): FanWsClient? = connections[project]?.wsClient

    fun getEvents(project: Project): SharedFlow<FanEvent>? = connections[project]?.wsClient?.events

    fun getBaseUrl(project: Project): String? = connections[project]?.baseUrl

    private fun publishConnectionStateChanged(status: ConnectionStatus) {
        try {
            ApplicationManager.getApplication().messageBus
                .syncPublisher(ConnectionListener.TOPIC)
                .onConnectionStateChanged(status)
        } catch (e: Exception) {
            log.info("Failed to publish connection state: ${e.message}")
        }
    }

    private fun publishConnectionError(message: String) {
        try {
            ApplicationManager.getApplication().messageBus
                .syncPublisher(ConnectionListener.TOPIC)
                .onConnectionError(message)
        } catch (e: Exception) {
            log.info("Failed to publish connection error: ${e.message}")
        }
    }

    fun dispose() {
        connections.keys.toList().forEach { disposeConnection(it) }
        scope.cancel()
    }
}
