---
name: environment
description: Development environment setup and runtime configuration for knowledge-base-server
type: project
---

## Prerequisites
- Node.js ≥ 18.0.0
- `npm install` (no build step needed)
- `npm link` to make `kb` CLI available globally

## Runtime data location
All state lives in `~/.knowledge-base/` (never in the repo):
- `kb.db` — SQLite database
- `files/` — Copies of ingested files
- `config.json` — Password hash
- `kb.pid` — PID for `kb stop`

## Environment variables (`.env` in repo root)
```
KB_PASSWORD=           # Required on first run (dashboard login)
KB_PORT=3838           # Optional, default 3838
OBSIDIAN_VAULT_PATH=   # Required for: kb classify, kb summarize, kb vault reindex, kb capture-x
KB_API_KEY_CLAUDE=     # Optional, for Claude remote API access
KB_API_KEY_OPENAI=     # Optional, for ChatGPT access
KB_API_KEY_GEMINI=     # Optional, for Gemini access
BETTER_AUTH_SECRET=    # Optional, needed for OAuth remote access
BETTER_AUTH_URL=       # Optional, OAuth issuer URL (e.g. https://yourdomain.com)
CLASSIFY_MODEL=        # Optional, default: claude-haiku-4-5-20251001
KB_CORS_ORIGINS=       # Optional, comma-separated extra CORS origins
```

## Starting the server
```bash
# First run — password will be prompted or read from KB_PASSWORD env var
KB_PASSWORD=yourpass kb start

# Subsequent runs — password already stored in ~/.knowledge-base/config.json
kb start
```

## MCP registration
```bash
kb register   # Writes MCP config to ~/.claude.json
```

After registration, Claude Code has all 16 KB tools available automatically.

## Systemd deployment (Linux production)
```bash
sudo cp kb-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable kb-server
sudo systemctl start kb-server
journalctl -u kb-server -f   # View logs
```

## Obsidian vault commands (require OBSIDIAN_VAULT_PATH)
```bash
OBSIDIAN_VAULT_PATH=~/Documents/vault kb classify --dry-run
OBSIDIAN_VAULT_PATH=~/Documents/vault kb summarize --limit=10
OBSIDIAN_VAULT_PATH=~/Documents/vault kb vault reindex
```

## First-run auto-ingest
On first start (empty DB), the server auto-ingests:
- `~/knowledgebase/` if it exists
- All `~/.claude/projects/*/memory/` directories

## Test suite
```bash
npm test   # node --test tests/*.test.js
```
61 tests across 10 files. Test-framework: `node:test` + `node:assert` (geen externe deps nodig).
