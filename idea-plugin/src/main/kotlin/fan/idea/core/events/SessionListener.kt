package fan.idea.core.events

import com.intellij.util.messages.Topic
import fan.idea.api.SessionSummary

interface SessionListener {
    fun onSessionCreated(session: SessionSummary) {}
    fun onSessionDeleted(id: String) {}
    fun onSessionSelected(session: SessionSummary) {}
    fun onSessionsUpdated(sessions: List<SessionSummary>) {}

    companion object {
        val TOPIC: Topic<SessionListener> = Topic.create(
            "FAN.SessionChanged",
            SessionListener::class.java
        )
    }
}
