import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@opencode-ai/plugin";
import { appendEvent, getEvents, readTeam, setTestTeamsDir, writeTeam } from "../src/state.js";
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

/**
 * A stub client that captures the order of events: when state was written
 * relative to when promptAsync fired.
 */
function makeOrderCapturingClient(
  sessionId: string,
  events: string[],
  teamName: string,
  memberName: string,
) {
  return {
    session: {
      create: async () => {
        events.push("session.create");
        return {
          data: { id: sessionId },
          error: undefined,
          request: new Request("http://localhost"),
          response: new Response(),
        } satisfies SessionCreateResult;
      },
      promptAsync: async () => {
        // At the moment promptAsync fires, check if state already exists
        const team = await readTeam(teamName);
        if (team?.members[memberName] !== undefined) {
          events.push("state.written.before.prompt");
        } else {
          events.push("state.NOT.written.before.prompt");
        }
        events.push("promptAsync");
        return {
          data: undefined,
          error: undefined,
          request: new Request("http://localhost"),
          response: new Response(),
        } satisfies VoidResult;
      },
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

describe("team_spawn state-before-prompt ordering", () => {
  it("writes member state before firing promptAsync", async () => {
    await seedTeam();
    const events: string[] = [];
    const client = makeOrderCapturingClient(
      "ordered-sess-001",
      events,
      "alpha",
      "alice",
    );
    const tools = createTools(client);
    const result = await callTool(tools, "team_spawn", {
      teamName: "alpha",
      memberName: "alice",
      role: "engineer",
      initialPrompt: "Do stuff",
    });
    expect(result).not.toContain("Error");
    // The state must be written before promptAsync is called
    const stateWrittenIdx = events.indexOf("state.written.before.prompt");
    const promptIdx = events.indexOf("promptAsync");
    expect(stateWrittenIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(stateWrittenIdx).toBeLessThan(promptIdx);
  });
});

// ---------------------------------------------------------------------------
// Seed helpers for task tests
// ---------------------------------------------------------------------------
function seedTeamWithTasks(overrides?: Partial<TeamConfig>): Promise<void> {
  return writeTeam({
    name: "alpha",
    leadSessionId: "lead-session",
    members: {
      alice: {
        name: "alice",
        sessionId: "alice-sess",
        status: "ready",
        agentType: "default",
        model: "claude-3",
        spawnedAt: new Date().toISOString(),
      },
    },
    tasks: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("team_task_add", () => {
  it("adds a task and returns the task ID", async () => {
    await seedTeamWithTasks();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_add", {
      teamName: "alpha",
      title: "Build API",
      description: "Implement the REST endpoints",
    });
    expect(result).not.toContain("Error");
    expect(result).toContain("task_");
    // Verify it was persisted
    const team = await readTeam("alpha");
    expect(Object.keys(team?.tasks ?? {}).length).toBe(1);
  });

  it("returns error when team does not exist", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_add", {
      teamName: "ghost",
      title: "x",
      description: "y",
    });
    expect(result).toContain("Error");
  });
});

describe("team_task_claim", () => {
  it("returns error when task does not exist", async () => {
    await seedTeamWithTasks();
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_task_claim",
      { teamName: "alpha", taskId: "task_nonexistent" },
      "alice-sess",
    );
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error when dependencies are not completed", async () => {
    const blockerId = "task_111";
    await seedTeamWithTasks({
      tasks: {
        [blockerId]: {
          id: blockerId,
          title: "Blocker",
          description: "Must run first",
          status: "pending",
          assignee: null,
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
        task_222: {
          id: "task_222",
          title: "Dependent",
          description: "Depends on blocker",
          status: "pending",
          assignee: null,
          dependsOn: [blockerId],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_task_claim",
      { teamName: "alpha", taskId: "task_222" },
      "alice-sess",
    );
    expect(result).toContain("Error");
    expect(result).toContain(blockerId);
  });

  it("succeeds when all dependencies are completed", async () => {
    const doneId = "task_done";
    await seedTeamWithTasks({
      tasks: {
        [doneId]: {
          id: doneId,
          title: "Done task",
          description: "Already complete",
          status: "completed",
          assignee: "alice",
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
        task_next: {
          id: "task_next",
          title: "Next task",
          description: "Depends on done",
          status: "pending",
          assignee: null,
          dependsOn: [doneId],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_task_claim",
      { teamName: "alpha", taskId: "task_next" },
      "alice-sess",
    );
    expect(result).not.toContain("Error");
    expect(result).toContain("in_progress");
    const team = await readTeam("alpha");
    expect(team?.tasks["task_next"]?.status).toBe("in_progress");
  });
});

describe("team_task_done", () => {
  it("marks task completed and reports unblocked tasks", async () => {
    const prereqId = "task_prereq";
    await seedTeamWithTasks({
      tasks: {
        [prereqId]: {
          id: prereqId,
          title: "Prereq",
          description: "Must be done first",
          status: "in_progress",
          assignee: "alice",
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
        task_waiting: {
          id: "task_waiting",
          title: "Waiting task",
          description: "Blocked by prereq",
          status: "pending",
          assignee: null,
          dependsOn: [prereqId],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_done", {
      teamName: "alpha",
      taskId: prereqId,
    });
    expect(result).not.toContain("Error");
    expect(result).toContain("completed");
    expect(result).toContain("task_waiting");
    const team = await readTeam("alpha");
    expect(team?.tasks[prereqId]?.status).toBe("completed");
  });

  it("marks task completed with no unblocked tasks when none depend on it", async () => {
    await seedTeamWithTasks({
      tasks: {
        task_solo: {
          id: "task_solo",
          title: "Solo task",
          description: "No dependants",
          status: "in_progress",
          assignee: "alice",
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_done", {
      teamName: "alpha",
      taskId: "task_solo",
    });
    expect(result).not.toContain("Error");
    expect(result).toContain("completed");
    // No "Newly unblocked" section
    expect(result).not.toContain("Newly unblocked");
  });
});

// ---------------------------------------------------------------------------
// Seed helpers for channel tests
// ---------------------------------------------------------------------------
function seedTeamWithMembers(overrides?: Partial<TeamConfig>): Promise<void> {
  return writeTeam({
    name: "alpha",
    leadSessionId: "lead-session",
    members: {
      alice: {
        name: "alice",
        sessionId: "alice-sess",
        status: "ready",
        agentType: "default",
        model: "claude-3",
        spawnedAt: new Date().toISOString(),
      },
      bob: {
        name: "bob",
        sessionId: "bob-sess",
        status: "busy",
        agentType: "default",
        model: "claude-3",
        spawnedAt: new Date().toISOString(),
      },
    },
    tasks: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("team_post", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_post", {
      teamName: "ghost",
      message: "Hello",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("posts message to channel without mentions", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_post",
      { teamName: "alpha", message: "Hello team!" },
      "alice-sess",
    );
    expect(result).not.toContain("Error");
    expect(result).toContain("Posted to channel:");
    // Verify event was stored
    const { events } = await getEvents("alpha", 10);
    expect(events.length).toBe(1);
    expect(events[0].content).toBe("Hello team!");
    expect(events[0].sender).toBe("alice");
  });

  it("posts message with mentions and notifies mentioned members", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_post",
      { teamName: "alpha", message: "Hey @bob", mentions: ["bob"] },
      "alice-sess",
    );
    expect(result).not.toContain("Error");
    expect(result).toContain("Posted to channel:");
    // Verify event has mentions
    const { events } = await getEvents("alpha", 10);
    expect(events[0].mentions).toEqual(["bob"]);
  });

  it("ignores invalid mention targets", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_post",
      { teamName: "alpha", message: "Hey @ghost", mentions: ["ghost"] },
      "alice-sess",
    );
    expect(result).not.toContain("Error");
    // Should still post but without the invalid mention
    const { events } = await getEvents("alpha", 10);
    expect(events[0].mentions).toBeUndefined();
  });
});

describe("team_history", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_history", { teamName: "ghost" });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns 'No channel messages yet.' for empty channel", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_history", { teamName: "alpha" });
    expect(result).toContain("No channel messages yet.");
  });

  it("returns formatted history with messages", async () => {
    await seedTeamWithMembers();
    await appendEvent("alpha", {
      type: "message",
      sender: "alice",
      senderId: "alice-sess",
      content: "First message",
    });
    await appendEvent("alpha", {
      type: "message",
      sender: "bob",
      senderId: "bob-sess",
      content: "Second message",
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_history", { teamName: "alpha" });
    expect(result).toContain("Channel history:");
    expect(result).toContain("alice");
    expect(result).toContain("First message");
    expect(result).toContain("bob");
    expect(result).toContain("Second message");
  });

  it("respects limit parameter", async () => {
    await seedTeamWithMembers();
    for (let i = 0; i < 5; i++) {
      await appendEvent("alpha", {
        type: "message",
        sender: "alice",
        senderId: "alice-sess",
        content: `Message ${i}`,
      });
    }
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_history", {
      teamName: "alpha",
      limit: 2,
    });
    // Should only show last 2
    expect(result).toContain("Message 3");
    expect(result).toContain("Message 4");
    expect(result).not.toContain("Message 0");
  });
});

describe("team_announce", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_announce", {
      teamName: "ghost",
      message: "Hello",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("appends announcement to channel", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_announce",
      { teamName: "alpha", message: "All hands meeting at 3pm" },
      "alice-sess",
    );
    expect(result).not.toContain("Error");
    expect(result).toContain("Announcement sent to");
    // Verify event was stored
    const { events } = await getEvents("alpha", 10);
    const announcementEvent = events.find(
      (e) => e.content.includes("All hands meeting"),
    );
    expect(announcementEvent).toBeDefined();
    expect(announcementEvent?.type).toBe("message");
  });
});

describe("team_react", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_react", {
      teamName: "ghost",
      messageId: "evt_123",
      reaction: "+1",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error for invalid reaction", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_react", {
      teamName: "alpha",
      messageId: "evt_123",
      reaction: "invalid",
    });
    expect(result).toContain("Error");
    expect(result).toContain("Invalid reaction");
  });

  it("appends valid reaction event", async () => {
    await seedTeamWithMembers();
    // First post a message to react to
    const { events } = await getEvents("alpha", 10);
    const msgId = events.length > 0 ? events[0].id : "evt_seed";
    if (events.length === 0) {
      await appendEvent("alpha", {
        type: "message",
        sender: "alice",
        senderId: "alice-sess",
        content: "Test message",
      });
    }
    const { events: eventsAfterPost } = await getEvents("alpha", 10);
    const targetId = eventsAfterPost[0].id;

    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_react",
      { teamName: "alpha", messageId: targetId, reaction: "+1" },
      "bob-sess",
    );
    expect(result).not.toContain("Error");
    expect(result).toContain("+1");
    // Verify reaction was stored
    const { events: finalEvents } = await getEvents("alpha", 10);
    const reactionEvent = finalEvents.find((e) => e.type === "reaction");
    expect(reactionEvent).toBeDefined();
    expect(reactionEvent?.reaction).toBe("+1");
    expect(reactionEvent?.targetId).toBe(targetId);
  });
});
