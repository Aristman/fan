package fan.idea.ui.chat

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import java.awt.CardLayout
import javax.swing.JPanel

class FanSessionNavigator(private val project: Project) : JPanel(CardLayout()) {

    enum class View { SESSION_LIST, CHAT }

    private val log = Logger.getInstance(FanSessionNavigator::class.java)
    private val cardLayout = layout as CardLayout

    private var currentView: View = View.SESSION_LIST

    fun showSessionList() {
        currentView = View.SESSION_LIST
        cardLayout.show(this, View.SESSION_LIST.name)
        log.info("Navigator: switched to SESSION_LIST")
    }

    fun showChat() {
        currentView = View.CHAT
        cardLayout.show(this, View.CHAT.name)
        log.info("Navigator: switched to CHAT")
    }

    fun getCurrentView(): View = currentView

    fun addPanel(view: View, panel: FanSessionListPanel) {
        add(panel as java.awt.Component, view.name)
    }

    fun addPanel(view: View, panel: FanChatPanel) {
        add(panel as java.awt.Component, view.name)
    }

    @Suppress("UNCHECKED_CAST")
    fun getSessionListPanel(): FanSessionListPanel? {
        return components.firstOrNull { it is FanSessionListPanel } as? FanSessionListPanel
    }

    @Suppress("UNCHECKED_CAST")
    fun getChatPanel(): FanChatPanel? {
        return components.firstOrNull { it is FanChatPanel } as? FanChatPanel
    }
}
