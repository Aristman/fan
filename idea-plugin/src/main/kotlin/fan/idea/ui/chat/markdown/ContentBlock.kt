package fan.idea.ui.chat.markdown

sealed interface ContentBlock {
    data class TextBlock(val content: String, val styles: List<InlineStyle> = emptyList()) : ContentBlock
    data class CodeBlock(val language: String?, val code: String) : ContentBlock
    data class HeadingBlock(val level: Int, val content: String) : ContentBlock
    data class ListBlock(val ordered: Boolean, val items: List<ListItem>, val depth: Int = 0) : ContentBlock
    data class BlockquoteBlock(val content: String) : ContentBlock
    object HorizontalRuleBlock : ContentBlock
    data class TableBlock(val headers: List<String>, val rows: List<List<String>>) : ContentBlock
    data class ImageBlock(val alt: String, val url: String) : ContentBlock
}

data class ListItem(
    val content: String,
    val children: List<ListItem> = emptyList()
)

enum class InlineStyle {
    BOLD, ITALIC, STRIKETHROUGH, CODE, LINK
}
