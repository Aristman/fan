package fan.idea.api

import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.pow

/**
 * OkHttp WebSocket client for the FAN Server streaming API.
 *
 * Features:
 * - Automatic reconnection with exponential backoff (up to 10 attempts, max 30 s delay)
 * - [SharedFlow]-based event bus for structured [FanEvent] emissions
 * - Connection state stream ([ConnectionStatus]) with replay = 1
 * - Lifecycle-safe: [destroy] cancels all coroutines and closes the socket
 *
 * Usage:
 * ```kotlin
 * val wsClient = FanWsClient()
 * wsClient.connect("ws://localhost:3456/api/ws", sessionId, token)
 * wsClient.events.collect { event -> /* handle */ }
 * // later…
 * wsClient.destroy()
 * ```
 */
class FanWsClient {

    private val log = Logger.getInstance(FanWsClient::class.java)

    private val json = Json { ignoreUnknownKeys = true }

    // ── Connection state ─────────────────────────────────────────────────

    private var webSocket: WebSocket? = null
    private var currentSessionId: String? = null
    private var wsUrl: String = ""
    private var token: String = ""

    // ── HTTP client (shared for WS) ──────────────────────────────────────

    private val client = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MINUTES) // no timeout for long-lived WS
        .build()

    // ── Reconnection config ──────────────────────────────────────────────

    private var reconnectJob: Job? = null
    private var reconnectAttempt: Int = 0

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    companion object {
        private const val MAX_RECONNECT_ATTEMPTS = 10
        private const val BASE_RECONNECT_DELAY_MS = 1_000L
        private const val MAX_RECONNECT_DELAY_MS = 30_000L
    }

    // ── Public flows ─────────────────────────────────────────────────────

    /**
     * Structured events emitted as they arrive from the server.
     * Buffer capacity of 256 ensures slow consumers don't block the socket thread.
     */
    private val _events = MutableSharedFlow<FanEvent>(extraBufferCapacity = 256)
    val events: SharedFlow<FanEvent> = _events.asSharedFlow()

    /**
     * Connection lifecycle status.  Replay = 1 so new subscribers immediately
     * see the current state.
     */
    private val _connectionState = MutableSharedFlow<ConnectionStatus>(replay = 1, extraBufferCapacity = 1)
    val connectionState: SharedFlow<ConnectionStatus> = _connectionState.asSharedFlow()

    // ── Public API ───────────────────────────────────────────────────────

    /**
     * Open a WebSocket connection to the FAN Server.
     *
     * Any previous connection is closed first.
     *
     * @param wsUrl     full WS endpoint, e.g. `ws://localhost:3456/api/ws`
     * @param sessionId session to subscribe to after connecting
     * @param token     auth token (passed as query param)
     */
    fun connect(wsUrl: String, sessionId: String, token: String) {
        disconnect()
        this.wsUrl = wsUrl
        this.token = token
        this.currentSessionId = sessionId
        this.reconnectAttempt = 0
        doConnect()
    }

    /**
     * Gracefully close the current connection and cancel pending reconnects.
     */
    fun disconnect() {
        reconnectJob?.cancel()
        reconnectJob = null
        webSocket?.close(1000, "Client disconnect")
        webSocket = null
        currentSessionId = null
        reconnectAttempt = 0
    }

    /**
     * Send a `subscribe` message for the given session.
     * Useful to switch to a different session without reconnecting.
     */
    fun subscribe(sessionId: String) {
        val msg = """{"type":"subscribe","sessionId":"$sessionId"}"""
        webSocket?.send(msg)
    }

    /**
     * Send a ping frame (JSON keepalive).
     */
    fun sendPing() {
        webSocket?.send("""{"type":"ping"}""")
    }

    /**
     * Whether a WebSocket instance is currently held (not necessarily open).
     */
    fun isConnected(): Boolean = webSocket != null

    /**
     * Release all resources.  After calling this the instance must not be reused.
     */
    fun destroy() {
        disconnect()
        scope.cancel()
    }

    // ── Connection internals ─────────────────────────────────────────────

    private fun doConnect() {
        val sessionId = currentSessionId ?: return

        val fullUrl = buildString {
            append(wsUrl)
            append("/")
            append(sessionId)
            append("?token=")
            append(token)
        }

        _connectionState.tryEmit(ConnectionStatus.CONNECTING)
        log.info("Connecting WS to $fullUrl")

        val request = Request.Builder().url(fullUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                log.info("WS connected")
                _connectionState.tryEmit(ConnectionStatus.CONNECTED)
                reconnectAttempt = 0
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { handleIncomingMessage(text) }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // Binary messages are not expected from the server.
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                _connectionState.tryEmit(ConnectionStatus.DISCONNECTED)
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                log.warn("WS failure: ${t.message}")
                _connectionState.tryEmit(ConnectionStatus.ERROR)
                scheduleReconnect()
            }
        })
    }

    // ── Message handling ─────────────────────────────────────────────────

    /**
     * Parse a raw JSON text frame and emit the corresponding [FanEvent].
     */
    private fun handleIncomingMessage(text: String) {
        try {
            val obj = json.parseToJsonElement(text).let { it as? JsonObject } ?: return
            val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: return

            when (type) {
                "connected" -> {
                    val sessionId = obj["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
                    _events.tryEmit(FanEvent.Connected(sessionId))
                }
                "agent_event" -> {
                    val event = obj["event"] as? JsonObject ?: return
                    parseAndEmitAgentEvent(event)
                }
                "pong" -> { /* keepalive acknowledgement — nothing to do */ }
                "error" -> {
                    val message = obj["message"]?.jsonPrimitive?.contentOrNull
                        ?: "Unknown WS error"
                    _events.tryEmit(FanEvent.Error(message))
                }
                else -> {
                    log.debug("Unknown WS message type: $type")
                }
            }
        } catch (e: Exception) {
            log.warn("Failed to parse WS message: ${e.message}")
        }
    }

    /**
     * Dispatch an agent_event payload to the appropriate [FanEvent] variant.
     */
    private fun parseAndEmitAgentEvent(event: JsonObject) {
        val type = event["type"]?.jsonPrimitive?.contentOrNull ?: return

        when (type) {
            "agent_start" -> {
                _events.tryEmit(
                    FanEvent.AgentStart(event["timestamp"]?.jsonPrimitive?.contentOrNull ?: "")
                )
            }

            "agent_end" -> {
                _events.tryEmit(FanEvent.AgentEnd)
            }

            "turn_start" -> {
                _events.tryEmit(
                    FanEvent.TurnStart(event["timestamp"]?.jsonPrimitive?.contentOrNull ?: "")
                )
            }

            "turn_end" -> {
                _events.tryEmit(FanEvent.TurnEnd)
            }

            "message_start" -> {
                _events.tryEmit(FanEvent.MessageStart(null))
            }

            "message_end" -> {
                _events.tryEmit(FanEvent.MessageEnd(null))
            }

            "message_update" -> {
                val subEvent = event["assistantMessageEvent"] as? JsonObject ?: return
                parseAssistantMessageEvent(subEvent)
            }

            "tool_execution_start" -> {
                val toolName = event["toolName"]?.jsonPrimitive?.contentOrNull ?: ""
                val toolCallId = event["toolCallId"]?.jsonPrimitive?.contentOrNull ?: ""
                val args = convertArgs(event["args"] as? JsonObject)
                _events.tryEmit(FanEvent.ToolExecutionStart(toolName, toolCallId, args))
            }

            "tool_execution_update" -> {
                val toolName = event["toolName"]?.jsonPrimitive?.contentOrNull ?: ""
                val toolCallId = event["toolCallId"]?.jsonPrimitive?.contentOrNull ?: ""
                val partial = event["partialResult"]?.jsonPrimitive?.contentOrNull
                _events.tryEmit(FanEvent.ToolExecutionUpdate(toolName, toolCallId, partial))
            }

            "tool_execution_end" -> {
                val toolName = event["toolName"]?.jsonPrimitive?.contentOrNull ?: ""
                val toolCallId = event["toolCallId"]?.jsonPrimitive?.contentOrNull ?: ""
                val result = event["result"]?.jsonPrimitive?.contentOrNull
                val isError = event["isError"]?.jsonPrimitive?.contentOrNull?.toBoolean() ?: false
                _events.tryEmit(FanEvent.ToolExecutionEnd(toolName, toolCallId, result, isError))
            }

            else -> log.debug("Unknown agent event type: $type")
        }
    }

    /**
     * Parse the nested `assistantMessageEvent` inside a `message_update`.
     */
    private fun parseAssistantMessageEvent(subEvent: JsonObject) {
        val subType = subEvent["type"]?.jsonPrimitive?.contentOrNull ?: return

        when (subType) {
            "thinking_delta" -> {
                val delta = subEvent["delta"]?.jsonPrimitive?.contentOrNull ?: return
                _events.tryEmit(FanEvent.ThinkingDelta(delta))
            }
            "thinking_end" -> {
                val content = subEvent["content"]?.jsonPrimitive?.contentOrNull ?: ""
                _events.tryEmit(FanEvent.ThinkingEnd(content))
            }
            "text_delta" -> {
                val delta = subEvent["delta"]?.jsonPrimitive?.contentOrNull ?: return
                _events.tryEmit(FanEvent.TextDelta(delta))
            }
            "text_end" -> {
                val content = subEvent["content"]?.jsonPrimitive?.contentOrNull ?: ""
                _events.tryEmit(FanEvent.TextEnd(content))
            }
            // Tool-call events inside assistant messages are informational;
            // the authoritative tool lifecycle events come via tool_execution_*.
            "toolcall_start", "toolcall_delta", "toolcall_end", "done", "error",
            "thinking_start", "text_start" -> { /* ignored at this level */ }
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /**
     * Convert a [JsonObject] into a plain `Map<String, Any?>` by extracting
     * primitive values.  Nested structures are kept as their string representation.
     */
    private fun convertArgs(obj: JsonObject?): Map<String, Any?> {
        if (obj == null) return emptyMap()
        val result = mutableMapOf<String, Any?>()
        for ((key, element) in obj) {
            result[key] = when (element) {
                is JsonPrimitive -> element.contentOrNull ?: element.content.toBooleanStrictOrNull()
                else -> element.toString()
            }
        }
        return result
    }

    // ── Reconnection ─────────────────────────────────────────────────────

    private fun scheduleReconnect() {
        if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            log.warn("Max reconnect attempts ($MAX_RECONNECT_ATTEMPTS) reached")
            _connectionState.tryEmit(ConnectionStatus.ERROR)
            return
        }

        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            _connectionState.tryEmit(ConnectionStatus.RECONNECTING)
            val delay = calculateBackoff(reconnectAttempt)
            log.info(
                "Reconnecting in ${delay}ms (attempt ${reconnectAttempt + 1}/$MAX_RECONNECT_ATTEMPTS)"
            )
            delay(delay)
            reconnectAttempt++
            doConnect()
        }
    }

    /**
     * Exponential back-off: 1 s × 2^attempt, capped at 30 s.
     */
    private fun calculateBackoff(attempt: Int): Long {
        val delayMs = BASE_RECONNECT_DELAY_MS * (2.0.pow(attempt.toDouble()))
        return min(delayMs, MAX_RECONNECT_DELAY_MS.toDouble()).toLong()
    }
}
