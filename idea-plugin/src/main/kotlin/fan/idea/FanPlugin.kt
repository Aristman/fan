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

    private val _lastUserMessage = MutableStateFlow<String?>(null)
    val lastUserMessage: StateFlow<String?> = _lastUserMessage.asStateFlow()

    // Current assistant message being streamed
    private var currentAssistantText = StringBuilder()
    private var currentThinkingText = StringBuilder()

    init {
        // Dead coroutines removed — wsClient is null at init time.
        // Real event observers are started in launchEventObserver() called from connect().
    }

    /**
     * Connect to FAN Server using the per-project port from settings.
     * For local connections, token is auto-provisioned silently without user interaction.
     */
    suspend fun connect(port: Int = settings.serverPort): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            _connectionStatus.value = ConnectionStatus.CONNECTING

            val baseUrl = "http://localhost:$port"

            // Detect if local (always local for per-project servers)
            settings.isLocalConnection = true

            // Local server — empty token (FAN_NO_AUTH mode)
            val token = if (!settings.authToken.isNullOrBlank()) {
                settings.authToken
            } else {
                ""
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
            } else {
                log.info("Failed to load sessions: ${sessionsResult.exceptionOrNull()?.message}")
            }

            // Restore last session
            val lastSessionId = settings.lastSessionId
            if (lastSessionId != null && _sessions.value.any { it.id == lastSessionId }) {
                switchSession(lastSessionId)
            }

            _connectionStatus.value = ConnectionStatus.CONNECTED
            Result.success(Unit)
        } catch (e: Exception) {
            log.info("Failed to connect: ${e.message}")
            _connectionStatus.value = ConnectionStatus.ERROR
            Result.failure(e)
        }
    }

    /**
     * Send a message to the current session. Creates a new session if none is active.
     */
    suspend fun sendMessage(text: String, context: String? = null): Result<Unit> = withContext(Dispatchers.IO) {
        val client = apiClient ?: return@withContext Result.failure(Exception("Not connected"))
        val port = settings.serverPort

        // Emit user message so ChatPanel can display it immediately
        _lastUserMessage.value = text

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
            val wsUrl = "ws://localhost:$port/api/ws/$sessionId"
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
        val port = settings.serverPort

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
            val wsUrl = "ws://localhost:$port/api/ws/$sessionId"
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
     * Ensure server is running and connect using per-project port.
     * Assigns a deterministic port from the project path hash if not yet assigned.
     */
    suspend fun ensureServerAndConnect(): Result<Unit> = withContext(Dispatchers.IO) {
        _connectionStatus.value = ConnectionStatus.CONNECTING

        val projectPath = project.basePath
            ?: return@withContext run {
                _connectionStatus.value = ConnectionStatus.ERROR
                Result.failure(Exception("No project directory"))
            }

        // Resolve port: use stored or assign new
        val port = if (settings.serverPort > 0) {
            settings.serverPort
        } else {
            val newPort = serverDetector.getPortForProject(projectPath)
            settings.serverPort = newPort
            newPort
        }

        log.info("Project: $projectPath, assigned port: $port")

        // Check if server is already reachable on our port
        if (serverDetector.isPortReachable(port)) {
            log.info("Server reachable on port $port, connecting...")
            return@withContext connect(port)
        }

        // Start server with our port in the project directory
        val projectDir = java.io.File(projectPath)
        log.info("Starting server on port $port in $projectPath...")
        val started = serverDetector.startServer(projectDir, port)
        if (!started) {
            _connectionStatus.value = ConnectionStatus.ERROR
            return@withContext Result.failure(Exception("Failed to start FAN Server on port $port"))
        }

        // Wait for server to be ready (health check)
        var retries = 0
        val maxRetries = 15
        while (retries < maxRetries) {
            delay(1000)
            if (serverDetector.isPortReachable(port)) {
                log.info("Server started on port $port after ${retries + 1}s")
                return@withContext connect(port)
            }
            retries++
        }

        _connectionStatus.value = ConnectionStatus.ERROR
        Result.failure(Exception("Server did not start on port $port within ${maxRetries}s"))
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
                        refreshSessions()
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
        serverDetector.stopServer()
        wsClient?.destroy()
        scope.cancel()
    }
}
