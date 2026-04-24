package fan.idea

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import fan.idea.api.*
import fan.idea.settings.FanPluginSettings
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

class FanPlugin(private val project: Project) {
    private val log = Logger.getInstance(FanPlugin::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val settings: FanPluginSettings get() = FanPluginSettings.getInstance()
    private val serverDetector = ServerDetector()

    // Clients — lazy, created on connect
    private var apiClient: FanApiClient? = null
    private var wsClient: FanWsClient? = null

    // State
    private val _connectionStatus = MutableStateFlow(ConnectionStatus.DISCONNECTED)
    val connectionStatus: StateFlow<ConnectionStatus> = _connectionStatus.asStateFlow()

    private val _currentSessionId = MutableStateFlow<String?>(null)
    val currentSessionId: StateFlow<String?> = _currentSessionId.asStateFlow()

    private val _sessions = MutableStateFlow<List<SessionSummary>>(emptyList())
    val sessions: StateFlow<List<SessionSummary>> = _sessions.asStateFlow()

    private val _events = MutableSharedFlow<FanEvent>(extraBufferCapacity = 256)
    val events: SharedFlow<FanEvent> = _events.asSharedFlow()

    private val _isGenerating = MutableStateFlow(false)
    val isGenerating: StateFlow<Boolean> = _isGenerating.asStateFlow()

    // Current assistant message being streamed
    private var currentAssistantText = StringBuilder()
    private var currentThinkingText = StringBuilder()

    init {
        // Merge WS events into our event flow
        scope.launch {
            wsClient?.events?.collect { event ->
                _events.emit(event)
                when (event) {
                    is FanEvent.AgentStart -> _isGenerating.value = true
                    is FanEvent.AgentEnd -> {
                        _isGenerating.value = false
                        currentAssistantText.clear()
                        currentThinkingText.clear()
                    }
                    is FanEvent.TextDelta -> currentAssistantText.append(event.delta)
                    is FanEvent.ThinkingDelta -> currentThinkingText.append(event.delta)
                    else -> {}
                }
            }
        }

        // Merge WS connection state
        scope.launch {
            wsClient?.connectionState?.collect { status ->
                _connectionStatus.value = status
            }
        }
    }

    /**
     * Connect to FAN Server. Auto-detects from server.json or uses manual settings.
     */
    suspend fun connect(): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            _connectionStatus.value = ConnectionStatus.CONNECTING

            // Try auto-detection first
            val config = serverDetector.readServerConfig()
            val baseUrl: String
            val token: String

            if (config != null) {
                baseUrl = serverDetector.getBaseUrl(config)
                token = config.token?.takeIf { it.isNotBlank() } ?: settings.authToken
            } else {
                baseUrl = settings.serverUrl
                token = settings.authToken
            }

            if (token.isBlank()) {
                // Create a new token
                val tempClient = FanApiClient(baseUrl)
                val tokenResult = tempClient.createToken("IntelliJ")
                if (tokenResult.isFailure) {
                    _connectionStatus.value = ConnectionStatus.ERROR
                    return@withContext Result.failure(tokenResult.exceptionOrNull()
                        ?: Exception("Failed to create auth token"))
                }
                val newToken = tokenResult.getOrThrow().token.token
                settings.authToken = newToken
                token = newToken
            }

            // Create API client and health check
            apiClient = FanApiClient(baseUrl, token)
            val healthResult = apiClient!!.healthCheck()
            if (healthResult.isFailure) {
                _connectionStatus.value = ConnectionStatus.ERROR
                return@withContext Result.failure(healthResult.exceptionOrNull()
                    ?: Exception("Health check failed"))
            }

            log.info("Connected to FAN Server at $baseUrl (status: ${healthResult.getOrThrow().status})")

            // Create WS client
            wsClient = FanWsClient()

            // Observe WS events
            launchEventObserver()

            // Load sessions
            val sessionsResult = apiClient!!.listSessions()
            if (sessionsResult.isSuccess) {
                _sessions.value = sessionsResult.getOrThrow().sessions
            }

            // Restore last session
            val lastSessionId = settings.lastSessionId
            if (lastSessionId != null && _sessions.value.any { it.id == lastSessionId }) {
                switchSession(lastSessionId)
            }

            _connectionStatus.value = ConnectionStatus.CONNECTED
            Result.success(Unit)
        } catch (e: Exception) {
            log.warn("Failed to connect: ${e.message}")
            _connectionStatus.value = ConnectionStatus.ERROR
            Result.failure(e)
        }
    }

    /**
     * Send a message to the current session. Creates a new session if none is active.
     */
    suspend fun sendMessage(text: String, context: String? = null): Result<Unit> = withContext(Dispatchers.IO) {
        val client = apiClient ?: return@withContext Result.failure(Exception("Not connected"))

        try {
            // Create session if needed
            val sessionId = _currentSessionId.value ?: run {
                val result = client.createSession()
                if (result.isFailure) return@withContext Result.failure(result.exceptionOrNull()!!)
                val session = result.getOrThrow()
                _currentSessionId.value = session.id
                session.id
            }

            // Build message with optional context
            val fullMessage = if (context != null) {
                "$context\n\n$text"
            } else {
                text
            }

            currentAssistantText.clear()
            currentThinkingText.clear()

            val result = client.sendMessage(sessionId, fullMessage)
            if (result.isFailure) return@withContext Result.failure(result.exceptionOrNull()!!)

            // Connect WS to this session for streaming
            val config = serverDetector.readServerConfig()
            val baseUrl = config?.let { serverDetector.getBaseUrl(it) } ?: settings.serverUrl
            val wsUrl = serverDetector.getWsUrl(config ?: ServerConfig(port = 3456), sessionId)
            wsClient?.connect(wsUrl, sessionId, settings.authToken)

            settings.lastSessionId = sessionId
            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Switch to an existing session. Loads message history.
     */
    suspend fun switchSession(sessionId: String): Result<Unit> = withContext(Dispatchers.IO) {
        val client = apiClient ?: return@withContext Result.failure(Exception("Not connected"))

        try {
            // Disconnect current WS
            wsClient?.disconnect()

            // Load session history
            val result = client.getSession(sessionId)
            if (result.isFailure) {
                return@withContext Result.failure(result.exceptionOrNull()!!)
            }

            _currentSessionId.value = sessionId
            settings.lastSessionId = sessionId

            // Connect WS to new session
            val config = serverDetector.readServerConfig()
            val wsUrl = serverDetector.getWsUrl(config ?: ServerConfig(port = 3456), sessionId)
            wsClient?.connect(wsUrl, sessionId, settings.authToken)

            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Delete a session.
     */
    suspend fun deleteSession(sessionId: String): Result<Unit> = withContext(Dispatchers.IO) {
        val client = apiClient ?: return@withContext Result.failure(Exception("Not connected"))

        val result = client.deleteSession(sessionId)
        if (result.isFailure) return@withContext Result.failure(result.exceptionOrNull()!!)

        // Remove from list
        _sessions.value = _sessions.value.filter { it.id != sessionId }

        // If deleted current session, clear
        if (_currentSessionId.value == sessionId) {
            wsClient?.disconnect()
            _currentSessionId.value = null
            settings.lastSessionId = null
        }

        Result.success(Unit)
    }

    /**
     * Create a new session explicitly (without sending a message).
     */
    suspend fun createSession(title: String? = null): Result<String> = withContext(Dispatchers.IO) {
        val client = apiClient ?: return@withContext Result.failure(Exception("Not connected"))

        val result = client.createSession(title)
        if (result.isFailure) return@withContext Result.failure(result.exceptionOrNull()!!)

        val session = result.getOrThrow()

        // Refresh session list
        refreshSessions()

        _currentSessionId.value = session.id
        settings.lastSessionId = session.id

        Result.success(session.id)
    }

    /**
     * Refresh the session list from server.
     */
    suspend fun refreshSessions(): Result<Unit> = withContext(Dispatchers.IO) {
        val client = apiClient ?: return@withContext Result.failure(Exception("Not connected"))

        val result = client.listSessions()
        if (result.isSuccess) {
            _sessions.value = result.getOrThrow().sessions
        }
        result.map { }
    }

    /**
     * Get message history for the current session.
     */
    suspend fun getSessionMessages(): Result<List<SessionMessage>> = withContext(Dispatchers.IO) {
        val client = apiClient ?: return@withContext Result.failure(Exception("Not connected"))
        val sessionId = _currentSessionId.value ?: return@withContext Result.failure(Exception("No session"))

        val result = client.getSession(sessionId)
        if (result.isFailure) return@withContext Result.failure(result.exceptionOrNull()!!)

        Result.success(result.getOrThrow().messages)
    }

    /**
     * Stop the current generation.
     */
    fun stopGeneration() {
        wsClient?.disconnect()
        _isGenerating.value = false
    }

    /**
     * Disconnect from server.
     */
    fun disconnect() {
        wsClient?.disconnect()
        _connectionStatus.value = ConnectionStatus.DISCONNECTED
    }

    /**
     * Navigate back to session list (disconnect WS).
     */
    fun navigateToSessionList() {
        wsClient?.disconnect()
        _currentSessionId.value = null
    }

    /**
     * Check if server.json exists (for Welcome screen decision).
     */
    fun isServerAvailable(): Boolean = serverDetector.hasServerJson()

    /**
     * Start FAN Server and then connect.
     */
    suspend fun startServerAndConnect(): Result<Unit> = withContext(Dispatchers.IO) {
        val started = serverDetector.startServer()
        if (!started) {
            return@withContext Result.failure(Exception("Failed to start FAN Server"))
        }

        // Wait for server to be ready (health check with retries)
        var retries = 0
        val maxRetries = 10
        while (retries < maxRetries) {
            delay(1000)
            val config = serverDetector.readServerConfig()
            if (config != null) {
                val client = FanApiClient(serverDetector.getBaseUrl(config))
                val health = client.healthCheck()
                if (health.isSuccess) {
                    return@withContext connect()
                }
            }
            retries++
        }

        Result.failure(Exception("Server did not start within ${maxRetries}s"))
    }

    private fun launchEventObserver() {
        scope.launch {
            wsClient?.events?.collect { event ->
                _events.emit(event)
                when (event) {
                    is FanEvent.AgentStart -> _isGenerating.value = true
                    is FanEvent.AgentEnd -> {
                        _isGenerating.value = false
                        currentAssistantText.clear()
                        currentThinkingText.clear()
                        refreshSessions() // Refresh session list to update message counts
                    }
                    is FanEvent.TextDelta -> currentAssistantText.append(event.delta)
                    is FanEvent.ThinkingDelta -> currentThinkingText.append(event.delta)
                    else -> {}
                }
            }
        }

        scope.launch {
            wsClient?.connectionState?.collect { status ->
                _connectionStatus.value = status
            }
        }
    }

    fun dispose() {
        wsClient?.destroy()
        scope.cancel()
    }
}
