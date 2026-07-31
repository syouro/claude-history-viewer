# Claude History Viewer

English | [中文](README.md)

A zero-dependency, single-file Node.js web viewer for your Claude Code conversation history under `~/.claude/projects/`. Password-protected, safe to expose through a reverse proxy.

## Quick start

```bash
node server.js
# → Claude 历史查看器：http://127.0.0.1:48213
# A random login password is generated on first run and printed once
# (also persisted to secret.json)
```

Open `http://127.0.0.1:48213`, log in with the generated password.

To keep it running with pm2:

```bash
COOKIE_PATH=/history/ SECURE_COOKIE=1 pm2 start server.js --name claude-history
pm2 save
pm2 restart claude-history   # after code changes
```

## Features

- Sessions grouped by project in the sidebar, newest first; a pinned **★ Favorites** group on top
- **Search** — instant fuzzy title filter while typing; after a ~0.3 s pause, full-text search across all sessions (subagent sidechains included) with hit counts and highlighted snippets; opening a hit shows an “N / M ↑↓” navigator that jumps between matches and auto-expands collapsed blocks
- **Filters** — project dropdown, time range (today / 7 / 30 / 90 days / 6 months / 1 year / custom start–end dates), and an “include thinking” toggle for search
- **Paged loading** — a session opens with its latest 80 messages, viewed from the bottom; scrolling up loads earlier messages on demand
- **Live tracking** — sessions written to within 2 minutes get a pulsing “in progress” badge; an open session polls for new messages and appends them incrementally, auto-following when you are at the bottom
- **Subagent sidechains** — `<sessionId>/subagents/agent-*.jsonl` files are parsed separately; chips above the conversation switch between the main thread and each subagent
- **Compaction awareness** — `summary` lines, `isCompactSummary` messages, and `compact_boundary` markers render as a summary banner, a collapsible block, and a divider respectively
- **Tool-aware rendering** — Bash shows the command, Read/Write/Edit show file paths, Edit renders a red/green diff, todo lists / questions / subagent calls get structured cards; unknown tools fall back to JSON
- **Markdown rendering** — message text and thinking rendered as Markdown, including GFM tables (column alignment, `\|` escapes, horizontal scroll on narrow screens); escaped before rendering (XSS-safe); search highlights survive rendering via sentinel characters
- **Favorites + notes** — star a session and attach a one-line note (stored in `favorites.json`)
- **Message anchors** — deep links of the form `#s=project/session[/index]`; hover a message to copy its permalink
- **Read-only sharing** — issue a 7-day, single-session, read-only link; guests get no sidebar, no list, no search
- **Usage stats** — 📊 panel with a selectable time range (7 / 30 / 90 days, last year, this year, all time, or custom start–end); totals, bar chart and per-project / per-model tables all follow the range (subagent usage included). Bars roll up daily → weekly → monthly as the range grows
- **Markdown export** — one click, sidechains and compaction summaries included
- **Dark / light theme** — follows the system, manually cyclable, remembered in localStorage
- **Mobile** — below 720 px the sidebar collapses into a drawer
- <kbd>Esc</kbd> clears the search box

## Configuration (config.json)

All settings live in `config.json` (every key optional); environment variables always take precedence:

```json
{
  "roots": ["~/.claude/projects", "/mnt/backup/claude-projects"],
  "exclude": ["-tmp-*", "-some-private-project"],
  "port": 48213,
  "host": "127.0.0.1",
  "cookiePath": "/history/",
  "secureCookie": true
}
```

- `roots` — one or more directories to scan; when the same project+session exists in several roots, the first root wins
- `exclude` — glob patterns (`*` `?`) matched against project directory names; excluded projects are hidden from the list *and* rejected by the API
- Use `CONFIG_PATH` to point at a different config file (default `./config.json`)

Local http debugging (production cookies are `Secure` and path-scoped):

```bash
SECURE_COOKIE=0 COOKIE_PATH=/ PORT=48999 node server.js
```

## Environment variables (override config.json)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `48213` | Listen port (uncommon port, meant to sit behind a proxy) |
| `HOST` | `127.0.0.1` | Bind to localhost only; expose via reverse proxy |
| `COOKIE_PATH` | `/` | Set to `/history/` when proxied under a subpath |
| `SECURE_COOKIE` | `1` | `Secure` cookie flag (https); set `0` for local http debugging |
| `VIEWER_PASSWORD` | — | Overrides the password stored in `secret.json` |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Overrides `roots` entirely (single directory) |
| `CONFIG_PATH` | `./config.json` | Config file location |

## Files

- `server.js` — backend + embedded HTML/CSS
- `app.js` — frontend logic (served at `/app.js`, includes the Markdown renderer)
- `config.json` — service config (scan roots, exclusions, port, …)
- `secret.json` — HMAC secret & password (auto-generated, never commit)
- `favorites.json` — favorites & notes (auto-generated, never commit)

## Security

- Login issues an HMAC-signed session cookie (`HttpOnly`, `SameSite=Lax`, `Secure`, 7-day TTL)
- Login rate limiting: 5 failures per IP triggers exponential backoff; wrong passwords get a fixed delay
- Constant-time password comparison; secrets persisted in `secret.json` (chmod 600)
- Whitelist validation on all path parameters (no traversal)
- Share tokens are scoped to a single session and cannot impersonate a login cookie
- Keep `secret.json` out of version control

## Reverse proxy (nginx / OpenResty example)

```nginx
location = /history { return 301 /history/; }
location /history/ {
    proxy_pass         http://127.0.0.1:48213/;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```
