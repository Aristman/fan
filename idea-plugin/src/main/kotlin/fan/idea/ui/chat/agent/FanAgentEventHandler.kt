package fan.idea.ui.chat.agent

import com.intellij.openapi.diagnostic.Logger
import fan.idea.api.FanEvent
import fan.idea.ui.chat.FanHtmlDocumentManager

class FanAgentEventHandler(private val docManager: FanHtmlDocumentManager) {

    private val log = Logger.getInstance(FanAgentEventHandler::class.java)
    private val runState = FanAgentRunState()

    fun handleEvent(event: FanEvent) {
        when (event) {
            is FanEvent.AgentStart -> {
                runState.reset()
                runState.currentStreamId = docManager.startAssistantStream()
                log.info("Agent run started, streamId=${runState.currentStreamId}")
            }
            is FanEvent.TextDelta -> {
                runState.currentStreamId?.let { id ->
                    docManager.updateAssistantStream(id, event.delta)
                }
            }
            is FanEvent.TextEnd -> {
                runState.currentStreamId?.let { id ->
                    docManager.endAssistantStream(id)
                }
                runState.currentStreamId = null
            }
            is FanEvent.MessageStart -> {
                val thinkingId = "thinking-${System.nanoTime()}"
                runState.currentThinkingId = thinkingId
                docManager.showThinkingIndicator(thinkingId)
            }
            is FanEvent.ThinkingDelta -> {
                runState.currentThinkingId?.let { id ->
                    docManager.updateThinkingContent(id, event.delta)
                }
            }
            is FanEvent.ThinkingEnd -> {
                runState.currentThinkingId?.let { id ->
                    docManager.completeThinking(id)
                }
                runState.currentThinkingId = null
            }
            is FanEvent.ToolExecutionStart -> {
                val elementId = "tool-${event.toolCallId}"
                runState.pendingToolBlocks[event.toolCallId] = elementId
                val icon = FanToolCallFormatter.getIcon(event.toolName)
                val summary = FanToolCallFormatter.getSummary(event.toolName, event.args.toString())
                docManager.addToolCallBlock(
                    id = elementId,
                    toolName = event.toolName,
                    status = "pending",
                    icon = icon,
                    summary = summary
                )
            }
            is FanEvent.ToolExecutionEnd -> {
                val elementId = runState.pendingToolBlocks.remove(event.toolCallId)
                if (elementId != null) {
                    val status = if (event.isError) "error" else "success"
                    docManager.updateToolCallStatus(elementId, status)
                    val resultText = event.result ?: ""
                    val truncated = if (resultText.length > 500) resultText.take(500) + "..." else resultText
                    val escaped = truncated.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                    docManager.updateToolCallResult(elementId, escaped)
                }
            }
            is FanEvent.ToolExecutionUpdate -> {
                val elementId = runState.pendingToolBlocks[event.toolCallId]
                if (elementId != null) {
                    val partial = event.partialResult ?: ""
                    val truncated = if (partial.length > 500) partial.take(500) + "..." else partial
                    val escaped = truncated.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                    docManager.updateToolCallResult(elementId, escaped)
                }
            }
            is FanEvent.Error -> {
                docManager.addErrorMessage("Error", event.message)
            }
            is FanEvent.TurnEnd, is FanEvent.AgentEnd -> {
                runState.reset()
                log.info("Agent run ended")
            }
            else -> { /* Connected, TurnStart, MessageEnd */ }
        }
    }
}
