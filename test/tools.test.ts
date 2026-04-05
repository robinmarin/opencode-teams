import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@opencode-ai/plugin";
import { setTestTeamsDir, writeTeam } from "../src/state.js";
import type { TeamConfig } from "../src/state.js";
import { createTools } from "../src/tools.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-teams-tools-"));
  setTestTeamsDir(tmpDir);
});

afterEach(async () => {
  setTestTeamsDir(undefined);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Minimal client stub
// ---------------------------------------------------------------------------
type SessionCreateResult = {
  data: { id: string };
  error: undefined;
  request: Request;
  response: Response;
};

type VoidResult = {
  data: void;
  error: undefined;
  request: Request;
  response: Response;
};

function makeStubClient(sessionId = "stub-session-new") {
  return {
    session: {
      create: async () =>
        ({
          data: { id: sessionId },
          error: undefined,
          request: new Request("http://localhost"),
          response: new Response(),
        }) satisfies SessionCreateResult,
      promptAsync: async () =>
        ({
          data: undefined,
          error: undefined,
          request: new Request("http://localhost"),
          response: new Response(),
        }) satisfies VoidResult,
    },
  } as unknown as Parameters<typeof createTools>[0];
}

// ---------------------------------------------------------------------------
// Minimal ToolContext stub
// ---------------------------------------------------------------------------
function makeContext(sessionID = "lead-session") {
  return {
    sessionID,
    messageID: "msg-001",
    agent: "default",
    directory: tmpDir,
    worktree: tmpDir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Helper to call a tool's execute function
// ---------------------------------------------------------------------------
// biome-ignore lint/suspicious/noExplicitAny: test helper needs flexible args
async function callTool(
  tools: Record<string, ToolDefinition>,
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: flexible test args
  args: any,
  sessionID?: string,
): Promise<string> {
  const t = tools[name];
  if (t === undefined) throw new Error(`Tool "${name}" not found`);
  return t.execute(args, makeContext(sessionID));
}

// ---------------------------------------------------------------------------
// Seed team helper
// ---------------------------------------------------------------------------
function seedTeam(overrides?: Partial<TeamConfig>): Promise<void> {
  return writeTeam({
    name: "alpha",
    leadSessionId: "lead-session",
    members: {},
    tasks: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("team_create", () => {
  it("creates a new team and returns confirmation", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_create", { name: "alpha" });
    expect(result).toContain("alpha");
    expect(result).not.toContain("Error");
  });

  it("returns an error string when team already exists", async () => {
    await seedTeam();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_create", { name: "alpha" });
    expect(result).toContain("Error");
    expect(result).toContain("already exists");
  });
});

describe("team_spawn", () => {
  it("returns an error string when team does not exist", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_spawn", {
      teamName: "ghost",
      memberName: "alice",
      role: "engineer",
      initialPrompt: "Do stuff",
    });
    expect(result).toContain("Error");
    expect(result).toContain("does not exist");
  });

  it("spawns a member and returns confirmation", async () => {
    await seedTeam();
    const tools = createTools(makeStubClient("new-sess-123"));
    const result = await callTool(tools, "team_spawn", {
      teamName: "alpha",
      memberName: "alice",
      role: "backend engineer",
      initialPrompt: "Build the API",
    });
    expect(result).toContain("alice");
    expect(result).toContain("new-sess-123");
    expect(result).not.toContain("Error");
  });

  it("returns an error string when member name is already taken", async () => {
    await seedTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "existing-sess",
          status: "ready",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_spawn", {
      teamName: "alpha",
      memberName: "alice",
      role: "engineer",
      initialPrompt: "Do stuff",
    });
    expect(result).toContain("Error");
    expect(result).toContain("already exists");
  });
});

describe("team_message", () => {
  it("returns an error string when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_message", {
      teamName: "ghost",
      to: "alice",
      message: "hello",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns an error string when member not found", async () => {
    await seedTeam();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_message", {
      teamName: "alpha",
      to: "nobody",
      message: "hello",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("sends a message to the lead without error", async () => {
    await seedTeam();
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_message",
      { teamName: "alpha", to: "lead", message: "status update" },
      "other-session",
    );
    expect(result).not.toContain("Error");
    expect(result).toContain("lead");
  });
});

describe("team_status", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_status", { teamName: "ghost" });
    expect(result).toContain("Error");
  });

  it("returns formatted status with member and task info", async () => {
    await seedTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "sess-alice",
          status: "busy",
          agentType: "default",
          model: "claude-3",
          spawnedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_status", { teamName: "alpha" });
    expect(result).toContain("alpha");
    expect(result).toContain("alice");
    expect(result).toContain("busy");
    expect(result).toContain("pending=0");
  });
});
