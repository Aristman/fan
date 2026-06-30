# fan-confluence

Confluence Data Center integration extension for [fan](https://github.com/seaagents/fan).

Provides 6 tools for reading, writing, and searching Confluence pages directly from LLM agent sessions.

## Features

- **Read**: List spaces, list pages, read page content (Storage Format → Markdown)
- **Write**: Create and update pages (Markdown → Storage Format)
- **Search**: CQL-based search across Confluence content
- **Caching**: In-memory cache for read operations (auto-invalidated on update)
- **Error handling**: Actionable error messages in Russian for the LLM
- **Truncation**: Large pages are truncated with links to full versions

## Installation

1. Copy this directory to `~/.fan/agent/extensions/fan-confluence/`
2. Install dependencies:
   ```bash
   cd ~/.fan/agent/extensions/fan-confluence
   npm install
   ```
3. Configure:
   ```bash
   cp .env.example .env
   # Edit .env with your Confluence URL, PAT, and space key
   ```

## Configuration

Edit `~/.fan/agent/extensions/fan-confluence/.env`:

```env
CONFLUENCE_BASE_URL=https://confluence.example.com
CONFLUENCE_PAT=your-personal-access-token
CONFLUENCE_SPACE_KEY=DEV
# Optional: default parent page ID for new pages
CONFLUENCE_DEFAULT_PARENT_ID=
```

### Personal Access Token (PAT)

Generate a PAT in Confluence:
1. Navigate to **Profile → Personal Access Tokens**
2. Create a new token with read/write permissions

## Tools

| Tool | Description |
|------|-------------|
| `confluence_list_spaces` | List available spaces |
| `confluence_list_pages` | List pages in a space (paginated) |
| `confluence_read_page` | Read page content as Markdown |
| `confluence_search` | Search using CQL |
| `confluence_create_page` | Create a new page from Markdown |
| `confluence_update_page` | Update an existing page with Markdown |

## Commands

| Command | Description |
|---------|-------------|
| `/confluence` | Show connection status and configuration |

## Dependencies

- [confluence.js](https://www.npmjs.com/package/confluence.js) — Confluence REST API client
- [turndown](https://github.com/mixmark-io/turndown) — HTML to Markdown converter
- [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) — GFM tables, strikethrough, task lists
- [marked](https://marked.js.org/) — Markdown to HTML renderer

## Supported Format Conversions

### Storage Format → Markdown (reading)
- Headings (h1-h6)
- Paragraphs, bold, italic, strikethrough
- Unordered and ordered lists
- Task lists (checkboxes)
- Tables (GFM)
- Code blocks (`ac:structured-macro code`)
- Panel macros (info, warning, note, tip) → blockquotes
- Internal links (`ac:link` with `ri:page`)

### Markdown → Storage Format (writing)
- Headings (h1-h6)
- Bold, italic, strikethrough
- Unordered and ordered lists
- Task lists → Confluence task status
- Tables → HTML tables
- Code blocks → `ac:structured-macro code` with language
- Blockquotes
- Links and images → `ac:image` with `ri:url`

## Limitations

- Confluence Data Center / Server only (not Cloud)
- PAT authentication only (no Basic Auth fallback yet)
- No attachment support
- No comment support
- No label management
- Macro-only code blocks (no plain HTML pre/code in Storage Format for writing)

## License

MIT
