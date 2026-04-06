# @robinmarin/opencode-teams

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
| `team_interrupt` | Interrupt a busy member mid-task and deliver a priority message. |
| `team_task_add` | Add a task to the team's task board. |
| `team_task_claim` | Claim a pending task (respects dependency ordering). |
| `team_task_done` | Mark a task as completed and report newly unblocked tasks. |
| `team_post` | Post a message to the team's channel. Supports @mentions. |
| `team_history` | Read recent messages from the team's channel history. |
| `team_announce` | Broadcast a message to all active members including the sender. |
| `team_react` | Add a reaction to a channel message. |
| `team_prune` | Compact the events log, keeping only the most recent N entries. |

## How it works

- Team state is persisted to `~/.config/opencode/teams/<teamName>/config.json`
- When a member goes idle after being busy, the plugin automatically notifies the lead
- Spawned sub-agents receive a system prompt instructing them not to use team tools

## Installation

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["npm:@robinmarin/opencode-teams"]
}
```

Restart OpenCode. The 15 team tools will be available in your session.

## Local Development

```bash
# 1. Install dependencies
bun install

# 2. Build
bun run build

# 3. Point OpenCode at the local build
# Add to ~/.config/opencode/opencode.json:
# {
#   "plugin": ["file:///absolute/path/to/opencode-teams/dist/index.js"]
# }
```

### Testing the TUI plugin

The TUI plugin (`dist/tui.jsx`) is discovered automatically by opencode from the same
package — no separate entry in `opencode.json` is needed.

```bash
# 1. Build
bun run build

# 2. Point opencode at the local dist/index.js (server plugin)
#    In ~/.config/opencode/opencode.json:
#    { "plugin": ["file:///absolute/path/to/opencode-teams/dist/index.js"] }
#    opencode will also load dist/tui.jsx automatically via the ./tui export.

# 3. Launch opencode, open a session, and run team_create from the lead session.
#    The sidebar should show the live team status panel.
#    Use ctrl+t to toggle the panel on/off.
```

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

## TUI Plugin

`src/tui.tsx` exports a live team status panel that runs inside the opencode TUI process as a SolidJS component tree. It is registered as the `./tui` entry point and loaded automatically alongside the server plugin.

**Slots registered:**

| Slot | Content |
|---|---|
| `sidebar_content` | Full member list with per-member status colors (ready/busy/error), task summary |
| `session_prompt_right` | Compact badge: `2 working / 1 idle` |

**Command:** `team.status.toggle` (keybind `ctrl+t`) — show/hide the sidebar panel.

State is read directly from `~/.config/opencode/teams/*/config.json` via `fs.watch`; the panel updates immediately on any file change or `session.idle` / `session.status` event.

---

## Known Limitations

**Sub-agent tool isolation is instruction-only.** The `@opencode-ai/sdk` `session.create()` body only accepts `{ parentID, title }` — there is no deny list or permissions field. Sub-agents are told not to use team tools via their system prompt, but a model could ignore this instruction. A future SDK version may expose per-session deny rules; at that point the 15 team tools should be explicitly denied for all spawned sessions.

**Mid-turn idle notification race.** If the lead session is mid-turn (actively generating a response) when a teammate goes idle, the `session.idle` event fires and the plugin sends a `promptAsync` to the lead. OpenCode queues this message; the lead will not re-enter its loop until the current turn completes. There is no mechanism to interrupt an in-progress turn.

**No nested teams.** Sub-agents spawned by a lead cannot themselves create teams or spawn further sub-agents. The team management tools are reserved for the original lead session.
