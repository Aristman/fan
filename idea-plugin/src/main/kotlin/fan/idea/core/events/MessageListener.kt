package fan.idea.core.events

import com.intellij.util.messages.Topic
import fan.idea.api.FanEvent

interface MessageListener {
    fun onMessageReceived(event: FanEvent) {}
    fun onGeneratingChanged(isGenerating: Boolean) {}

    companion object {
        val TOPIC: Topic<MessageListener> = Topic.create(
            "FAN.MessageChanged",
            MessageListener::class.java
        )
    }
}
