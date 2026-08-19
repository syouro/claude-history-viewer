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
- **tmux bridge** (optional, off by default) — remote-control a running Claude Code from your phone. The backend captures the terminal and parses it into an interaction state; the frontend renders native controls: send a message, tap to answer a permission/choice prompt, <kbd>Esc</kbd> to interrupt, <kbd>⇧⇥</kbd> to cycle permission modes (the button shows the current mode). A ▣ console lists panes, shows a raw ANSI terminal as a fallback, and can create / kill sessions from the web. See the dedicated section below
- **Multiple agent CLIs** — besides Claude Code, sidebar tabs for **Codex** (`~/.codex/sessions`) and **Agy** (Google Antigravity CLI, `~/.gemini/antigravity-cli`) history: the same list / search / stats / favorites / sharing / export / delete, with tool-aware rendering per CLI. Each tab appears automatically when its directory exists. (Agy transcripts carry no token usage, and long compacted conversations may be missing their beginning)
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
  "secureCookie": true,
  "tmux": true
}
```

- `roots` — one or more directories to scan; when the same project+session exists in several roots, the first root wins
- `exclude` — glob patterns (`*` `?`) matched against project directory names; excluded projects are hidden from the list *and* rejected by the API
- `tmux` — enable the tmux bridge (off by default; see below)
- Use `CONFIG_PATH` to point at a different config file (default `./config.json`)

## tmux bridge (remote-control Claude Code from your phone)

Once enabled (`"tmux": true`, or the `TMUX_UI=1` env var), a logged-in user can:

- **Composer bar at the bottom of a session view** — when the session's cwd matches a tmux pane (a `claude` process is preferred), you can message the running Claude Code directly. Permission / choice prompts are parsed into **native buttons** — one tap to answer. A busy state is shown, with <kbd>Esc</kbd> to interrupt and <kbd>⇧⇥</kbd> to cycle permission modes (the button shows the current mode). Combined with live tracking, this is a full remote Claude client in the browser.
- **▣ tmux console** (sidebar icon) — list every tmux pane and open any pane's raw terminal (ANSI colors, polled every 1.5 s). The same composer bar sends text and common keys.
- **Create / kill sessions from the web** — spin up a new tmux session (pick a directory with autocomplete from your history, optionally a startup command — type `claude` to launch a fresh Claude Code); a pane card's ✕ kills it (with confirmation). A startup command falls back to a shell on exit, so the session isn't lost.

Security: the three `/api/tmux*` routes are login-only (share tokens rejected), named keys go through a whitelist, and the whole feature is off unless explicitly enabled. It effectively grants remote command execution to logged-in users, so use a strong password and serve over https.

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
| `TMUX_UI` | `0` | Enable the tmux bridge (not `TMUX`: tmux injects that name into child processes) |

## Files

- `server.js` — backend + embedded HTML/CSS
- `app.js` — frontend logic (served at `/app.js`, includes the Markdown renderer)
- `config.json` — service config (scan roots, exclusions, port, …)
- `secret.json` — HMAC secret & password (auto-generated, never commit)
- `favorites.json` — favorites & notes (auto-generated, never commit)
- `android/` — Android shell app (WebView, see below)
- `.github/workflows/android.yml` — GitHub Actions workflow that builds the APK on tag push

## Design decisions

- **Zero dependencies** — no express / database / markdown library: hand-written routing
  and auth on the backend, a hand-written Markdown renderer on the frontend, JSON files as
  the "database". Deployment = two files + Node, no supply chain; the renderer covers the
  common GFM subset and falls back to plain text for anything it doesn't recognize.
- **Two-tier index** — session summaries stay resident in memory; search blobs are
  lazy-loaded from disk and released after idling. Search pre-filters on blobs and only
  fully parses candidate sessions. Built for small-memory VPSes: browsing costs almost no
  memory, at the price of one extra disk read on the first search after a cold start. All
  indexes are derived data — delete them any time; the jsonl files are the only source of truth.
- **The tmux bridge is a translation layer, not a web terminal** — it captures the pane,
  parses the interaction state (menu / busy / idle) and renders native controls, which is
  what makes it usable on a phone; unparseable screens fall back to a raw terminal view.
  The TUI-parsing pitfalls (octal escapes, `>` vs `❯` prompts, strict menu detection to
  avoid false positives) are all pinned down by tests.
- **Sharing is deliberately weak, remote control deliberately narrow** — share tokens are
  scoped to one session: no listing, no search, no impersonating a login. tmux routes are
  off by default, login-only, with a whitelist for named keys. Path parameters go through a
  whitelist (no traversal), passwords and tokens use constant-time comparison, login is
  rate-limited with backoff.
- **A new data source = one more object** — the claude / codex / agy differences (scan,
  locate, parse, staleness stamp) are collapsed into a `SOURCES` adapter table; the main
  flow is source-agnostic. Frontend tool rendering is a registry the same way.

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

## Android shell app

`android/` contains a minimal WebView shell (pure Android SDK, no third-party deps) that wraps the viewer as a phone app:

- **Get the APK**: push a tag (`git tag v1.0 && git push --tags`) and GitHub Actions builds it and attaches it to the Release; or trigger the workflow manually and grab the artifact.
- **First launch** asks for your server URL (e.g. `https://your.domain/history/`); the login cookie persists.
- **Change the URL**: long-press the back button, or long-press the app icon → "服务器设置".
- Same-host links stay in the shell; external links and downloads open in the system browser.
- Reverse-proxy Basic Auth is supported: a native dialog asks once, then credentials are remembered.
- **Signing**: defaults to a debug signature (uninstall before installing a differently-signed build). For stable upgrades, set the repo secrets `KEYSTORE_BASE64` (base64 of a keystore), `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.

The server itself stays zero-dependency; the shell is an independent subproject.

## License

[MIT](LICENSE) © syouro
