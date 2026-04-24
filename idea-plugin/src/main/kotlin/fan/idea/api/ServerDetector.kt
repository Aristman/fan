package fan.idea.api

import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.nio.file.Path

/**
 * Detects FAN Server configuration from ~/.fan/agent/server.json
 * and provides methods for health checks, auto-start, and per-project port assignment.
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
        private const val PORT_RANGE_MIN = 3500
        private const val PORT_RANGE_SIZE = 5500
    }

    /**
     * Derive a deterministic port from the project path hash (range 3500–8999).
     */
    fun getPortForProject(projectPath: String): Int {
        val hash = projectPath.hashCode().let { if (it < 0) -it else it }
        return PORT_RANGE_MIN + (hash % PORT_RANGE_SIZE)
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
     * Check if a FAN server is reachable on the given port via health check.
     */
    suspend fun isPortReachable(port: Int): Boolean = withContext(Dispatchers.IO) {
        try {
            val client = FanApiClient("http://localhost:$port")
            client.healthCheck().isSuccess
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Check if the server is reachable via health check (legacy — reads global server.json).
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
     * Check if server is running for a specific project port.
     */
    suspend fun hasServerRunningForProject(port: Int): Boolean = isPortReachable(port)

    /**
     * Attempt to auto-start FAN Server using ProcessBuilder on the specified port.
     * Sets FAN_NO_AUTH=1 so the plugin can connect without tokens.
     * @param workingDir  Project directory to run the server in.
     * @param port  Port to start the server on.
     * @return true if the process was launched (doesn't guarantee it's ready).
     */
    suspend fun startServer(workingDir: java.io.File? = null, port: Int = DEFAULT_PORT): Boolean = withContext(Dispatchers.IO) {
        try {
            val args = listOf(FAN_BINARY, "server", "start", "--port", port.toString())
            val builder = ProcessBuilder(args)
                .redirectErrorStream(true)
                .apply {
                    environment()["FAN_NO_AUTH"] = "1"
                    if (workingDir != null && workingDir.isDirectory) {
                        directory(workingDir)
                    }
                }
            val process = builder.start()

            // Wait briefly for the process to fork (fan server start is a daemon launcher)
            val exited = process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
            if (exited && process.exitValue() != 0) {
                val output = process.inputStream.bufferedReader().readText()
                log.info("fan server start failed: $output")
                return@withContext false
            }

            log.info("fan server start command executed on port $port in: ${workingDir?.absolutePath ?: "default dir"}")
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

    /**
     * Stop FAN Server running on the given port.
     */
    fun stopServer(port: Int) {
        try {
            val config = readServerConfig()
            if (config != null && config.port == port && config.pid != null) {
                killProcess(config.pid)
                log.info("Stopped FAN Server (PID ${config.pid}) on port $port")
                return
            }

            val process = ProcessBuilder(FAN_BINARY, "server", "stop")
                .redirectErrorStream(true)
                .start()
            process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)
            log.info("Ran 'fan server stop' for port $port")
        } catch (e: Exception) {
            log.info("Failed to stop FAN Server on port $port: ${e.message}")
        }
    }

    private fun killProcess(pid: Int) {
        try {
            ProcessBuilder("kill", pid.toString())
                .redirectErrorStream(true)
                .start()
                .waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: Exception) {
            log.info("Failed to kill process $pid: ${e.message}")
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
