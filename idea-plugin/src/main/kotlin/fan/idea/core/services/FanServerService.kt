package fan.idea.core.services

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import fan.idea.api.ServerDetector
import fan.idea.settings.FanPluginSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

@Service(Service.Level.PROJECT)
class FanServerService(private val project: Project) {

    private val log = Logger.getInstance(FanServerService::class.java)
    private val serverDetector = ServerDetector()
    private val settings: FanPluginSettings get() = FanPluginSettings.getInstance()

    private val connectionService: FanConnectionService
        get() = ApplicationManager.getApplication().getService(FanConnectionService::class.java)

    private val sessionService: FanSessionService
        get() = project.getService(FanSessionService::class.java)

    private val messageService: FanMessageService
        get() = project.getService(FanMessageService::class.java)

    suspend fun ensureServerAndConnect(): Result<Unit> = withContext(Dispatchers.IO) {
        val projectPath = project.basePath
            ?: return@withContext Result.failure(Exception("No project directory"))

        val port = if (settings.serverPort > 0) {
            settings.serverPort
        } else {
            val newPort = serverDetector.getPortForProject(projectPath)
            settings.serverPort = newPort
            newPort
        }

        log.info("Project: $projectPath, assigned port: $port")

        if (serverDetector.isPortReachable(port)) {
            log.info("Port $port is occupied, killing existing server...")
            serverDetector.killServerOnPort(port)
            delay(1000)
        }

        val projectDir = java.io.File(projectPath)
        log.info("Starting server on port $port in $projectDir...")
        val started = serverDetector.startServer(projectDir, port)
        if (!started) {
            return@withContext Result.failure(Exception("Failed to start FAN Server on port $port"))
        }

        var retries = 0
        val maxRetries = 15
        while (retries < maxRetries) {
            delay(1000)
            if (serverDetector.isPortReachable(port)) {
                log.info("Server started on port $port after ${retries + 1}s")

                val connectResult = connectionService.connect(project, port)
                if (connectResult.isFailure) {
                    return@withContext connectResult
                }

                sessionService.loadSessions()
                messageService.startObserving()

                val lastSessionId = settings.lastSessionId
                if (lastSessionId != null) {
                    val sessions = sessionService.sessions.value
                    if (sessions.any { it.id == lastSessionId }) {
                        sessionService.selectSession(lastSessionId)
                    }
                }

                return@withContext Result.success(Unit)
            }
            retries++
        }

        Result.failure(Exception("Server did not start on port $port within ${maxRetries}s"))
    }

    fun stopServer() {
        serverDetector.stopServer()
    }
}
