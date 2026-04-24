package fan.idea.core.services

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import fan.idea.api.FanEvent
import fan.idea.core.events.MessageListener
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

@Service(Service.Level.PROJECT)
class FanMessageService(private val project: Project) {

    private val log = Logger.getInstance(FanMessageService::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val settings: FanPluginSettings get() = FanPluginSettings.getInstance()

    private val connectionService: FanConnectionService
        get() = ApplicationManager.getApplication().getService(FanConnectionService::class.java)

    private val sessionService: FanSessionService
        get() = project.getService(FanSessionService::class.java)

    private val _isGenerating = MutableStateFlow(false)
    val isGenerating: StateFlow<Boolean> = _isGenerating.asStateFlow()

    private val _lastUserMessage = MutableStateFlow<String?>(null)
    val lastUserMessage: StateFlow<String?> = _lastUserMessage.asStateFlow()

    private var eventObserverJob: Job? = null

    suspend fun sendMessage(text: String, context: String? = null): Result<Unit> = withContext(Dispatchers.IO) {
        val client = connectionService.getApiClient(project)
            ?: return@withContext Result.failure(Exception("Not connected"))

        _lastUserMessage.value = text

        try {
            val sessionId = sessionService.currentSessionId.value ?: run {
                val result = sessionService.createSession()
                if (result.isFailure) return@withContext Result.failure(result.exceptionOrNull()!!)
                result.getOrThrow()
            }

            val fullMessage = if (context != null) {
                "$context\n\n$text"
            } else {
                text
            }

            val sendResult = client.sendMessage(sessionId, fullMessage)
            if (sendResult.isFailure) return@withContext Result.failure(sendResult.exceptionOrNull()!!)

            connectionService.connectWs(project, sessionId)
            settings.lastSessionId = sessionId

            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun stopGeneration() {
        connectionService.disconnectWs(project)
        _isGenerating.value = false
        publishGeneratingChanged(false)
    }

    fun startObserving() {
        if (eventObserverJob?.isActive == true) return
        val events: SharedFlow<FanEvent> = connectionService.getEvents(project) ?: return

        eventObserverJob = scope.launch {
            events.collect { event ->
                handleMessageEvent(event)
            }
        }
        log.info("Started observing WS events")
    }

    fun stopObserving() {
        eventObserverJob?.cancel()
        eventObserverJob = null
    }

    fun dispose() {
        stopObserving()
        scope.cancel()
    }

    private fun handleMessageEvent(event: FanEvent) {
        when (event) {
            is FanEvent.AgentStart -> {
                _isGenerating.value = true
                publishGeneratingChanged(true)
            }
            is FanEvent.AgentEnd -> {
                _isGenerating.value = false
                publishGeneratingChanged(false)
                scope.launch { sessionService.refreshSessions() }
            }
            else -> { }
        }
        publishMessageReceived(event)
    }

    private fun publishMessageReceived(event: FanEvent) {
        try {
            project.messageBus.syncPublisher(MessageListener.TOPIC).onMessageReceived(event)
        } catch (e: Exception) {
            log.info("Failed to publish message event: ${e.message}")
        }
    }

    private fun publishGeneratingChanged(isGenerating: Boolean) {
        try {
            project.messageBus.syncPublisher(MessageListener.TOPIC).onGeneratingChanged(isGenerating)
        } catch (e: Exception) {
            log.info("Failed to publish generating state: ${e.message}")
        }
    }
}
