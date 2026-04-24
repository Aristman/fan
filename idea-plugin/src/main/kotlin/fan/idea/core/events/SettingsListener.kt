package fan.idea.core.events

import com.intellij.util.messages.Topic
import fan.idea.settings.FanPluginSettings

interface SettingsListener {
    fun onSettingsChanged(settings: FanPluginSettings) {}

    companion object {
        val TOPIC: Topic<SettingsListener> = Topic.create(
            "FAN.SettingsChanged",
            SettingsListener::class.java
        )
    }
}
