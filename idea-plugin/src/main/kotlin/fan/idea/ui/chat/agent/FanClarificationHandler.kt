package fan.idea.ui.chat.agent

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import fan.idea.core.services.FanConnectionService
import fan.idea.core.services.FanSessionService
import fan.idea.ui.chat.ClarificationOption
import fan.idea.ui.chat.FanHtmlDocumentManager
import kotlinx.coroutines.runBlocking

class FanClarificationHandler(
    private val project: Project,
    private val docManager: FanHtmlDocumentManager
) {
    private val log = Logger.getInstance(FanClarificationHandler::class.java)

    private val connectionService: FanConnectionService
        get() = ApplicationManager.getApplication().getService(FanConnectionService::class.java)
    private val sessionService: FanSessionService
        get() = project.getService(FanSessionService::class.java)

    fun showClarification(question: String, options: List<ClarificationOption>, blockId: String) {
        docManager.addClarificationBlock(blockId, question, options)
    }

    fun handleResponse(blockId: String, optionValue: String) {
        log.info("Clarification response: blockId=$blockId, option=$optionValue")
        docManager.removeClarificationBlock(blockId)

        // Send the selected option as a message
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                runBlocking {
                    val sessionId = sessionService.currentSessionId.value ?: return@runBlocking
                    val client = connectionService.getApiClient(project) ?: return@runBlocking
                    client.sendMessage(sessionId, optionValue)
                }
            } catch (e: Exception) {
                log.info("Failed to send clarification response: ${e.message}")
            }
        }
    }
}
