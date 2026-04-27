package fan.idea.ui.status

import fan.idea.api.ConnectionStatus
import java.awt.Color

object FanStatusIcons {
    // We use colored circles instead of SVG icons for simplicity
    // SVG icons can be added later for more polished look

    fun getStatusColor(status: ConnectionStatus): Color {
        return when (status) {
            ConnectionStatus.CONNECTED -> Color(76, 175, 80)     // green
            ConnectionStatus.CONNECTING -> Color(255, 193, 7)    // amber
            ConnectionStatus.RECONNECTING -> Color(255, 193, 7) // amber
            ConnectionStatus.DISCONNECTED -> Color(158, 158, 158) // gray
            ConnectionStatus.ERROR -> Color(244, 67, 54)         // red
        }
    }

    fun getStatusText(status: ConnectionStatus): String {
        return when (status) {
            ConnectionStatus.CONNECTED -> "FAN: Connected"
            ConnectionStatus.CONNECTING -> "FAN: Connecting..."
            ConnectionStatus.RECONNECTING -> "FAN: Reconnecting..."
            ConnectionStatus.DISCONNECTED -> "FAN: Disconnected"
            ConnectionStatus.ERROR -> "FAN: Error"
        }
    }
}
