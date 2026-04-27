package fan.idea.core.events

import com.intellij.util.messages.Topic
import fan.idea.api.ConnectionStatus

interface ConnectionListener {
    fun onConnectionStateChanged(status: ConnectionStatus) {}
    fun onConnectionError(message: String) {}

    companion object {
        val TOPIC: Topic<ConnectionListener> = Topic.create(
            "FAN.ConnectionChanged",
            ConnectionListener::class.java
        )
    }
}
