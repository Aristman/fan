package fan.idea.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import fan.idea.FanPluginManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class FanToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val manager = project.getService(FanPluginManager::class.java)
        val plugin = manager.fanPlugin

        val contentManager = toolWindow.contentManager
        val contentFactory = ContentFactory.getInstance()

        // Create panels
        val welcomePanel = WelcomePanel(project)
        val sessionListPanel = SessionListPanel(project)
        val chatPanel = ChatPanel(project)

        // Determine initial view
        val initialPanel = if (plugin.isServerAvailable()) {
            sessionListPanel  // Server detected → show session list
        } else {
            welcomePanel  // No server → show welcome
        }

        val content = contentFactory.createContent(initialPanel, "", false)
        contentManager.addContent(content)

        // Store references for view switching
        toolWindow.putUserData(VIEW_SWITCHER_KEY, ViewSwitcher(
            toolWindow = toolWindow,
            contentManager = contentManager,
            contentFactory = contentFactory,
            welcomePanel = welcomePanel,
            sessionListPanel = sessionListPanel,
            chatPanel = chatPanel,
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        ))

        // Auto-connect if server is available
        if (plugin.isServerAvailable()) {
            plugin.connect()
        }
    }

    override fun disposeToolWindow() {
        // Cleanup handled by FanPluginManager.dispose()
    }

    companion object {
        val VIEW_SWITCHER_KEY = Key.create<ViewSwitcher>("fan.view.switcher")
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
    private val scope: CoroutineScope
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
}
