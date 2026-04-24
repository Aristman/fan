package fan.idea.ui.chat.agent

object FanToolCallFormatter {

    fun getIcon(toolName: String): String {
        return when (toolName) {
            "read" -> "📄"
            "write" -> "✏️"
            "edit" -> "📝"
            "bash" -> "$"
            "grep", "find" -> "🔍"
            else -> "🔧"
        }
    }

    fun getSummary(toolName: String, args: String, maxLen: Int = 80): String {
        return when {
            args.contains("\"path\"") || args.contains("\"file\"") -> {
                extractJsonValue(args, "path") ?: extractJsonValue(args, "file") ?: "File"
            }
            args.contains("\"command\"") -> {
                val cmd = extractJsonValue(args, "command") ?: args
                if (cmd.length > maxLen) cmd.take(maxLen) + "..." else cmd
            }
            args.contains("\"pattern\"") -> {
                "Search: ${extractJsonValue(args, "pattern") ?: ""}"
            }
            else -> if (args.length > maxLen) args.take(maxLen) + "..." else args
        }
    }

    private fun extractJsonValue(json: String, key: String): String? {
        val pattern = """"$key"\s*:\s*"([^"]*)"""".toRegex()
        return pattern.find(json)?.groupValues?.get(1)
    }
}
