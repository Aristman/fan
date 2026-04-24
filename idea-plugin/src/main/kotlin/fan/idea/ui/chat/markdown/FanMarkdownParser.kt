package fan.idea.ui.chat.markdown

class FanMarkdownParser {
    
    fun parse(markdown: String): List<ContentBlock> {
        val blocks = mutableListOf<ContentBlock>()
        val lines = markdown.lines()
        var i = 0
        
        while (i < lines.size) {
            val line = lines[i]
            
            when {
                // Fenced code block
                line.trimStart().startsWith("```") -> {
                    val language = line.trimStart().removePrefix("```").trim()
                    val codeLines = mutableListOf<String>()
                    i++
                    while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                        codeLines.add(lines[i])
                        i++
                    }
                    blocks.add(ContentBlock.CodeBlock(language.ifBlank { null }, codeLines.joinToString("\n")))
                    i++ // skip closing ```
                }
                // Heading
                line.matches(Regex("^#{1,6}\\s+.*")) -> {
                    val level = line.indexOfFirst { !it.isWhitespace() && it == '#' }
                        .let { line.take(it + 1).count { it == '#' } }
                    val content = line.removePrefix("#".repeat(level)).trim()
                    blocks.add(ContentBlock.HeadingBlock(level, content))
                }
                // Horizontal rule
                line.matches(Regex("^(-{3,}|\\*{3,}|_{3,})\\s*$")) -> {
                    blocks.add(ContentBlock.HorizontalRuleBlock)
                }
                // Blockquote
                line.trimStart().startsWith(">") -> {
                    val quoteLines = mutableListOf<String>()
                    while (i < lines.size && lines[i].trimStart().startsWith(">")) {
                        quoteLines.add(lines[i].trimStart().removePrefix(">").trim())
                        i++
                    }
                    blocks.add(ContentBlock.BlockquoteBlock(quoteLines.joinToString("\n")))
                }
                // Table
                line.contains("|") && i + 1 < lines.size && lines[i + 1].matches(Regex("^\\|?\\s*[-:]+[-|\\s:]*$")) -> {
                    val headers = line.split("|").map { it.trim() }.filter { it.isNotEmpty() }
                    i += 2 // skip header + separator
                    val rows = mutableListOf<List<String>>()
                    while (i < lines.size && lines[i].contains("|") && lines[i].trim().isNotEmpty()) {
                        val row = lines[i].split("|").map { it.trim() }.filter { it.isNotEmpty() }
                        if (row.size >= headers.size) {
                            rows.add(row.take(headers.size))
                        }
                        i++
                    }
                    if (headers.isNotEmpty()) {
                        blocks.add(ContentBlock.TableBlock(headers, rows))
                    }
                }
                // Unordered list
                line.trimStart().matches(Regex("^[-*+]\\s+.*")) -> {
                    val items = mutableListOf<ListItem>()
                    while (i < lines.size && lines[i].trimStart().matches(Regex("^[-*+]\\s+.*"))) {
                        val content = lines[i].trimStart().replaceFirst(Regex("^[-*+]\\s+"), "")
                        items.add(ListItem(content))
                        i++
                    }
                    blocks.add(ContentBlock.ListBlock(ordered = false, items = items))
                }
                // Ordered list
                line.trimStart().matches(Regex("^\\d+\\.\\s+.*")) -> {
                    val items = mutableListOf<ListItem>()
                    while (i < lines.size && lines[i].trimStart().matches(Regex("^\\d+\\.\\s+.*"))) {
                        val content = lines[i].trimStart().replaceFirst(Regex("^\\d+\\.\\s+"), "")
                        items.add(ListItem(content))
                        i++
                    }
                    blocks.add(ContentBlock.ListBlock(ordered = true, items = items))
                }
                // Empty line
                line.isBlank() -> { i++ }
                // Text paragraph
                else -> {
                    val textLines = mutableListOf<String>()
                    while (i < lines.size && lines[i].isNotBlank() &&
                           !lines[i].trimStart().startsWith("#") &&
                           !lines[i].trimStart().startsWith("```") &&
                           !lines[i].trimStart().startsWith(">") &&
                           !lines[i].trimStart().startsWith("-") &&
                           !lines[i].trimStart().startsWith("* ") &&
                           !lines[i].trimStart().startsWith("+ ")) {
                        textLines.add(lines[i])
                        i++
                    }
                    if (textLines.isNotEmpty()) {
                        blocks.add(ContentBlock.TextBlock(textLines.joinToString("\n")))
                    }
                }
            }
        }
        
        return blocks
    }
}
