# FAN Landing Page

> PipBoy / Fallout 3 terminal style landing page for **FAN (Fast Agents Network)**.

## Overview

Одностраничный сайт-лэндинг в стиле терминала Fallout 3 (ROBCO TERMLINK / PipBoy). Содержит основную информацию о FAN как инструменте для разработки и как open-source проекте, а также команды установки.

## Files

| File | Description |
|------|-------------|
| `index.html` | Main landing page structure |
| `styles.css` | Fallout 3 terminal CRT styling, animations, responsive layout |
| `script.js` | Typewriter effect, tab switching, navigation, clipboard copy, stats counter |
| `README.md` | This file |

## Features

- **CRT terminal effects**: scanlines, screen glow, vignette, noise, flicker
- **Animations**: boot sequence, typewriter header, blinking cursor, animated counters
- **ASCII graphics**: FAN logo in ASCII, terminal frames
- **Clipboard copy**: copy install command with one click
- **Online-only install**: ready binaries and source builds will be available later
- **Keyboard navigation**: press `[TAB]` to cycle sections
- **Responsive**: works on desktop, tablet and mobile

## Running Locally

### Option 1: Open directly

```bash
cd lending
open index.html        # macOS
xdg-open index.html    # Linux
start index.html       # Windows
```

### Option 2: Use a local server

```bash
cd lending
python3 -m http.server 8080
# or
npx serve .
```

Then open http://localhost:8080

### Option 3: From project root

```bash
cd /home/aristman/projects/fan
npx serve lending
```

## Deployment

The landing is a static site. You can deploy it to any static hosting:

- GitHub Pages
- Netlify
- Vercel
- fan.sea-agents.ru root
- Any nginx/apache static host

### Example: GitHub Pages

1. Push `lending/` directory to repository
2. Enable GitHub Pages
3. Set source to `lending/` folder or root if deployed as subdomain

### Example: Copy to web server

```bash
rsync -avz lending/ user@fan.sea-agents.ru:/var/www/fan/
```

## Styling

Primary colors (Fallout 3 terminal phosphor green):

| Name | Value | Usage |
|------|-------|-------|
| `--terminal-bg` | `#0a0f0a` | Page background |
| `--phosphor-main` | `#4af626` | Main terminal green |
| `--phosphor-main-bright` | `#7fff00` | Bright green highlights |
| `--phosphor-amber` | `#ffb000` | Amber accents (prompts, stats) |
| `--phosphor-red` | `#ff3333` | Error / danger (reserved) |

Fonts:
- **VT323** — main terminal font
- **Share Tech Mono** — fallback / ASCII art

## Updating Content

Edit `index.html` to change text. Main sections:

- `#boot` — boot sequence + welcome
- `#about` — about FAN + animated stats
- `#features` — feature cards
- `#install` — installation commands
- `#commands` — CLI commands reference
- `#project` — project links + license info

## License

MIT © Fast Agents Network Team
