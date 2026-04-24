package fan.idea.api

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*

// =============================================================================
// Health
// =============================================================================

@Serializable
data class HealthResponse(
    val status: String,    // "ok" | "degraded"
    val version: String,
    val uptime: Long
)

// =============================================================================
// Sessions
// =============================================================================

@Serializable
data class CreateSessionRequest(
    val title: String? = null,
    val parentSessionId: String? = null
)

@Serializable
data class CreateSessionResponse(
    val id: String,
    val title: String,
    val model: String? = null,
    val provider: String? = null,
    val createdAt: String,
    val updatedAt: String
)

@Serializable
data class SessionSummary(
    val id: String,
    val title: String,
    val model: String? = null,
    val provider: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val messageCount: Int,
    val sessionFile: String? = null
)

@Serializable
data class SessionMessage(
    val id: String,
    val role: String,      // "user" | "assistant" | "tool"
    val content: String,
    val model: String? = null,
    val tokens: Int? = null,
    val cost: Double? = null,
    val createdAt: String
)

@Serializable
data class GetSessionResponse(
    val id: String,
    val title: String,
    val model: String? = null,
    val provider: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val messages: List<SessionMessage>,
    val sessionFile: String? = null
)

// =============================================================================
// Messages
// =============================================================================

@Serializable
data class SendMessageRequest(
    val message: String,
    val streamingBehavior: String? = null  // "steer" | "followUp"
)

// =============================================================================
// Models
// =============================================================================

@Serializable
data class ModelInfo(
    val provider: String,
    val model: String,
    val displayName: String? = null
)

@Serializable
data class RoutingRuleInfo(
    val id: String,
    val name: String,
    val provider: String,
    val model: String,
    val fallback: String? = null,
    val enabled: Boolean
)

// =============================================================================
// Budget
// =============================================================================

@Serializable
data class BudgetStatus(
    val provider: String,
    val period: String,
    val tokensUsed: Int,
    val costUsed: Double,
    val tokenLimit: Int? = null,
    val costLimit: Double? = null,
    val exceeded: Boolean
)

@Serializable
data class UpdateBudgetRequest(
    val provider: String? = null,
    val period: String,    // "daily" | "monthly"
    val tokenLimit: Int? = null,
    val costLimit: Double? = null
)

// =============================================================================
// Tokens
// =============================================================================

@Serializable
data class TokenInfo(
    val id: String,
    val name: String,
    val token: String,
    val createdAt: String,
    val lastUsed: String? = null
)

@Serializable
data class TokenSummary(
    val id: String,
    val name: String,
    val createdAt: String,
    val lastUsed: String? = null
)

// =============================================================================
// Wrapped REST Responses
// =============================================================================

@Serializable
data class ListSessionsResponse(val sessions: List<SessionSummary>)

@Serializable
data class GetModelsResponse(
    val models: List<ModelInfo>,
    val routingRules: List<RoutingRuleInfo>
)

@Serializable
data class GetBudgetResponse(val budgets: List<BudgetStatus>)

@Serializable
data class ListTokensResponse(val tokens: List<TokenSummary>)

@Serializable
data class GenerateTokenResponse(val token: TokenInfo)

@Serializable
data class DeleteSessionResponse(val success: Boolean)

@Serializable
data class RevokeTokenResponse(val success: Boolean)

@Serializable
data class SendMessageResponse(val success: Boolean)

// =============================================================================
// WebSocket — Server → Client Messages
//
// Deserialized manually via WsServerMessageSerializer (checks "type" field).
// =============================================================================

sealed interface WsServerMessage {
    val type: String
    val sessionId: String
    val timestamp: String
}

@Serializable
data class WsConnected(
    override val sessionId: String,
    override val timestamp: String
) : WsServerMessage {
    override val type: String = "connected"
}

@Serializable
data class WsAgentEvent(
    override val sessionId: String,
    override val timestamp: String,
    val event: JsonObject  // will be parsed separately to AgentEventData
) : WsServerMessage {
    override val type: String = "agent_event"
}

@Serializable
data class WsError(
    override val sessionId: String,
    override val timestamp: String,
    val code: String,
    val message: String
) : WsServerMessage {
    override val type: String = "error"
}

@Serializable
data class WsPong(
    override val sessionId: String,
    override val timestamp: String
) : WsServerMessage {
    override val type: String = "pong"
}

/**
 * Manual serializer for [WsServerMessage]. Reads the "type" field from the JSON
 * object and dispatches to the correct concrete data class.
 */
object WsServerMessageSerializer : KSerializer<WsServerMessage> {

    override val descriptor: SerialDescriptor =
        WsServerMessageSurrogate.serializer().descriptor

    @Serializable
    private data class WsServerMessageSurrogate(
        val type: String,
        val sessionId: String = "",
        val timestamp: String = ""
    )

    override fun deserialize(decoder: Decoder): WsServerMessage {
        val jsonObject = decoder.decodeSerializableValue(JsonObject.serializer())
        val type = jsonObject["type"]?.jsonPrimitive?.content
            ?: throw SerializationException("WsServerMessage missing 'type' field")

        return when (type) {
            "connected" -> Json.decodeFromJsonElement(WsConnected.serializer(), jsonObject)
            "agent_event" -> Json.decodeFromJsonElement(WsAgentEvent.serializer(), jsonObject)
            "error" -> Json.decodeFromJsonElement(WsError.serializer(), jsonObject)
            "pong" -> Json.decodeFromJsonElement(WsPong.serializer(), jsonObject)
            else -> throw SerializationException("Unknown WsServerMessage type: $type")
        }
    }

    override fun serialize(encoder: Encoder, value: WsServerMessage) {
        val element = when (value) {
            is WsConnected -> Json.encodeToJsonElement(WsConnected.serializer(), value)
            is WsAgentEvent -> Json.encodeToJsonElement(WsAgentEvent.serializer(), value)
            is WsError -> Json.encodeToJsonElement(WsError.serializer(), value)
            is WsPong -> Json.encodeToJsonElement(WsPong.serializer(), value)
        }
        encoder.encodeSerializableValue(JsonElement.serializer(), element)
    }
}

// =============================================================================
// Agent Event Data — nested inside WsAgentEvent.event
//
// Deserialized manually via AgentEventDataSerializer (checks "type" field).
// =============================================================================

sealed interface AgentEventData {
    val type: String
}

@Serializable
data class AgentStart(override val type: String = "agent_start") : AgentEventData

@Serializable
data class AgentEnd(
    override val type: String = "agent_end",
    val messages: List<JsonObject> = emptyList()
) : AgentEventData

@Serializable
data class TurnStart(override val type: String = "turn_start") : AgentEventData

@Serializable
data class TurnEnd(
    override val type: String = "turn_end",
    val message: JsonObject? = null,
    val toolResults: List<JsonObject> = emptyList()
) : AgentEventData

@Serializable
data class MessageStart(
    override val type: String = "message_start",
    val message: JsonObject? = null
) : AgentEventData

@Serializable
data class MessageUpdate(
    override val type: String = "message_update",
    val message: JsonObject? = null,
    val assistantMessageEvent: JsonObject? = null
) : AgentEventData

@Serializable
data class MessageEnd(
    override val type: String = "message_end",
    val message: JsonObject? = null
) : AgentEventData

@Serializable
data class ToolExecutionStart(
    override val type: String = "tool_execution_start",
    val toolCallId: String = "",
    val toolName: String = "",
    val args: JsonObject? = null
) : AgentEventData

@Serializable
data class ToolExecutionUpdate(
    override val type: String = "tool_execution_update",
    val toolCallId: String = "",
    val toolName: String = "",
    val args: JsonObject? = null,
    val partialResult: JsonObject? = null
) : AgentEventData

@Serializable
data class ToolExecutionEnd(
    override val type: String = "tool_execution_end",
    val toolCallId: String = "",
    val toolName: String = "",
    val result: JsonObject? = null,
    val isError: Boolean = false
) : AgentEventData

/**
 * Manual serializer for [AgentEventData]. Reads the "type" field from the JSON
 * object and dispatches to the correct concrete data class.
 */
object AgentEventDataSerializer : KSerializer<AgentEventData> {

    override val descriptor: SerialDescriptor =
        AgentEventDataSurrogate.serializer().descriptor

    @Serializable
    private data class AgentEventDataSurrogate(val type: String)

    override fun deserialize(decoder: Decoder): AgentEventData {
        val jsonObject = decoder.decodeSerializableValue(JsonObject.serializer())
        val type = jsonObject["type"]?.jsonPrimitive?.content
            ?: throw SerializationException("AgentEventData missing 'type' field")

        return when (type) {
            "agent_start" -> Json.decodeFromJsonElement(AgentStart.serializer(), jsonObject)
            "agent_end" -> Json.decodeFromJsonElement(AgentEnd.serializer(), jsonObject)
            "turn_start" -> Json.decodeFromJsonElement(TurnStart.serializer(), jsonObject)
            "turn_end" -> Json.decodeFromJsonElement(TurnEnd.serializer(), jsonObject)
            "message_start" -> Json.decodeFromJsonElement(MessageStart.serializer(), jsonObject)
            "message_update" -> Json.decodeFromJsonElement(MessageUpdate.serializer(), jsonObject)
            "message_end" -> Json.decodeFromJsonElement(MessageEnd.serializer(), jsonObject)
            "tool_execution_start" -> Json.decodeFromJsonElement(ToolExecutionStart.serializer(), jsonObject)
            "tool_execution_update" -> Json.decodeFromJsonElement(ToolExecutionUpdate.serializer(), jsonObject)
            "tool_execution_end" -> Json.decodeFromJsonElement(ToolExecutionEnd.serializer(), jsonObject)
            else -> throw SerializationException("Unknown AgentEventData type: $type")
        }
    }

    override fun serialize(encoder: Encoder, value: AgentEventData) {
        val element = when (value) {
            is AgentStart -> Json.encodeToJsonElement(AgentStart.serializer(), value)
            is AgentEnd -> Json.encodeToJsonElement(AgentEnd.serializer(), value)
            is TurnStart -> Json.encodeToJsonElement(TurnStart.serializer(), value)
            is TurnEnd -> Json.encodeToJsonElement(TurnEnd.serializer(), value)
            is MessageStart -> Json.encodeToJsonElement(MessageStart.serializer(), value)
            is MessageUpdate -> Json.encodeToJsonElement(MessageUpdate.serializer(), value)
            is MessageEnd -> Json.encodeToJsonElement(MessageEnd.serializer(), value)
            is ToolExecutionStart -> Json.encodeToJsonElement(ToolExecutionStart.serializer(), value)
            is ToolExecutionUpdate -> Json.encodeToJsonElement(ToolExecutionUpdate.serializer(), value)
            is ToolExecutionEnd -> Json.encodeToJsonElement(ToolExecutionEnd.serializer(), value)
        }
        encoder.encodeSerializableValue(JsonElement.serializer(), element)
    }
}

// =============================================================================
// Connection Status (internal enum)
// =============================================================================

enum class ConnectionStatus {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    ERROR
}

// =============================================================================
// Internal UI Event Types — for SharedFlow event bus
//
// These are used internally for UI rendering, parsed from the raw WS JSON.
// =============================================================================

sealed interface FanEvent {
    data class AgentStart(val timestamp: String) : FanEvent
    data class TurnStart(val timestamp: String) : FanEvent
    data class MessageStart(val messageId: String?) : FanEvent
    data class TextDelta(val delta: String) : FanEvent
    data class ThinkingDelta(val delta: String) : FanEvent
    data class ThinkingEnd(val content: String) : FanEvent
    data class TextEnd(val content: String) : FanEvent
    data class ToolExecutionStart(
        val toolName: String,
        val toolCallId: String,
        val args: Map<String, Any?>
    ) : FanEvent
    data class ToolExecutionUpdate(
        val toolName: String,
        val toolCallId: String,
        val partialResult: String?
    ) : FanEvent
    data class ToolExecutionEnd(
        val toolName: String,
        val toolCallId: String,
        val result: String?,
        val isError: Boolean
    ) : FanEvent
    data class MessageEnd(val messageId: String?) : FanEvent
    data class TurnEnd : FanEvent
    data class AgentEnd : FanEvent
    data class Error(val message: String) : FanEvent
    data class Connected(val sessionId: String) : FanEvent
}

// =============================================================================
// Server Config — for server.json parsing
// =============================================================================

@Serializable
data class ServerConfig(
    val pid: Int? = null,
    val port: Int,
    val host: String = "localhost",
    val token: String? = null,
    val startTime: String? = null
)
