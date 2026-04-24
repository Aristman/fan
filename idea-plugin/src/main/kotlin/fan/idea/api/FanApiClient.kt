package fan.idea.api

import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * OkHttp-based REST API client for FAN Server.
 *
 * All public methods are `suspend` functions that return [Result] and execute
 * network I/O on [Dispatchers.IO].  Callers can co-routine-wrap these as needed.
 *
 * Usage:
 * ```kotlin
 * val client = FanApiClient("http://localhost:3456", "my-token")
 * val health = client.healthCheck()
 * health.onSuccess { println(it.status) }
 * ```
 *
 * @param baseUrl  HTTP base URL, e.g. `http://localhost:3456`
 * @param authToken  Bearer token for authenticated endpoints (may be blank for health-only use)
 */
class FanApiClient(
    private var baseUrl: String,
    private var authToken: String = ""
) {
    private val log = Logger.getInstance(FanApiClient::class.java)

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(300, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    // ── Mutable state ────────────────────────────────────────────────────

    /**
     * Update the base URL at runtime (e.g. after detecting a new server port).
     */
    fun updateBaseUrl(url: String) {
        baseUrl = url
    }

    /**
     * Update the auth token at runtime.
     */
    fun updateToken(token: String) {
        authToken = token
    }

    // ── Health ───────────────────────────────────────────────────────────

    /**
     * GET /api/health — no authentication required.
     */
    suspend fun healthCheck(): Result<HealthResponse> =
        executeRequest("GET", "/api/health")
            .map { json.decodeFromString<HealthResponse>(it) }

    // ── Sessions ─────────────────────────────────────────────────────────

    /**
     * GET /api/sessions — list all sessions.
     */
    suspend fun listSessions(): Result<ListSessionsResponse> =
        executeRequest("GET", "/api/sessions")
            .map { json.decodeFromString<ListSessionsResponse>(it) }

    /**
     * POST /api/sessions — create a new session.
     *
     * @param title  optional human-readable title
     */
    suspend fun createSession(title: String? = null): Result<CreateSessionResponse> =
        executeRequest(
            "POST", "/api/sessions",
            body = json.encodeToJsonElement(CreateSessionRequest(title = title)).toString()
        ).map { json.decodeFromString<CreateSessionResponse>(it) }

    /**
     * GET /api/sessions/:id — fetch a single session with its messages.
     */
    suspend fun getSession(id: String): Result<GetSessionResponse> =
        executeRequest("GET", "/api/sessions/$id")
            .map { json.decodeFromString<GetSessionResponse>(it) }

    /**
     * DELETE /api/sessions/:id — delete a session.
     */
    suspend fun deleteSession(id: String): Result<DeleteSessionResponse> =
        executeRequest("DELETE", "/api/sessions/$id")
            .map { json.decodeFromString<DeleteSessionResponse>(it) }

    // ── Messages ─────────────────────────────────────────────────────────

    /**
     * POST /api/sessions/:id/messages — send a user message to the session.
     *
     * @param sessionId  target session ID
     * @param message    user prompt text
     * @param streamingBehavior  optional: `"steer"` or `"followUp"`
     */
    suspend fun sendMessage(
        sessionId: String,
        message: String,
        streamingBehavior: String? = null
    ): Result<SendMessageResponse> =
        executeRequest(
            "POST", "/api/sessions/$sessionId/messages",
            body = json.encodeToJsonElement(
                SendMessageRequest(message = message, streamingBehavior = streamingBehavior)
            ).toString()
        ).map { json.decodeFromString<SendMessageResponse>(it) }

    // ── Models ───────────────────────────────────────────────────────────

    /**
     * GET /api/models — list available models and routing rules.
     */
    suspend fun getModels(): Result<GetModelsResponse> =
        executeRequest("GET", "/api/models")
            .map { json.decodeFromString<GetModelsResponse>(it) }

    // ── Tokens ───────────────────────────────────────────────────────────

    /**
     * POST /api/tokens — generate a new client token.
     *
     * @param name  human-readable name for the token
     */
    suspend fun createToken(name: String): Result<GenerateTokenResponse> =
        executeRequest(
            "POST", "/api/tokens",
            body = JsonObject(mapOf("name" to JsonPrimitive(name))).toString()
        ).map { json.decodeFromString<GenerateTokenResponse>(it) }

    /**
     * GET /api/tokens — list all tokens.
     */
    suspend fun listTokens(): Result<ListTokensResponse> =
        executeRequest("GET", "/api/tokens")
            .map { json.decodeFromString<ListTokensResponse>(it) }

    /**
     * DELETE /api/tokens/:id — revoke a token.
     */
    suspend fun revokeToken(id: String): Result<RevokeTokenResponse> =
        executeRequest("DELETE", "/api/tokens/$id")
            .map { json.decodeFromString<RevokeTokenResponse>(it) }

    /**
     * Non-suspend sendMessage for use from non-coroutine contexts (e.g. executeOnPooledThread).
     */
    fun sendMessageSync(
        sessionId: String,
        message: String,
        streamingBehavior: String? = null
    ): Result<SendMessageResponse> =
        executeRequestSync(
            "POST", "/api/sessions/$sessionId/messages",
            body = json.encodeToJsonElement(
                SendMessageRequest(message = message, streamingBehavior = streamingBehavior)
            ).toString()
        ).map { json.decodeFromString<SendMessageResponse>(it) }

    // ── Low-level HTTP executor ──────────────────────────────────────────

    /**
     * Executes an HTTP request and returns the raw response body string on success,
     * or a [FanApiException] on failure.  Must be called from a background thread.
     */
    private fun executeRequestSync(
        method: String,
        path: String,
        body: String? = null
    ): Result<String> {
        return try {
            val requestBuilder = Request.Builder()
                .url("$baseUrl$path")
                .apply {
                    if (authToken.isNotBlank()) {
                        header("Authorization", "Bearer $authToken")
                    }
                }

            when (method) {
                "GET" -> requestBuilder.get()
                "POST" -> {
                    val requestBody = body
                        ?.toRequestBody(jsonMediaType)
                        ?: "".toRequestBody(jsonMediaType)
                    requestBuilder.post(requestBody)
                }
                "DELETE" -> requestBuilder.delete()
                else -> return Result.failure(
                    IllegalArgumentException("Unsupported HTTP method: $method")
                )
            }

            val response = client.newCall(requestBuilder.build()).execute()
            val responseBody = response.body?.string()

            if (response.isSuccessful) {
                if (responseBody != null) {
                    Result.success(responseBody)
                } else {
                    Result.failure(IOException("Empty response body for $method $path"))
                }
            } else {
                Result.failure(
                    FanApiException(
                        response.code,
                        responseBody ?: "Unknown error"
                    )
                )
            }
        } catch (e: IOException) {
            log.info("API $method $path failed: ${e.message}")
            Result.failure(e)
        }
    }

    /**
     * Suspended version – delegates to [executeRequestSync] on IO dispatcher.
     */
    private suspend fun executeRequest(
        method: String,
        path: String,
        body: String? = null
    ): Result<String> = withContext(Dispatchers.IO) {
        executeRequestSync(method, path, body)
    }
}

/**
 * Exception thrown when a FAN API call returns a non-2xx HTTP status.
 */
class FanApiException(val statusCode: Int, message: String) : Exception("HTTP $statusCode: $message")
