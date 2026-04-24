package fan.idea

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import fan.idea.core.services.FanConnectionService
import fan.idea.core.services.FanMessageService
import fan.idea.core.services.FanServerService
import fan.idea.core.services.FanSessionService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

@Service(Service.Level.PROJECT)
class FanPlugin(private val project: Project) {

    private val log = Logger.getInstance(FanPlugin::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val serverService: FanServerService
        get() = project.getService(FanServerService::class.java)

    private val connectionService: FanConnectionService
        get() = ApplicationManager.getApplication().getService(FanConnectionService::class.java)

    private val sessionService: FanSessionService
        get() = project.getService(FanSessionService::class.java)

    private val messageService: FanMessageService
        get() = project.getService(FanMessageService::class.java)

    fun ensureConnected() {
        scope.launch {
            log.info("Initializing FAN services for project: ${project.name}")
            val result = serverService.ensureServerAndConnect()
            if (result.isFailure) {
                log.info("Failed to initialize: ${result.exceptionOrNull()?.message}")
            }
        }
    }

    fun dispose() {
        log.info("Disposing FAN services for project: ${project.name}")
        messageService.dispose()
        sessionService.dispose()
        serverService.stopServer()
        connectionService.disposeConnection(project)
        scope.cancel()
    }
}
