package fan.idea

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project

@Service(Service.Level.PROJECT)
class FanPluginManager(private val project: Project) {
    val fanPlugin: FanPlugin by lazy { FanPlugin(project) }

    fun dispose() {
        fanPlugin.dispose()
    }
}
