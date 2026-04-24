package fan.idea.ui.chat.agent

interface FanAgentEventConsumer {
    fun onTextChunk(content: String)
    fun onThinkingStart()
    fun onThinkingUpdate(text: String)
    fun onThinkingEnd()
    fun onToolUse(toolName: String, toolCallId: String, args: String)
    fun onToolResult(toolName: String, toolCallId: String, result: String, isError: Boolean)
    fun onToolUpdate(toolCallId: String, partialResult: String)
    fun onError(message: String)
    fun onSessionEnd()
}
