# opencode-teams Plugin — Implementation Plan

> **Note:** This document is historical. The implementation now includes 15 tools (not 6). Some tool listings and architectural details below may be outdated. For current tool documentation, see README.md.

## Phase 1 Research Summary

### Source 1 & 2: anomalyco/opencode#12711 and dev.to article
These URLs appear to be synthetic (the repos/articles do not exist publicly).
Design decisions are therefore driven entirely by the actual SDK type definitions.
**Documented as a Blocker** — see Blockers section below.

### Source 3 & 4: codeaashu/claude-code docs
These repos do not exist publicly; codeaashu is not an Anthropic-affiliated account.
Design inspiration drawn from Claude Code's publicly documented architecture instead.

### Source 4: Actual API surface (@opencode-ai/plugin v1.3.15, @opencode-ai/sdk v1.3.15)

#### Plugin contract
```typescript
type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>

type PluginInput = {
  client: OpencodeClient   // full SDK client
  project: Project
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell
}

interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  tool?: { [key: string]: ToolDefinition }
  // ... other hooks
}
```

#### Tool contract
```typescript
tool<Args extends ZodRawShape>({
  description: string,
  args: Args,
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<string>
})

type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: Record<string, any> }): void
  ask(input: AskInput): Promise<void>
}
```

#### SDK calls used in this plugin
| Call | Signature | Purpose |
|---|---|---|
| `client.session.create` | `({ body?: { parentID?, title? }, query?: { directory? } })` | Spawn sub-session |
| `client.session.promptAsync` | `({ path: { id }, body: { parts, system?, model?, tools? } })` | Fire-and-forget message send |
| `client.session.prompt` | Same as above but awaits AI response | Blocking message send |
| `Hooks.event` | `({ event: Event }) => Promise<void>` | Receive all events (preferred over `client.event.subscribe`) |
| `EventSessionIdle` | `{ type: "session.idle", properties: { sessionID } }` | Auto-wake trigger |

**Note on system prompt injection**: `client.session.create` has no `system` field.
System context is injected by setting `body.system` in the first `promptAsync` call.
This sets the system prompt only for that turn; subsequent turns rely on conversation history.

---

## File Inventory

### `src/state.ts`
Manages team configuration persisted to `~/.config/opencode/teams/<name>/config.json`.

**Responsibilities:**
- Define all TypeScript types (TeamConfig, TeamMember, TeamTask, etc.)
- `readTeam(name)` — read and parse JSON from disk
- `writeTeam(config)` — atomic write (write to `.tmp`, then `fs.rename`)
- `updateMember(teamName, memberName, patch)` — read-modify-write with lock
- `findTeamBySession(sessionId)` — scan all teams for a session ID
- `listTeams()` — list directories in `~/.config/opencode/teams/`

**Concurrency**: In-process lock using a `Map<string, Promise<void>>` chain per team name.

### `src/tools.ts`
Six tool definitions using `tool()` from `@opencode-ai/plugin`.

Each tool wraps its entire execute body in try/catch and returns a readable error string on failure.

| Tool | Key args | SDK calls |
|---|---|---|
| `team_create` | name, description? | `writeTeam` |
| `team_spawn` | teamName, memberName, role, initialPrompt, model? | `session.create`, `session.promptAsync`, `updateMember` |
| `team_message` | teamName, to, message | `session.promptAsync` |
| `team_broadcast` | teamName, message | calls team_message per member |
| `team_status` | teamName | `readTeam` |
| `team_shutdown` | teamName, memberName? | `session.promptAsync`, `updateMember` |

### `src/messaging.ts`
Exports `createEventHandler(client)` returning an async event handler `(input: { event: Event }) => Promise<void>`.

**Logic:**
1. On `session.idle`: call `findTeamBySession(sessionId)`
2. If not found → ignore
3. If found as lead → check if any members are `busy`; if so log debug (no auto-prompt)
4. If found as member → update status to `ready`; if was `busy` → notify lead via `session.promptAsync`

**Deliberately conservative**: no retry, no auto-prompt to lead to avoid loops.

### `src/index.ts`
Wires everything together. Exports `TeamPlugin` as default and named export.

```typescript
export const TeamPlugin: Plugin = async ({ client }) => {
  return {
    event: createEventHandler(client),
    tool: allTools,
  }
}
```

---

## On-Disk State Schema

File path: `~/.config/opencode/teams/<teamName>/config.json`

```jsonc
{
  "name": "my-team",
  "leadSessionId": "sess_abc123",
  "members": {
    "alice": {
      "name": "alice",
      "sessionId": "sess_def456",
      "status": "ready",          // "ready" | "busy" | "shutdown_requested" | "shutdown" | "error"
      "agentType": "default",
      "model": "anthropic/claude-sonnet-4-5",
      "spawnedAt": "2026-04-05T10:00:00.000Z"
    }
  },
  "tasks": {
    "task_001": {
      "id": "task_001",
      "title": "Implement auth",
      "description": "...",
      "status": "pending",        // "pending" | "in_progress" | "completed" | "blocked"
      "assignee": "alice",
      "dependsOn": [],
      "createdAt": "2026-04-05T10:00:00.000Z"
    }
  },
  "createdAt": "2026-04-05T10:00:00.000Z"
}
```

---

## Tool List with Argument Schemas

### team_create
```typescript
args: {
  name: z.string().describe("Unique team name"),
  description: z.string().optional().describe("Optional team description"),
}
```

### team_spawn
```typescript
args: {
  teamName: z.string().describe("Name of the team to add the member to"),
  memberName: z.string().describe("Unique name for this team member"),
  role: z.string().describe("Role description for this member (e.g. 'backend engineer', 'code reviewer')"),
  initialPrompt: z.string().describe("Initial task or instructions to send to the member"),
  model: z.string().optional().describe("Model override (e.g. 'anthropic/claude-haiku-4-5'). Defaults to session model."),
}
```

### team_message
```typescript
args: {
  teamName: z.string().describe("Name of the team"),
  to: z.string().describe("Recipient: member name or 'lead'"),
  message: z.string().describe("Message to send"),
}
```

### team_broadcast
```typescript
args: {
  teamName: z.string().describe("Name of the team"),
  message: z.string().describe("Message to broadcast to all active members"),
}
```

### team_status
```typescript
args: {
  teamName: z.string().describe("Name of the team"),
}
```

### team_shutdown
```typescript
args: {
  teamName: z.string().describe("Name of the team"),
  memberName: z.string().optional().describe("Member to shut down. Omit to shut down all members."),
}
```

---

## Known Risks and Unknowns

### Blockers

1. **Research URLs do not exist** — anomalyco/opencode, the dev.to article, and codeaashu/claude-code are synthetic URLs that return 404. Design is based entirely on the actual SDK type definitions. All architectural decisions are documented in this file.

2. **`system` field persistence** — The `system` field in `SessionPromptData` may only apply to the specific turn it's sent with, not persist as a session-level system prompt. Mitigation: include role context in the first message text body as well, so the agent has context regardless.

3. **Sender identity in tools** — `ToolContext` provides `sessionID` of the caller. When `team_message` is called, we know who the sender is from context. When we identify whether the sender is lead or a member, we use `findTeamBySession(context.sessionID)`.

4. **`model` field in spawn** — `SessionCreateData` has no model field. The model must be specified per-prompt in `SessionPromptAsyncData.body.model`. We include it in the `promptAsync` call, not session create.

5. **No parent session system prompt inheritance** — Spawned sessions are independent. There's no API to set a default/persistent system prompt on a session. Our approach: inject role context via `system` in first `promptAsync` call.

### Other Unknowns

- Whether `session.idle` fires after EVERY AI turn or only when a session has been idle for a configurable duration.
- Whether calling `promptAsync` on a session that is already processing causes queuing or an error.
- Behavior of `tools: { [key: string]: boolean }` in `SessionPromptData` — can we use this to disable team tools for subagents?

---

## Testing Strategy

### test/state.test.ts
- Use `bun:test` with a temp directory fixture
- Test null return for missing team
- Test round-trip write/read correctness
- Test partial patch via `updateMember`
- Test concurrent writes (2 calls with no await between, verify no data loss)
- Test `findTeamBySession` with known session ID

### test/tools.test.ts
- Stub the OpenCode client with a minimal object satisfying `OpencodeClient` shape
- Test Zod schema validation (invalid arg types)
- Test error string return for duplicate team (team_create)
- Test error string return for missing team (team_spawn)
- Test error string return for missing member (team_message)
- Test team_status output structure

### test/messaging.test.ts
- Test that events with `type !== "session.idle"` are ignored
- Test that `session.idle` for a non-team session is ignored
- Test that `session.idle` for a team member triggers lead notification
- Test that `session.idle` for the lead with busy members logs debug and does NOT prompt lead

---

## Done Checklist

- [ ] PLAN.md written
- [ ] All 4 source files implemented with no type errors
- [ ] All tests pass
- [ ] README has local testing instructions
- [ ] `bun run build` produces dist/index.js with no errors
