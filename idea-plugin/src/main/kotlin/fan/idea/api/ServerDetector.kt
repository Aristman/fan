package fan.idea.api

import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.nio.file.Path

/**
 * Detects FAN Server configuration from ~/.fan/agent/server.json
 * and provides methods for health checks and auto-start.
 */
class ServerDetector {
    private val log = Logger.getInstance(ServerDetector::class.java)

    companion object {
        private val SERVER_JSON_PATH = Path.of(
            System.getProperty("user.home"),
            ".fan", "agent", "server.json"
        )
        private val SERVER_PID_PATH = Path.of(
            System.getProperty("user.home"),
            ".fan", "agent", "server.pid"
        )
        private const val FAN_BINARY = "fan"
        private const val DEFAULT_HOST = "localhost"
        private const val DEFAULT_PORT = 3456
    }

    /**
     * Check if server.json exists on disk.
     */
    fun hasServerJson(): Boolean = SERVER_JSON_PATH.toFile().exists()

    /**
     * Read and parse server.json.
     * Returns null if file doesn't exist or can't be parsed.
     */
    fun readServerConfig(): ServerConfig? {
        val file = SERVER_JSON_PATH.toFile()
        if (!file.exists()) return null

        return try {
            val content = file.readText(Charsets.UTF_8)
            Json.decodeFromString<ServerConfig>(content)
        } catch (e: Exception) {
            log.info("Failed to parse server.json: ${e.message}")
            null
        }
    }

    /**
     * Check if the given host is local (localhost, 127.0.0.1, ::1).
     */
    fun isLocalHost(host: String): Boolean {
        val h = host.lowercase()
            .removePrefix("http://")
            .removePrefix("https://")
            .removeSuffix("/")
        return h == "localhost" || h == "127.0.0.1" || h == "[::1]" || h == "::1" || h == "0.0.0.0"
    }

    /**
     * Build the base URL from server config.
     */
    fun getBaseUrl(config: ServerConfig): String {
        val host = config.host.ifBlank { DEFAULT_HOST }
        return "http://$host:${config.port}"
    }

    /**
     * Build the WebSocket URL from server config.
     */
    fun getWsUrl(config: ServerConfig, sessionId: String): String {
        val host = config.host.ifBlank { DEFAULT_HOST }
        return "ws://$host:${config.port}/api/ws/$sessionId"
    }

    /**
     * Check if the server is reachable via health check.
     */
    suspend fun isServerReachable(): Boolean = withContext(Dispatchers.IO) {
        val config = readServerConfig()
        if (config == null) return@withContext false
        try {
            val client = FanApiClient(getBaseUrl(config))
            client.healthCheck().isSuccess
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Attempt to auto-start FAN Server using ProcessBuilder.
     * Sets FAN_NO_AUTH=1 so the plugin can connect without tokens.
     * Returns true if the process was launched (doesn't guarantee it's ready).
     */
    suspend fun startServer(): Boolean = withContext(Dispatchers.IO) {
        try {
            val process = ProcessBuilder(FAN_BINARY, "server", "start")
                .redirectErrorStream(true)
                .apply {
                    // Start server without auth so plugin can connect without tokens
                    environment()["FAN_NO_AUTH"] = "1"
                }
                .start()

            // Wait briefly for the process to fork (fan server start is a daemon launcher)
            val exited = process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
            if (exited && process.exitValue() != 0) {
                val output = process.inputStream.bufferedReader().readText()
                log.info("fan server start failed: $output")
                return@withContext false
            }

            log.info("fan server start command executed")
            true
        } catch (e: Exception) {
            log.info("Failed to start FAN Server: ${e.message}")
            false
        }
    }

    /**
     * Check if FAN Server process is running (by PID from server.json or server.pid).
     */
    fun isServerProcessRunning(): Boolean {
        val pid = readPid()
        if (pid == null || pid <= 0) return false

        return try {
            val process = ProcessBuilder("kill", "-0", pid.toString())
                .redirectErrorStream(true)
                .start()
            process.waitFor() == 0
        } catch (e: Exception) {
            false
        }
    }

    private fun readPid(): Int? {
        // Try server.json first
        val config = readServerConfig()
        if (config?.pid != null && config.pid > 0) return config.pid

        // Fallback to server.pid
        val pidFile = SERVER_PID_PATH.toFile()
        if (pidFile.exists()) {
            return try {
                pidFile.readText().trim().toIntOrNull()
            } catch (e: Exception) {
                null
            }
        }

        return null
    }
}
