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
| `team_task_add` | Add a task to the team's task board. |
| `team_task_claim` | Claim a pending task (respects dependency ordering). |
| `team_task_done` | Mark a task as completed and report newly unblocked tasks. |

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

Restart OpenCode. The nine team tools will be available in your session.

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

## TODO

### Live team status panel (TUI plugin)

The current status bar is rendered by injecting ANSI escape sequences into the lead's chat session via `promptAsync()` — it only updates when a `session.idle` event fires, and it is a static string inside a chat message, not a real UI element. The right fix is a TUI plugin that injects a live SolidJS component directly into the opencode interface.

---

**Implementation prompt (copy-paste ready):**

```
Implement a TUI plugin entry point for the opencode-teams package that renders a live
team status panel inside the opencode TUI. Do not touch or remove any existing code in
src/index.ts, src/tools.ts, src/messaging.ts, src/state.ts, or src/renderer.ts.

--- BACKGROUND ---

The package already exports a server-side plugin from src/index.ts. The @opencode-ai/plugin
package (already installed) also supports a separate TUI plugin entry point, defined in
@opencode-ai/plugin/tui. A TUI plugin is a SolidJS component tree that runs inside the
opencode terminal UI process. It is registered independently from the server plugin.

The TUI plugin type signature (from node_modules/@opencode-ai/plugin/dist/tui.d.ts):

  type TuiPlugin = (api: TuiPluginApi, options: PluginOptions | undefined, meta: TuiPluginMeta) => Promise<void>

  type TuiPluginModule = {
    id?: string;
    tui: TuiPlugin;
    server?: never;   // must NOT be present — this is TUI-only
  }

The module must export `tui` (not a default export).

--- SLOTS ---

opencode exposes named injection slots via api.slots.register(). The relevant slots are
defined in TuiHostSlotMap (node_modules/@opencode-ai/plugin/dist/tui.d.ts, lines 271–304):

  sidebar_content   — main body of the sidebar, receives { session_id: string }
  sidebar_footer    — bottom of the sidebar, receives { session_id: string }
  session_prompt_right — right side of the session prompt bar, receives { session_id: string }

Use sidebar_content as the primary slot. This gives a full-height panel that can render
the htop-style member list. Use session_prompt_right for a compact summary badge
(e.g. "3 working / 1 idle").

api.slots.register() takes a TuiSlotPlugin, which is a SolidPlugin<TuiSlotMap, TuiSlotContext>
from @opentui/solid. Check the @opentui/solid types after installing it to understand the
exact object shape required (likely { slots: [...slotNames], render: (props, context) => JSX }).

--- EVENT BUS ---

Subscribe to opencode events with:

  const unsub = api.event.on('session.idle', (event) => { ... })

Call unsub() on disposal. Register the disposal via:

  api.lifecycle.onDispose(unsub)

The event type is Extract<Event, { type: 'session.idle' }> from @opencode-ai/sdk/v2.
event.properties.sessionID is the session that went idle.

Also subscribe to 'session.status' to catch busy transitions without waiting for idle.

--- STATE ---

Team state is persisted on disk at:

  ~/.config/opencode/teams/<teamName>/config.json

The schema is defined in src/state.ts (TeamConfig type). Key fields:

  {
    name: string,
    leadSessionId: string,
    members: Record<string, {
      name: string,
      sessionId: string,
      status: "ready" | "busy" | "shutdown_requested" | "shutdown" | "error",
      spawnedAt: string,   // ISO timestamp
      currentTask?: string
    }>,
    tasks: Record<string, { ... }>
  }

The TUI plugin cannot access the server plugin's in-memory state. It must read the JSON
files directly from disk. Use Bun.file(...).json() or fs.readFile to read config.json.
To discover which teams exist, glob ~/.config/opencode/teams/*/config.json.

Watch for changes using fs.watch (Node-compatible in Bun) on the teams directory so the
panel updates whenever the server plugin writes new state. Use a SolidJS createSignal to
hold the parsed team array and update it on each file-change event.

api.state.path.state gives the opencode state directory (not the teams dir — compute the
teams dir as os.homedir() + '/.config/opencode/teams').

--- DETERMINING WHICH SESSION IS THE LEAD ---

The sidebar_content slot receives session_id as a prop. Compare that session_id against
the leadSessionId field in each team's config.json to determine which team (if any) this
sidebar belongs to. Only render the status panel if session_id matches a lead.

--- COMMAND + KEYBIND ---

Register a toggle command so the user can show/hide the panel:

  api.command.register(() => [{
    title: "Toggle team status",
    value: "team.status.toggle",
    description: "Show or hide the live team member status panel",
    category: "Teams",
    keybind: "ctrl+t",
  }])

Use api.lifecycle.onDispose to clean up the command registration (the register call
returns an unregister function).

--- LIFECYCLE ---

All subscriptions and watchers must be cleaned up:

  api.lifecycle.onDispose(unsubIdle)
  api.lifecycle.onDispose(unsubStatus)
  api.lifecycle.onDispose(() => watcher.close())
  api.lifecycle.onDispose(unregisterCommand)

api.lifecycle.signal is an AbortSignal that fires when the plugin is torn down — you may
pass it to any fetch/async work as well.

--- THEMING ---

Do not hardcode colors. Use api.theme.current for palette values:

  api.theme.current.success  — ready members (RGBA)
  api.theme.current.warning  — busy/working members
  api.theme.current.error    — error members
  api.theme.current.textMuted — idle/shutdown members
  api.theme.current.text      — member names
  api.theme.current.border    — separator lines

The theme is reactive — re-read api.theme.current inside component render, not at setup time.

--- BUILD CHANGES REQUIRED ---

1. Install peer dependencies:
     bun add -d @opentui/solid @opentui/core

2. Add a JSX configuration to tsconfig.json so TypeScript understands SolidJS JSX:
     "jsx": "preserve",
     "jsxImportSource": "@opentui/solid"
   (Confirm the correct jsxImportSource by checking @opentui/solid's package.json
   "exports" or its own tsconfig after installing.)

3. Add src/tui.ts as a second entry point in package.json:
   - In "exports": add  "./tui": "./dist/tui.js"
   - In "files": ensure "dist/tui.js" and "dist/tui.d.ts" are included

4. The build command is `bun run build` (runs tsc → dist/). Confirm tsc picks up tui.ts
   automatically (it will, since it is under src/ and rootDir is src/).

--- NEW FILES ---

Create only src/tui.ts (and any SolidJS component files you split out under src/).
Do not create a separate tsconfig or build script — reuse the existing one.

--- TESTING ---

There is no test harness for TUI plugins in this project. Add a section to the README
under Local Development explaining how to test the TUI plugin manually:
  - build with `bun run build`
  - point opencode at the local dist/index.js (server) and dist/tui.js (TUI) via
    opencode.json: { "plugin": ["file:///absolute/path/to/dist/index.js"] }
    (opencode discovers the tui export automatically from the same package)
  - spawn a team and observe the sidebar

--- WHAT NOT TO DO ---

- Do not remove or modify the existing ANSI status bar rendering in src/renderer.ts or
  src/messaging.ts. The in-chat rendering remains as a fallback for non-TUI contexts.
- Do not add a KV or IPC layer between the server plugin and TUI plugin — read disk directly.
- Do not import from zod directly; if you need schema validation in tui.ts use the bundled
  tool.schema instance (but you likely won't need Zod in the TUI layer).
- Do not add a polling interval shorter than 500ms to avoid hammering disk I/O; prefer
  fs.watch events over polling entirely.
```

---

## Known Limitations

**Sub-agent tool isolation is instruction-only.** The `@opencode-ai/sdk` `session.create()` body only accepts `{ parentID, title }` — there is no deny list or permissions field. Sub-agents are told not to use team tools via their system prompt, but a model could ignore this instruction. A future SDK version may expose per-session deny rules; at that point the six team tools should be explicitly denied for all spawned sessions.

**Mid-turn idle notification race.** If the lead session is mid-turn (actively generating a response) when a teammate goes idle, the `session.idle` event fires and the plugin sends a `promptAsync` to the lead. OpenCode queues this message; the lead will not re-enter its loop until the current turn completes. There is no mechanism to interrupt an in-progress turn.

**No nested teams.** Sub-agents spawned by a lead cannot themselves create teams or spawn further sub-agents. The team management tools are reserved for the original lead session.
