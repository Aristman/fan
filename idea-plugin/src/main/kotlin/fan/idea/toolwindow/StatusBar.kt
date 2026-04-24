package fan.idea.toolwindow

import fan.idea.api.ConnectionStatus
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import javax.swing.JLabel
import javax.swing.JPanel

/**
 * Simple connection status indicator: colored dot + text.
 * Used in FanChatPanel's app bar to show connection state.
 */
class StatusBar : JPanel(FlowLayout(FlowLayout.LEFT, 5, 0)) {
    private val dot = JPanel()
    private val label = JLabel("Disconnected")

    init {
        isOpaque = false
        dot.preferredSize = Dimension(8, 8)
        dot.isOpaque = true
        updateStatus(ConnectionStatus.DISCONNECTED)
        add(dot)
        add(label)
    }

    fun updateStatus(status: ConnectionStatus) {
        when (status) {
            ConnectionStatus.CONNECTED -> {
                dot.background = Color(0x4CAF50) // Green
                label.text = "Connected"
            }
            ConnectionStatus.CONNECTING -> {
                dot.background = Color(0xFFC107) // Yellow
                label.text = "Connecting..."
            }
            ConnectionStatus.RECONNECTING -> {
                dot.background = Color(0xFFC107) // Yellow
                label.text = "Reconnecting..."
            }
            ConnectionStatus.DISCONNECTED -> {
                dot.background = Color(0x9E9E9E) // Gray
                label.text = "Disconnected"
            }
            ConnectionStatus.ERROR -> {
                dot.background = Color(0xF44336) // Red
                label.text = "Connection Error"
            }
        }
        repaint()
    }
}
