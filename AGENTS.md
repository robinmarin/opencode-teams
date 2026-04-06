# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run build       # tsc → dist/
bun test            # run all tests
bun run typecheck   # tsc --noEmit
bun run lint        # biome check src (exit 0 = clean; infos/warnings are non-blocking)
```

Run a single test file:
```bash
bun test test/state.test.ts
```

## Architecture

The plugin exposes a single `TeamPlugin` export (`src/index.ts`) conforming to `@opencode-ai/plugin`'s `Plugin` type. On init it receives a live `OpencodeClient` and returns two hooks:

- **`tool`** — 15 tools built by `createTools(client)` in `src/tools.ts`
- **`event`** — an event handler built by `createEventHandler(client)` in `src/messaging.ts`

### State (`src/state.ts`)

Team configs are persisted as JSON at `~/.config/opencode/teams/<name>/config.json`. All writes are atomic (write to `.tmp` then `fs.rename`). Concurrent writes to the same team are serialised with a per-name promise chain (`Map<string, Promise<void>>`).

`setTestTeamsDir(dir)` redirects all disk I/O to a temp directory — used in every test file instead of overriding `HOME`.

### Tools (`src/tools.ts`)

All 15 tools use `tool.schema` (the plugin's bundled Zod instance, v4.1.8) rather than importing `zod` directly. Importing from the root `zod` package causes a version-mismatch type error because the plugin vendors its own copy.

`session.create` has no system-prompt field; member role context is injected via the `system` field in the first `session.promptAsync` call.

### Messaging (`src/messaging.ts`)

The `event` hook receives every OpenCode event. It filters for `session.idle`, looks up the session in team state, and:
- **Member going idle after busy** → updates status to `ready`, notifies the lead via `promptAsync`
- **Lead going idle with busy members** → logs a debug line only; does **not** auto-prompt the lead (anti-loop guard)

### SDK result shape

`client.session.create()` returns `{ data, error, request, response }` where the union is `{ data: T; error: undefined } | { data: undefined; error: E }`. Check `result.error !== undefined` to detect failure (not `!== null`).
