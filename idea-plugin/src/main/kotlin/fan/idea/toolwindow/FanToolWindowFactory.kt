package fan.idea.toolwindow

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import fan.idea.ui.chat.FanChatPanel
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.content.ContentManager
import fan.idea.FanPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class FanToolWindowFactory : ToolWindowFactory {
    private val log = Logger.getInstance(FanToolWindowFactory::class.java)

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val plugin = project.getService(FanPlugin::class.java)

        val contentManager = toolWindow.contentManager
        val contentFactory = ContentFactory.getInstance()

        // Create panels
        val welcomePanel = WelcomePanel(project)
        val sessionListPanel = SessionListPanel(project)
        val chatPanel = FanChatPanel(project)

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
            plugin.dispose()
        }

        // Auto-connect: start server if needed, then connect
        plugin.ensureConnected()
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
    private val contentManager: ContentManager,
    private val contentFactory: ContentFactory,
    private val welcomePanel: WelcomePanel,
    private val sessionListPanel: SessionListPanel,
    private val chatPanel: FanChatPanel,
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
