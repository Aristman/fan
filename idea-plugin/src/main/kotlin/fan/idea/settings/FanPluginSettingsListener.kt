package fan.idea.settings

/**
 * Listener interface for settings changes.
 * Implementations can react to server URL, token, or UI preference changes.
 */
interface FanPluginSettingsListener {
    fun onServerUrlChanged(newUrl: String)
    fun onAuthTokenChanged(newToken: String)
    fun onSettingsChanged()
}
