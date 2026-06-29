# FAN Web Search

![Version](https://img.shields.io/badge/version-1.4.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Type](https://img.shields.io/badge/type-FAN_Extension-purple)
![Providers](https://img.shields.io/badge/providers-5-orange)

> Multi-provider web search with automatic fallback chain and web page reader for [FAN](https://github.com/fan-team/fan).

## What It Does

**fan-web-search** gives the FAN agent internet access through two tools:

- **`web_search`** — searches the web using up to 5 providers with automatic fallback (Mojeek → SearXNG → Brave → Yandex → Z.AI). Works out of the box with the built-in Mojeek meta-search — no API keys required.
- **`web_reader`** — fetches and parses any web page into clean markdown or plain text, with optional link and image summaries.

## Features

- ✅ **Zero-config search** — works immediately via built-in Mojeek meta-search
- 🔄 **Automatic fallback** — if one provider fails, the next one takes over seamlessly
- 📊 **Health probing** — providers are tested on startup and cached for fast session restores
- 🔐 **API key support** — Brave, Yandex, and Z.AI for higher-quality or specialized results
- 🐳 **SearXNG integration** — self-hosted meta-search via Docker one-liner
- 📖 **HTML→Markdown reader** — clean output with `node-html-markdown`
- 🔗 **Raw fetch fallback** — strips HTML to plain text when markdown parsing fails
- 🔒 **TLS flexibility** — custom CA certificates, relaxed or strict mode
- ⚡ **Health cache** — provider status cached to disk (5 min TTL), avoids cold starts

## Installation

```bash
fan store install fan-web-search
```

The extension auto-initializes on the next session start.

## Quick Start

No configuration needed — the built-in Mojeek meta-search works out of the box:

```
Agent, search for "TypeScript 5.0 new features"
Agent, find the official Bun documentation
Agent, search docs.python.org for asyncio examples
```

### Searching with Filters

```
Agent, search for "Rust lifetime" with recency oneWeek
Agent, search "webAssembly news" limited to developer.mozilla.org
```

### Reading Web Pages

```
Agent, read https://example.com/docs and summarize it
Agent, read that page in plain text format with a links summary
```

## Slash Commands

| Command | Description |
|---|---|
| `/web-search` | Show help |
| `/web-search init` | Interactive setup wizard |
| `/web-search check` | Probe all providers and display status table |
| `/web-search searxng` | Auto-install SearXNG in Docker |

## Tools

### `web_search`

Search the web using multiple provider backends with automatic fallback.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | `string` | ✅ | — | Search query text |
| `count` | `integer` | — | `10` | Number of results (1–50) |
| `recency_filter` | `enum` | — | `noLimit` | `noLimit`, `oneDay`, `oneWeek`, `oneMonth`, `oneYear` |
| `domain_filter` | `string` | — | — | Limit results to specific domain(s), e.g. `docs.python.org` |

Returns titles, URLs, snippets, and metadata. Falls back through the provider chain automatically on failure.

### `web_reader`

Fetch and parse a web page into structured content.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | `string` | ✅ | — | URL of the page to read |
| `return_format` | `enum` | — | `markdown` | `markdown` or `text` |
| `with_links_summary` | `boolean` | — | `false` | Include a list of links found on the page |
| `with_images_summary` | `boolean` | — | `false` | Include a list of images found on the page |
| `no_cache` | `boolean` | — | `false` | Bypass cached content |

Supports HTML, plain text, XHTML, and XML content types.

## Configuration

Config file: `~/.fan/agent/extensions/fan-web-search/config.json`

Auto-created from defaults on first run. Edit to customize providers, timeouts, API keys, and TLS settings.

### Reference

| Section | Key | Type | Default | Description |
|---|---|---|---|---|
| `search` | `defaultCount` | `integer` | `10` | Default number of search results |
| `search` | `timeout` | `integer` | `15000` | Search request timeout (ms) |
| `search.providers.meta-search` | `enabled` | `boolean` | `true` | Enable Mojeek meta-search |
| `search.providers.meta-search` | `probeTimeoutMs` | `integer` | `5000` | Health probe timeout (ms) |
| `search.providers.searxng` | `enabled` | `boolean` | `true` | Enable SearXNG |
| `search.providers.searxng` | `url` | `string` | `http://127.0.0.1:8888` | SearXNG instance URL |
| `search.providers.brave` | `enabled` | `boolean` | `true` | Enable Brave Search |
| `search.providers.brave` | `url` | `string` | `https://api.search.brave.com/...` | Brave API endpoint |
| `search.providers.yandex` | `enabled` | `boolean` | `true` | Enable Yandex Search |
| `search.providers.yandex` | `url` | `string` | `https://searchapi.api.cloud.yandex.net/...` | Yandex API endpoint |
| `search.providers.yandex` | `maxPassages` | `integer` | `2` | Max passages per result |
| `search.providers.yandex` | `groupsOnPage` | `integer` | `50` | Result groups per page |
| `search.providers.zai` | `enabled` | `boolean` | `true` | Enable Z.AI MCP search |
| `search.providers.zai` | `url` | `string` | `https://api.z.ai/...` | Z.AI MCP endpoint |
| `search.providers.zai` | `location` | `string` | `us` | Search locale |
| `search.providers.zai` | `contentSize` | `string` | `medium` | Content size (`small`/`medium`/`large`) |
| `reader` | `defaultFormat` | `string` | `markdown` | Default output format |
| `reader` | `timeout` | `integer` | `30000` | Page fetch timeout (ms) |
| `reader` | `minContentLength` | `integer` | `50` | Min content length to return |
| `reader` | `maxLinks` | `integer` | `50` | Max links in summary |
| `reader` | `maxImages` | `integer` | `30` | Max images in summary |
| `reader` | `maxConsecutiveNewlines` | `integer` | `3` | Max consecutive blank lines |
| `format` | `maxLinks` | `integer` | `20` | Max links in formatted output |
| `format` | `maxImages` | `integer` | `10` | Max images in formatted output |
| `tls` | `rejectUnauthorized` | `boolean` | `false` | Strict TLS certificate validation |
| `tls` | `caPath` | `string` | `null` | Path to custom CA bundle (.pem/.crt) |
| `apiKeys` | `braveApiKey` | `string` | `""` | Brave Search API key |
| `apiKeys` | `yandexApiKey` | `string` | `""` | Yandex Search API key |
| `apiKeys` | `yandexFolderId` | `string` | `""` | Yandex Cloud folder ID |
| `apiKeys` | `zaiApiKey` | `string` | `""` | Z.AI API key |
| `healthCacheTtlMs` | — | `integer` | `300000` | Health cache TTL (5 min) |

## Search Providers

Providers are tried in priority order. On failure, the next available provider is used automatically.

| # | Provider | Priority | API Key | Description |
|---|---|---|---|---|
| 1 | **Meta-Search (Mojeek)** | 1 | Not needed | Built-in web scraping. Works out of the box. Privacy-focused UK search engine. |
| 2 | **SearXNG** | 2 | Not needed | Self-hosted meta-search engine. Aggregates results from Google, Bing, DuckDuckGo and more. Requires Docker. |
| 3 | **Brave Search** | 3 | `braveApiKey` | Independent search API. High quality, privacy-respecting. Requires [free API key](https://brave.com/search/api/). |
| 4 | **Yandex Search** | 4 | `yandexApiKey` + `yandexFolderId` | Russian search engine API. Good for Cyrillic content. Requires [Yandex Cloud account](https://cloud.yandex.com/). |
| 5 | **Z.AI MCP** | 5 | `zaiApiKey` | AI-powered search via MCP protocol. Enhanced summaries and relevance. Requires [Z.AI account](https://z.ai/). |

## API Keys

API keys are stored in `config.json` under the `apiKeys` section.

### Brave Search

1. Go to [https://brave.com/search/api/](https://brave.com/search/api/)
2. Sign up for a free account (up to 2,000 queries/month on Free tier)
3. Copy your API key
4. Set `apiKeys.braveApiKey` in config

### Yandex Search API

1. Create a [Yandex Cloud account](https://cloud.yandex.com/)
2. Enable the **Search API** service
3. Create an API key and note your **folder ID**
4. Set `apiKeys.yandexApiKey` and `apiKeys.yandexFolderId` in config

### Z.AI

1. Go to [https://z.ai/](https://z.ai/)
2. Create an account and obtain an API key
3. Set `apiKeys.zaiApiKey` in config

## TLS Configuration

By default, TLS verification is relaxed (`rejectUnauthorized: false`) to work with self-signed certificates and corporate proxies.

### Custom CA Certificate

To trust a specific CA (e.g., corporate proxy):

```json
{
  "tls": {
    "rejectUnauthorized": true,
    "caPath": "/path/to/custom-ca-bundle.pem"
  }
}
```

### Environment Variable Fallback

Alternatively, set the `NODE_EXTRA_CA_CERTS` environment variable:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/custom-ca-bundle.pem
```

This is picked up automatically by the `undici` HTTP client used internally.

## SearXNG Setup

SearXNG is a privacy-respecting meta-search engine that aggregates results from multiple backends (Google, Bing, DuckDuckGo, Wikipedia, etc.).

### Quick Install (Docker)

Run the slash command from within any FAN session:

```
/web-search searxng
```

This automatically:
1. Checks that Docker and Docker Compose are installed
2. Pulls the latest SearXNG image
3. Starts a container named `fan-searxng` on port `8888`

### Manual Install

```bash
docker run -d \
  --name fan-searxng \
  -p 8888:8080 \
  -e SEARXNG_SECRET=changeme \
  -e BASE_URL=http://localhost:8888/ \
  searxng/searxng:latest
```

After installation, the SearXNG provider is enabled in config by default. Verify connectivity:

```
/web-search check
```

### SearXNG URL

Default: `http://127.0.0.1:8888`

To change, update `search.providers.searxng.url` in `config.json`.

## Requirements

- **Runtime:** Node.js 18+ or Bun
- **Dependencies:** `undici`, `@sinclair/typebox`, `node-html-markdown` (auto-installed)
- **Optional:** Docker (for SearXNG), API keys (for Brave/Yandex/Z.AI)

## License

[MIT](https://opensource.org/licenses/MIT) © FAN Team
