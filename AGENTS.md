# Claude Code Metrics Exporter

Node.js service that exports Claude Code metrics to OpenTelemetry by reading local stats files.

## Architecture

Unlike OpenCode (which uses SSE), Claude Code exporter **polls a local JSON file**:

1. Reads `~/.claude/stats-cache.json` every 30 seconds
2. Reads `~/.claude/projects/*/sessions-index.json` for active session info
3. Exports cumulative totals as observable gauges

## Data Sources

### stats-cache.json

Contains aggregated metrics:
```json
{
  "totalSessions": 135,
  "totalMessages": 41264,
  "modelUsage": {
    "claude-sonnet-4-20250514": {
      "inputTokens": 1234567,
      "outputTokens": 98765,
      "cacheReadInputTokens": 5432100,
      "cacheCreationInputTokens": 123456,
      "costUSD": 12.34
    }
  },
  "dailyActivity": [
    { "date": "2026-01-19", "toolCallCount": 150 }
  ]
}
```

### sessions-index.json

Per-project session metadata for active session tracking:
```json
{
  "entries": [
    {
      "sessionId": "abc123",
      "firstPrompt": "Help me with...",
      "projectPath": "/home/user/project",
      "modified": "2026-01-19T12:00:00Z",
      "messageCount": 42
    }
  ]
}
```

## Important: Stats Updates Are NOT Real-Time

The `stats-cache.json` file is only updated by Claude Code:
- When sessions close
- Periodically during long sessions (unclear interval)
- On Claude Code restart

**Metrics will appear stale during active sessions.** This is expected behavior.

## Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `claude.code.session.count` | Gauge | source |
| `claude.code.session.active` | Gauge | source |
| `claude.code.message.count` | Gauge | source |
| `claude.code.token.usage` | Gauge | type, model, source |
| `claude.code.cost.usage` | Gauge | model, source |
| `claude.code.tool.usage` | Gauge | source |
| `claude.code.session.info` | Gauge | session_id, title, directory, source |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_DATA_DIR` | `~/.claude` | Claude Code data directory |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4317` | OTLP endpoint |
| `EXPORT_INTERVAL` | `10000` | Metrics export interval (ms) |
| `POLL_INTERVAL` | `30000` | Stats file poll interval (ms) |
| `INSTANCE_ID` | hostname | Unique instance identifier |
| `ACTIVE_SESSION_HOURS` | `1` | Hours to consider session "active" |

## Debugging

```bash
# Check when stats were last updated
ls -la ~/.claude/stats-cache.json

# View raw stats
cat ~/.claude/stats-cache.json | jq '.totalMessages, .totalSessions'

# Watch exporter logs
docker logs -f observer-claude-code-exporter-1

# Rebuild after changes
docker compose build claude-code-exporter && docker compose up -d claude-code-exporter
```

## Common Issues

1. **Metrics never change** - Normal during active session; will update when session closes
2. **"No stats available"** - `stats-cache.json` doesn't exist or is unreadable
3. **Active sessions always 0** - Check `ACTIVE_SESSION_HOURS` and session file timestamps
