package fan.idea.toolwindow

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import fan.idea.FanPluginManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class FanToolWindowFactory : ToolWindowFactory {
    private val log = Logger.getInstance(FanToolWindowFactory::class.java)

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val manager = project.getService(FanPluginManager::class.java)
        val plugin = manager.fanPlugin

        val contentManager = toolWindow.contentManager
        val contentFactory = ContentFactory.getInstance()

        // Create panels
        val welcomePanel = WelcomePanel(project)
        val sessionListPanel = SessionListPanel(project)
        val chatPanel = ChatPanel(project)

        // Always start with session list — server will auto-start if needed
        val initialPanel = sessionListPanel

        val content = contentFactory.createContent(initialPanel, "", false)
        contentManager.addContent(content)

        // Store references for view switching
        val viewSwitcher = ViewSwitcher(
            toolWindow = toolWindow,
            contentManager = contentManager,
            contentFactory = contentFactory,
            welcomePanel = welcomePanel,
            sessionListPanel = sessionListPanel,
            chatPanel = chatPanel,
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        )
        viewSwitchers[project] = viewSwitcher

        // Register panel disposal when tool window is closed
        Disposer.register(toolWindow.disposable) {
            welcomePanel.dispose()
            sessionListPanel.dispose()
            chatPanel.dispose()
            viewSwitcher.dispose()
        }

        // Auto-connect: start server if needed, then connect
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val result = kotlinx.coroutines.runBlocking { plugin.ensureServerAndConnect() }
                if (result.isFailure) {
                    log.info("Failed to connect to FAN Server: ${result.exceptionOrNull()?.message}")
                }
            } catch (t: Throwable) {
                log.info("Failed to connect to FAN Server: ${t.message}")
            }
        }
    }



    companion object {
        val VIEW_SWITCHER_KEY = Key.create<ViewSwitcher>("fan.view.switcher")
        private val viewSwitchers = mutableMapOf<Project, ViewSwitcher>()

        fun getViewSwitcher(project: Project): ViewSwitcher? = viewSwitchers[project]
    }
}

/**
 * Manages switching between Tool Window views.
 */
class ViewSwitcher(
    val toolWindow: ToolWindow,
    private val contentManager: com.intellij.ui.content.ContentManager,
    private val contentFactory: ContentFactory,
    private val welcomePanel: WelcomePanel,
    private val sessionListPanel: SessionListPanel,
    private val chatPanel: ChatPanel,
    val scope: CoroutineScope
) {
    private var currentView: View = View.WELCOME

    enum class View { WELCOME, SESSION_LIST, CHAT }

    fun showWelcome() {
        if (currentView == View.WELCOME) return
        currentView = View.WELCOME
        contentManager.removeAllContents(true)
        contentManager.addContent(contentFactory.createContent(welcomePanel, "", false))
    }

    fun showSessionList() {
        if (currentView == View.SESSION_LIST) return
        currentView = View.SESSION_LIST
        contentManager.removeAllContents(true)
        contentManager.addContent(contentFactory.createContent(sessionListPanel, "", false))
    }

    fun showChat() {
        if (currentView == View.CHAT) return
        currentView = View.CHAT
        contentManager.removeAllContents(true)
        contentManager.addContent(contentFactory.createContent(chatPanel, "", false))
        chatPanel.focusInput()
    }

    fun getCurrentView(): View = currentView

    fun dispose() {
        scope.cancel()
    }
}
