package fan.idea.api

import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Detects FAN Server configuration and provides methods for health checks,
 * per-project port assignment, and foreground process management.
 *
 * Instead of using `fan server start` (daemon mode, which loses CWD due to detached spawn),
 * we run `fan server` directly as a foreground process. This way ProcessBuilder.directory()
 * properly sets the working directory for each project.
 */
class ServerDetector {
    private val log = Logger.getInstance(ServerDetector::class.java)

    companion object {
        private const val FAN_BINARY = "fan"
        private const val DEFAULT_HOST = "localhost"
        private const val DEFAULT_PORT = 3456
        private const val PORT_RANGE_MIN = 3500
        private const val PORT_RANGE_SIZE = 5500
    }

    /** Handle to the running `fan server` foreground process (one per project). */
    @Volatile
    private var serverProcess: Process? = null

    /**
     * Derive a deterministic port from the project path hash (range 3500–8999).
     */
    fun getPortForProject(projectPath: String): Int {
        val hash = projectPath.hashCode().let { if (it < 0) -it else it }
        return PORT_RANGE_MIN + (hash % PORT_RANGE_SIZE)
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
     * Start FAN Server as a managed foreground process in the given directory.
     * Uses `fan server` (not `fan server start`) so ProcessBuilder.directory()
     * properly sets the server's working directory.
     * @param workingDir  Project directory to run the server in.
     * @param port  Port to start the server on.
     * @return true if the process was launched successfully.
     */
    fun startServer(workingDir: File? = null, port: Int = DEFAULT_PORT): Boolean {
        try {
            val args = listOf(FAN_BINARY, "server", "--port", port.toString())
            val builder = ProcessBuilder(args)
                .redirectErrorStream(true)
                .apply {
                    environment()["FAN_NO_AUTH"] = "1"
                    if (workingDir != null && workingDir.isDirectory) {
                        directory(workingDir)
                    }
                }

            serverProcess = builder.start()
            log.info("FAN Server process started (PID ${getPid(serverProcess)}) on port $port in: ${workingDir?.absolutePath ?: "default dir"}")

            // Start a daemon thread to consume stdout/stderr so the process doesn't block
            val thread = Thread({
                try {
                    serverProcess?.inputStream?.bufferedReader()?.forEachLine { line ->
                        log.info("[fan-server] $line")
                    }
                } catch (_: Exception) {}
            }, "fan-server-stdout")
            thread.isDaemon = true
            thread.start()

            return true
        } catch (e: Exception) {
            log.info("Failed to start FAN Server: ${e.message}")
            return false
        }
    }

    /**
     * Stop the FAN Server process we started.
     */
    fun stopServer() {
        val proc = serverProcess
        if (proc != null) {
            log.info("Stopping FAN Server process (PID ${getPid(proc)})")
            proc.destroy()
            try {
                proc.waitFor(5, TimeUnit.SECONDS)
                if (proc.isAlive) {
                    proc.destroyForcibly()
                    proc.waitFor(3, TimeUnit.SECONDS)
                }
            } catch (e: Exception) {
                log.info("Error waiting for server process to stop: ${e.message}")
            }
            serverProcess = null
            log.info("FAN Server process stopped")
        }
    }

    /**
     * Kill any process listening on the given port.
     * Uses `lsof -ti :<port>` to find PIDs, then kills them.
     */
    fun killServerOnPort(port: Int) {
        try {
            val findProcess = ProcessBuilder("bash", "-c", "lsof -ti :$port 2>/dev/null")
                .redirectErrorStream(true)
                .start()
            val pids = findProcess.inputStream.bufferedReader().readText().trim()
            findProcess.waitFor()

            if (pids.isNotBlank()) {
                for (pid in pids.split("\n")) {
                    val pidTrimmed = pid.trim()
                    if (pidTrimmed.isNotBlank()) {
                        log.info("Killing process $pidTrimmed on port $port")
                        try {
                            val kill = ProcessBuilder("kill", pidTrimmed)
                                .redirectErrorStream(true)
                                .start()
                            kill.waitFor(5, TimeUnit.SECONDS)
                        } catch (e: Exception) {
                            log.info("Failed to kill process $pidTrimmed: ${e.message}")
                        }
                    }
                }
            } else {
                log.info("No process found on port $port")
            }
        } catch (e: Exception) {
            log.info("Failed to find/kill process on port $port: ${e.message}")
        }
    }

    private fun getPid(process: Process?): Long {
        return try {
            process?.pid() ?: -1
        } catch (e: Exception) {
            -1
        }
    }
}
