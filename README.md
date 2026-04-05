# opencode-teams

An [OpenCode](https://opencode.ai) plugin that adds agent teams — spawn, coordinate, and shut down sub-agent sessions directly from your lead session.

## Tools

| Tool | Description |
|---|---|
| `team_create` | Create a new team. The calling session becomes the lead. |
| `team_spawn` | Spawn a sub-agent with a role and initial prompt. |
| `team_message` | Send a message to a specific member or the lead. |
| `team_broadcast` | Send a message to all active members. |
| `team_status` | Show member statuses and task counts. |
| `team_shutdown` | Shut down one or all members. |
| `team_task_add` | Add a task to the team's task board. |
| `team_task_claim` | Claim a pending task (respects dependency ordering). |
| `team_task_done` | Mark a task as completed and report newly unblocked tasks. |

## How it works

- Team state is persisted to `~/.config/opencode/teams/<teamName>/config.json`
- When a member goes idle after being busy, the plugin automatically notifies the lead
- Spawned sub-agents receive a system prompt instructing them not to use team tools

## Local Testing

```bash
# 1. Install dependencies
bun install

# 2. Build
bun run build

# 3. Symlink the built plugin
mkdir -p ~/.config/opencode/plugins
ln -sf $(pwd)/dist/index.js ~/.config/opencode/plugins/opencode-teams.js

# 4. Register the plugin in your OpenCode config
# Add to ~/.config/opencode/opencode.json:
# {
#   "plugin": ["file://~/.config/opencode/plugins/opencode-teams.js"]
# }
```

After restarting OpenCode, the six team tools will be available in your session.

## Development

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Lint
bun run lint
```

## State schema

Team configs live at `~/.config/opencode/teams/<name>/config.json`:

```json
{
  "name": "my-team",
  "leadSessionId": "sess_abc123",
  "members": {
    "alice": {
      "name": "alice",
      "sessionId": "sess_def456",
      "status": "ready",
      "agentType": "default",
      "model": "anthropic/claude-sonnet-4-5",
      "spawnedAt": "2026-04-05T10:00:00.000Z"
    }
  },
  "tasks": {},
  "createdAt": "2026-04-05T10:00:00.000Z"
}
```

Member statuses: `ready | busy | shutdown_requested | shutdown | error`

## Known Limitations

**Sub-agent tool isolation is instruction-only.** The `@opencode-ai/sdk` `session.create()` body only accepts `{ parentID, title }` — there is no deny list or permissions field. Sub-agents are told not to use team tools via their system prompt, but a model could ignore this instruction. A future SDK version may expose per-session deny rules; at that point the six team tools should be explicitly denied for all spawned sessions.

**Mid-turn idle notification race.** If the lead session is mid-turn (actively generating a response) when a teammate goes idle, the `session.idle` event fires and the plugin sends a `promptAsync` to the lead. OpenCode queues this message; the lead will not re-enter its loop until the current turn completes. There is no mechanism to interrupt an in-progress turn.

**No nested teams.** Sub-agents spawned by a lead cannot themselves create teams or spawn further sub-agents. The team management tools are reserved for the original lead session.
