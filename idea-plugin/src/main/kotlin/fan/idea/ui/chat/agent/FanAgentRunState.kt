package fan.idea.ui.chat.agent

class FanAgentRunState {
    var currentStreamId: String? = null
    var currentThinkingId: String? = null
    val pendingToolBlocks = mutableMapOf<String, String>()

    fun reset() {
        currentStreamId = null
        currentThinkingId = null
        pendingToolBlocks.clear()
    }
}
