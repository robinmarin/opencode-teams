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

type AbortResult = {
  data: boolean;
  error: undefined;
  request: Request;
  response: Response;
};

function makeStubClient(sessionId = "stub-session-new", abortResult = true) {
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
      abort: async () =>
        ({
          data: abortResult,
          error: undefined,
          request: new Request("http://localhost"),
          response: new Response(),
        }) satisfies AbortResult,
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

describe("team_interrupt", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_interrupt", {
      teamName: "ghost",
      memberName: "alice",
      message: "check in",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error when member not found", async () => {
    await seedTeam();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_interrupt", {
      teamName: "alpha",
      memberName: "nobody",
      message: "check in",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error when member is in shutdown state", async () => {
    await seedTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "alice-sess",
          status: "shutdown_requested",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_interrupt", {
      teamName: "alpha",
      memberName: "alice",
      message: "check in",
    });
    expect(result).toContain("Error");
    expect(result).toContain("shutdown");
  });

  it("interrupts a busy member and confirms delivery", async () => {
    await seedTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "alice-sess",
          status: "busy",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
    });
    // abortResult=true means the session was running and was stopped
    const tools = createTools(makeStubClient("stub-session-new", true));
    const result = await callTool(tools, "team_interrupt", {
      teamName: "alpha",
      memberName: "alice",
      message: "What is your current progress?",
    });
    expect(result).not.toContain("Error");
    expect(result).toContain("interrupted");
    expect(result).toContain("alice");
  });

  it("reports 'was idle' when member was not actively running", async () => {
    await seedTeam({
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
    });
    // abortResult=false means there was nothing to abort
    const tools = createTools(makeStubClient("stub-session-new", false));
    const result = await callTool(tools, "team_interrupt", {
      teamName: "alpha",
      memberName: "alice",
      message: "What is your current progress?",
    });
    expect(result).not.toContain("Error");
    expect(result).toContain("idle");
    expect(result).toContain("delivered");
  });
});

// ---------------------------------------------------------------------------
// team_broadcast
// ---------------------------------------------------------------------------
describe("team_broadcast", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_broadcast", {
      teamName: "ghost",
      message: "Hello",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns info message when sender is only active member", async () => {
    await seedTeamWithMembers({ members: {} });
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_broadcast",
      { teamName: "alpha", message: "Hello" },
      "lead-session",
    );
    expect(result).toContain("no active members");
    expect(result).not.toContain("Error");
  });

  it("broadcasts to all active members excluding sender", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_broadcast",
      { teamName: "alpha", message: "All hands!" },
      "lead-session",
    );
    expect(result).not.toContain("Error");
    expect(result).toContain("alice");
    expect(result).toContain("bob");
  });
});

// ---------------------------------------------------------------------------
// team_shutdown
// ---------------------------------------------------------------------------
describe("team_shutdown", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_shutdown", {
      teamName: "ghost",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error when specific member not found", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_shutdown", {
      teamName: "alpha",
      memberName: "nobody",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("shuts down a specific member", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_shutdown", {
      teamName: "alpha",
      memberName: "alice",
    });
    expect(result).not.toContain("Error");
    expect(result).toContain("alice");
    expect(result).toContain("Shutdown requested");
  });

  it("shuts down all active members when no member specified", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_shutdown", { teamName: "alpha" });
    expect(result).not.toContain("Error");
    expect(result).toContain("Shutdown requested");
    expect(result).toContain("alice");
    expect(result).toContain("bob");
  });

  it("returns message when no active members found", async () => {
    await seedTeamWithMembers({
      members: {
        alice: {
          name: "alice",
          sessionId: "alice-sess",
          status: "shutdown_requested",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_shutdown", { teamName: "alpha" });
    expect(result).toContain("No members were shut down");
  });
});

// ---------------------------------------------------------------------------
// team_task_update
// ---------------------------------------------------------------------------
describe("team_task_update", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_update", {
      teamName: "ghost",
      taskId: "task_1",
      title: "New title",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error when task not found", async () => {
    await seedTeamWithTasks();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_update", {
      teamName: "alpha",
      taskId: "task_nonexistent",
      title: "New title",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error when no fields provided", async () => {
    await seedTeamWithTasks({
      tasks: {
        task_1: {
          id: "task_1",
          title: "Original",
          description: "Desc",
          status: "pending",
          assignee: null,
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_update", {
      teamName: "alpha",
      taskId: "task_1",
    });
    expect(result).toContain("Error");
    expect(result).toContain("No fields to update");
  });

  it("updates title successfully", async () => {
    await seedTeamWithTasks({
      tasks: {
        task_1: {
          id: "task_1",
          title: "Original",
          description: "Desc",
          status: "pending",
          assignee: null,
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_update", {
      teamName: "alpha",
      taskId: "task_1",
      title: "Updated Title",
    });
    expect(result).not.toContain("Error");
    expect(result).toContain("updated");
    const team = await readTeam("alpha");
    expect(team?.tasks["task_1"]?.title).toBe("Updated Title");
  });

  it("updates description successfully", async () => {
    await seedTeamWithTasks({
      tasks: {
        task_1: {
          id: "task_1",
          title: "Title",
          description: "Original desc",
          status: "pending",
          assignee: null,
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_update", {
      teamName: "alpha",
      taskId: "task_1",
      description: "New description",
    });
    expect(result).not.toContain("Error");
    const team = await readTeam("alpha");
    expect(team?.tasks["task_1"]?.description).toBe("New description");
  });

  it("updates assignee successfully", async () => {
    await seedTeamWithTasks({
      tasks: {
        task_1: {
          id: "task_1",
          title: "Title",
          description: "Desc",
          status: "pending",
          assignee: null,
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_update", {
      teamName: "alpha",
      taskId: "task_1",
      assignee: "alice",
    });
    expect(result).not.toContain("Error");
    const team = await readTeam("alpha");
    expect(team?.tasks["task_1"]?.assignee).toBe("alice");
  });
});

// ---------------------------------------------------------------------------
// team_task_list
// ---------------------------------------------------------------------------
describe("team_task_list", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_list", { teamName: "ghost" });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns empty message when no tasks at all", async () => {
    await seedTeamWithTasks();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_list", { teamName: "alpha" });
    expect(result).toContain("No tasks found");
  });

  it("filters by pending status", async () => {
    await seedTeamWithTasks({
      tasks: {
        task_1: {
          id: "task_1",
          title: "Pending task",
          description: "Desc",
          status: "pending",
          assignee: null,
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
        task_2: {
          id: "task_2",
          title: "Completed task",
          description: "Desc",
          status: "completed",
          assignee: null,
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_list", {
      teamName: "alpha",
      status: "pending",
    });
    expect(result).toContain("pending");
    expect(result).toContain("task_1");
    expect(result).not.toContain("task_2");
  });

  it("filters by in_progress status", async () => {
    await seedTeamWithTasks({
      tasks: {
        task_1: {
          id: "task_1",
          title: "In progress",
          description: "Desc",
          status: "in_progress",
          assignee: "alice",
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_list", {
      teamName: "alpha",
      status: "in_progress",
    });
    expect(result).toContain("in_progress");
    expect(result).toContain("task_1");
  });

  it("filters by completed status", async () => {
    await seedTeamWithTasks({
      tasks: {
        task_1: {
          id: "task_1",
          title: "Done",
          description: "Desc",
          status: "completed",
          assignee: "alice",
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_list", {
      teamName: "alpha",
      status: "completed",
    });
    expect(result).toContain("completed");
    expect(result).toContain("task_1");
  });

  it("filters by blocked status", async () => {
    await seedTeamWithTasks({
      tasks: {
        task_1: {
          id: "task_1",
          title: "Blocked",
          description: "Desc",
          status: "blocked",
          assignee: null,
          dependsOn: ["task_missing"],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_task_list", {
      teamName: "alpha",
      status: "blocked",
    });
    expect(result).toContain("blocked");
    expect(result).toContain("task_1");
  });
});

// ---------------------------------------------------------------------------
// team_member_info
// ---------------------------------------------------------------------------
describe("team_member_info", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_member_info", {
      teamName: "ghost",
      memberName: "alice",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error when member not found", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_member_info", {
      teamName: "alpha",
      memberName: "nobody",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns member info with active task", async () => {
    await seedTeamWithTasks({
      members: {
        alice: {
          name: "alice",
          sessionId: "alice-sess",
          status: "busy",
          agentType: "backend engineer",
          model: "claude-3",
          spawnedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      tasks: {
        task_1: {
          id: "task_1",
          title: "Build API",
          description: "Implement it",
          status: "in_progress",
          assignee: "alice",
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_member_info", {
      teamName: "alpha",
      memberName: "alice",
    });
    expect(result).toContain("alice");
    expect(result).toContain("alice-sess");
    expect(result).toContain("busy");
    expect(result).toContain("Build API");
  });
});

// ---------------------------------------------------------------------------
// team_member_session
// ---------------------------------------------------------------------------
describe("team_member_session", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_member_session", {
      teamName: "ghost",
      memberName: "alice",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error when member not found", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_member_session", {
      teamName: "alpha",
      memberName: "nobody",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error when session.messages returns an error", async () => {
    await seedTeamWithMembers();
    const stubClient = {
      session: {
        create: makeStubClient().session.create,
        promptAsync: makeStubClient().session.promptAsync,
        messages: async () => ({
          data: undefined,
          error: { code: "SESSION_NOT_FOUND", message: "Session not found" },
          request: new Request("http://localhost"),
          response: new Response(),
        }),
        abort: makeStubClient().session.abort,
      },
    } as unknown as Parameters<typeof createTools>[0];
    const tools = createTools(stubClient);
    const result = await callTool(tools, "team_member_session", {
      teamName: "alpha",
      memberName: "alice",
    });
    expect(result).toContain("Error");
    expect(result).toContain("SESSION_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// team_logs
// ---------------------------------------------------------------------------
describe("team_logs", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_logs", { teamName: "ghost" });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns empty message when no logs", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_logs", { teamName: "alpha" });
    expect(result).toContain("No debug logs found");
  });

  it("filters by level", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_logs", {
      teamName: "alpha",
      level: "error",
    });
    expect(result).toContain("No debug logs found");
  });

  it("filters by sessionId", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_logs", {
      teamName: "alpha",
      sessionId: "some-session-id",
    });
    expect(result).toContain("No debug logs found");
  });

  it("filters by memberName", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_logs", {
      teamName: "alpha",
      memberName: "alice",
    });
    expect(result).toContain("No debug logs found");
  });

  it("filters by since", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_logs", {
      teamName: "alpha",
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(result).toContain("No debug logs found");
  });

  it("respects limit parameter", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_logs", {
      teamName: "alpha",
      limit: 5,
    });
    expect(result).toContain("No debug logs found");
  });

  it("combines multiple filters", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_logs", {
      teamName: "alpha",
      level: "info",
      memberName: "alice",
      limit: 10,
    });
    expect(result).toContain("No debug logs found");
  });
});

// ---------------------------------------------------------------------------
// team_bulletin_post
// ---------------------------------------------------------------------------
describe("team_bulletin_post", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_bulletin_post", {
      teamName: "ghost",
      category: "finding",
      title: "Test",
      body: "Body text",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("posts a finding successfully", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_bulletin_post",
      {
        teamName: "alpha",
        category: "finding",
        title: "API design decision",
        body: "Use REST over GraphQL for simplicity.",
      },
      "alice-sess",
    );
    expect(result).not.toContain("Error");
    expect(result).toContain("Bulletin post created");
  });

  it("posts a blocker successfully", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_bulletin_post",
      {
        teamName: "alpha",
        category: "blocker",
        title: "Missing auth credentials",
        body: "Cannot proceed without the API keys.",
      },
      "alice-sess",
    );
    expect(result).not.toContain("Error");
    expect(result).toContain("Bulletin post created");
  });

  it("posts a question successfully", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_bulletin_post",
      {
        teamName: "alpha",
        category: "question",
        title: "Which endpoint for auth?",
        body: "Should we use /auth/login or /auth/token?",
      },
      "bob-sess",
    );
    expect(result).not.toContain("Error");
    expect(result).toContain("Bulletin post created");
  });

  it("posts an update successfully", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_bulletin_post",
      {
        teamName: "alpha",
        category: "update",
        title: "API endpoint complete",
        body: "Finished the auth endpoints ahead of schedule.",
      },
      "alice-sess",
    );
    expect(result).not.toContain("Error");
    expect(result).toContain("Bulletin post created");
  });

  it("persists the post so it can be read back", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    await callTool(
      tools,
      "team_bulletin_post",
      {
        teamName: "alpha",
        category: "finding",
        title: "Persisted finding",
        body: "This should survive a read.",
      },
      "alice-sess",
    );
    const readTools = createTools(makeStubClient());
    const readResult = await callTool(readTools, "team_bulletin_read", {
      teamName: "alpha",
    });
    expect(readResult).toContain("Persisted finding");
    expect(readResult).toContain("FINDING");
  });
});

// ---------------------------------------------------------------------------
// team_bulletin_read
// ---------------------------------------------------------------------------
describe("team_bulletin_read", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_bulletin_read", {
      teamName: "ghost",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns empty message when no posts yet", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_bulletin_read", {
      teamName: "alpha",
    });
    expect(result).toContain("No bulletin posts yet");
  });

  it("returns multiple posts ordered by timestamp", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    await callTool(
      tools,
      "team_bulletin_post",
      {
        teamName: "alpha",
        category: "update",
        title: "First post",
        body: "This was posted first.",
      },
      "alice-sess",
    );
    await callTool(
      tools,
      "team_bulletin_post",
      {
        teamName: "alpha",
        category: "finding",
        title: "Second post",
        body: "This was posted second.",
      },
      "bob-sess",
    );

    const result = await callTool(tools, "team_bulletin_read", {
      teamName: "alpha",
    });
    expect(result).toContain("Bulletin board:");
    expect(result).toContain("First post");
    expect(result).toContain("Second post");
  });
});

// ---------------------------------------------------------------------------
// team_timeline
// ---------------------------------------------------------------------------
describe("team_timeline", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_timeline", { teamName: "ghost" });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns empty timeline message when no events", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_timeline", { teamName: "alpha" });
    expect(result).toContain("No activity recorded yet");
  });

  it("shows mixed events (message + task) in timeline", async () => {
    await seedTeamWithMembers();
    await appendEvent("alpha", {
      type: "message",
      sender: "alice",
      senderId: "alice-sess",
      content: "Starting work",
    });
    await appendEvent("alpha", {
      type: "task",
      sender: "alice",
      senderId: "alice-sess",
      content: "claimed task task_1",
      targetId: "task_1",
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_timeline", { teamName: "alpha" });
    expect(result).toContain("Timeline for");
    expect(result).toContain("alice");
    expect(result).toContain("Starting work");
    expect(result).toContain("claimed task");
  });

  it("respects limit parameter", async () => {
    await seedTeamWithMembers();
    for (let i = 0; i < 5; i++) {
      await appendEvent("alpha", {
        type: "message",
        sender: "alice",
        senderId: "alice-sess",
        content: `Event ${i}`,
      });
    }
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_timeline", {
      teamName: "alpha",
      limit: 2,
    });
    expect(result).toContain("Timeline for");
    expect(result).not.toContain("Event 0");
    expect(result).not.toContain("Event 1");
  });
});

// ---------------------------------------------------------------------------
// team_prune
// ---------------------------------------------------------------------------
describe("team_prune", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_prune", { teamName: "ghost" });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("reports zero pruned when no events", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_prune", { teamName: "alpha" });
    expect(result).not.toContain("Error");
    expect(result).toContain("Pruned 0");
    expect(result).toContain("0 events remaining");
  });

  it("reports correct prune count accuracy", async () => {
    await seedTeamWithMembers();
    for (let i = 0; i < 5; i++) {
      await appendEvent("alpha", {
        type: "message",
        sender: "alice",
        senderId: "alice-sess",
        content: `Event ${i}`,
      });
    }
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_prune", {
      teamName: "alpha",
      keep: 3,
    });
    expect(result).not.toContain("Error");
    expect(result).toContain("Pruned 2");
    expect(result).toContain("3 events remaining");
  });

  it("handles keep=0 edge case", async () => {
    await seedTeamWithMembers();
    for (let i = 0; i < 3; i++) {
      await appendEvent("alpha", {
        type: "message",
        sender: "alice",
        senderId: "alice-sess",
        content: `Event ${i}`,
      });
    }
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_prune", {
      teamName: "alpha",
      keep: 0,
    });
    expect(result).not.toContain("Error");
    expect(result).toContain("Pruned 3");
    expect(result).toContain("0 events remaining");
  });
});

// ---------------------------------------------------------------------------
// team_list
// ---------------------------------------------------------------------------
describe("team_list", () => {
  it("returns empty message when no teams at all", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_list", {});
    expect(result).toContain("No teams exist yet");
  });

  it("lists multiple teams with varied member/task counts", async () => {
    await writeTeam({
      name: "team-a",
      leadSessionId: "lead-a",
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
      tasks: {
        task_1: {
          id: "task_1",
          title: "Task A",
          description: "Desc",
          status: "pending",
          assignee: null,
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await writeTeam({
      name: "team-b",
      leadSessionId: "lead-b",
      members: {},
      tasks: {},
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_list", {});
    expect(result).toContain("Teams:");
    expect(result).toContain("team-a");
    expect(result).toContain("team-b");
    expect(result).toContain("1 member(s)");
    expect(result).toContain("0 member(s)");
    expect(result).toContain("1 task(s)");
    expect(result).toContain("0 task(s)");
  });
});

// ---------------------------------------------------------------------------
// team_delete
// ---------------------------------------------------------------------------
describe("team_delete", () => {
  it("returns error when team not found", async () => {
    const tools = createTools(makeStubClient());
    const result = await callTool(tools, "team_delete", { teamName: "ghost" });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error when non-lead attempts deletion", async () => {
    await seedTeamWithMembers({ leadSessionId: "lead-session" });
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_delete",
      { teamName: "alpha" },
      "alice-sess",
    );
    expect(result).toContain("Error");
    expect(result).toContain("Only the team lead can delete");
  });

  it("returns warning when team has active members", async () => {
    await seedTeamWithMembers();
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_delete",
      { teamName: "alpha" },
      "lead-session",
    );
    expect(result).toContain("Warning");
    expect(result).toContain("active member(s)");
    expect(result).toContain("Shutdown members first");
  });

  it("deletes team successfully when no members", async () => {
    await seedTeamWithMembers({ members: {} });
    const tools = createTools(makeStubClient());
    const result = await callTool(
      tools,
      "team_delete",
      { teamName: "alpha" },
      "lead-session",
    );
    expect(result).not.toContain("Error");
    expect(result).toContain("deleted");
    const team = await readTeam("alpha");
    expect(team).toBeNull();
  });
});
