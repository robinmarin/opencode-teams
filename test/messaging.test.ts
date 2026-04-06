import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createEventHandler } from "../src/messaging.js";
import { getEvents, readTeam, setTestTeamsDir, writeTeam } from "../src/state.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-teams-msg-"));
  setTestTeamsDir(tmpDir);
});

afterEach(async () => {
  setTestTeamsDir(undefined);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Client stub that records promptAsync calls
// ---------------------------------------------------------------------------
type PromptAsyncCall = { sessionId: string; text: string };

function makeStubClient() {
  const calls: PromptAsyncCall[] = [];
  const client = {
    session: {
      promptAsync: async (opts: {
        path: { id: string };
        body: {
          parts: Array<{ type: string; text?: string }>;
        };
      }) => {
        const text = opts.body.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("");
        calls.push({ sessionId: opts.path.id, text });
      },
    },
  } as unknown as Parameters<typeof createEventHandler>[0];
  return { client, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createEventHandler", () => {
  it("ignores events that are not session.idle", async () => {
    const { client, calls } = makeStubClient();
    const handler = createEventHandler(client);

    await handler({
      event: {
        type: "session.created",
        properties: { info: {} as never },
      },
    });

    expect(calls.length).toBe(0);
  });

  it("ignores session.idle for a session not in any team", async () => {
    const { client, calls } = makeStubClient();
    const handler = createEventHandler(client);

    await handler({
      event: { type: "session.idle", properties: { sessionID: "unknown-sess" } },
    });

    expect(calls.length).toBe(0);
  });

  it("posts system event and notifies lead when lead goes idle with busy members", async () => {
    await writeTeam({
      name: "beta",
      leadSessionId: "lead-sess",
      members: {
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
    });

    const { client, calls } = makeStubClient();
    const handler = createEventHandler(client);

    await handler({
      event: { type: "session.idle", properties: { sessionID: "lead-sess" } },
    });

    // Must prompt lead with system message
    const leadCalls = calls.filter((c) => c.sessionId === "lead-sess");
    expect(leadCalls.length).toBe(1);
    expect(leadCalls[0].text).toBe("Lead idle — 1 member(s) still busy");

    // System event should be posted
    const { events } = await getEvents("beta", 10);
    const systemEvent = events.find((e) => e.type === "system");
    expect(systemEvent?.content).toBe("Lead idle — 1 member(s) still busy");
  });

  it("notifies lead when a busy team member goes idle", async () => {
    await writeTeam({
      name: "gamma",
      leadSessionId: "gamma-lead",
      members: {
        carol: {
          name: "carol",
          sessionId: "carol-sess",
          status: "busy",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
      tasks: {},
      createdAt: new Date().toISOString(),
    });

    const { client, calls } = makeStubClient();
    const handler = createEventHandler(client);

    await handler({
      event: { type: "session.idle", properties: { sessionID: "carol-sess" } },
    });

    // One call: team status render (notification now goes to channel instead)
    expect(calls.length).toBe(1);
    const statusCall = calls[0];
    expect(statusCall.sessionId).toBe("gamma-lead");

    // Verify channel event was created
    const { events } = await getEvents("gamma", 10);
    const statusEvent = events.find((e) => e.type === "status" && e.sender === "carol");
    expect(statusEvent).toBeDefined();
    expect(statusEvent?.content).toContain("carol");
    expect(statusEvent?.content).toContain("ready");
  });

  it("does NOT notify lead when a ready member goes idle", async () => {
    await writeTeam({
      name: "delta",
      leadSessionId: "delta-lead",
      members: {
        dave: {
          name: "dave",
          sessionId: "dave-sess",
          status: "ready", // already ready
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
      tasks: {},
      createdAt: new Date().toISOString(),
    });

    const { client, calls } = makeStubClient();
    const handler = createEventHandler(client);

    await handler({
      event: { type: "session.idle", properties: { sessionID: "dave-sess" } },
    });

    // Render call fires for all members, but NO notification since dave was already ready
    expect(calls.length).toBe(1);
    expect(calls[0]?.text).not.toContain("completed a work cycle");
  });
});

describe("session.status events", () => {
  it("sets member status to busy on session.status busy", async () => {
    await writeTeam({
      name: "status-team",
      leadSessionId: "st-lead",
      members: {
        eve: {
          name: "eve",
          sessionId: "eve-sess",
          status: "ready",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
      tasks: {},
      createdAt: new Date().toISOString(),
    });

    const { client, calls } = makeStubClient();
    const handler = createEventHandler(client);

    await handler({
      event: {
        type: "session.status",
        properties: { sessionID: "eve-sess", status: { type: "busy" } },
      },
    });

    // No lead notification for busy transitions
    expect(calls.length).toBe(0);

    const team = await readTeam("status-team");
    expect(team?.members["eve"]?.status).toBe("busy");
  });

  it("sets member status to retrying and stores retry context", async () => {
    await writeTeam({
      name: "retry-team",
      leadSessionId: "rt-lead",
      members: {
        frank: {
          name: "frank",
          sessionId: "frank-sess",
          status: "busy",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
      tasks: {},
      createdAt: new Date().toISOString(),
    });

    const { client, calls } = makeStubClient();
    const handler = createEventHandler(client);

    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID: "frank-sess",
          status: { type: "retry", attempt: 2, message: "rate limited", next: 30000 },
        },
      },
    });

    // No lead notification for retrying transitions
    expect(calls.length).toBe(0);

    const team = await readTeam("retry-team");
    const frank = team?.members["frank"];
    expect(frank?.status).toBe("retrying");
    expect(frank?.retryAttempt).toBe(2);
    expect(frank?.retryNextMs).toBe(30000);
  });

  it("ignores session.status idle (deferred to session.idle)", async () => {
    await writeTeam({
      name: "idle-status-team",
      leadSessionId: "ist-lead",
      members: {
        grace: {
          name: "grace",
          sessionId: "grace-sess",
          status: "busy",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
      tasks: {},
      createdAt: new Date().toISOString(),
    });

    const { client, calls } = makeStubClient();
    const handler = createEventHandler(client);

    await handler({
      event: {
        type: "session.status",
        properties: { sessionID: "grace-sess", status: { type: "idle" } },
      },
    });

    // No state change, no notification
    expect(calls.length).toBe(0);
    const team = await readTeam("idle-status-team");
    expect(team?.members["grace"]?.status).toBe("busy"); // unchanged
  });

  it("clears retry context when member goes idle", async () => {
    await writeTeam({
      name: "clear-retry-team",
      leadSessionId: "crt-lead",
      members: {
        henry: {
          name: "henry",
          sessionId: "henry-sess",
          status: "retrying",
          retryAttempt: 3,
          retryNextMs: 10000,
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
      tasks: {},
      createdAt: new Date().toISOString(),
    });

    const { client } = makeStubClient();
    const handler = createEventHandler(client);

    await handler({
      event: { type: "session.idle", properties: { sessionID: "henry-sess" } },
    });

    const team = await readTeam("clear-retry-team");
    const henry = team?.members["henry"];
    expect(henry?.status).toBe("ready");
    expect(henry?.retryAttempt).toBeUndefined();
    expect(henry?.retryNextMs).toBeUndefined();
  });
});

describe("recoverStaleMembers (via createEventHandler startup)", () => {
  it("marks busy and shutdown_requested members as error on startup", async () => {
    await writeTeam({
      name: "recovery-team",
      leadSessionId: "rl-lead",
      members: {
        stale_busy: {
          name: "stale_busy",
          sessionId: "sb-sess",
          status: "busy",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
        stale_retrying: {
          name: "stale_retrying",
          sessionId: "sr-sess",
          status: "retrying",
          retryAttempt: 1,
          retryNextMs: 5000,
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
        stale_shutdown: {
          name: "stale_shutdown",
          sessionId: "ss-sess",
          status: "shutdown_requested",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
        fine_ready: {
          name: "fine_ready",
          sessionId: "fr-sess",
          status: "ready",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
      tasks: {},
      createdAt: new Date().toISOString(),
    });

    const { client } = makeStubClient();
    // createEventHandler fires recoverStaleMembers fire-and-forget
    createEventHandler(client);

    // Give the async recovery a chance to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const team = await readTeam("recovery-team");
    expect(team?.members["stale_busy"]?.status).toBe("error");
    expect(team?.members["stale_retrying"]?.status).toBe("error");
    expect(team?.members["stale_shutdown"]?.status).toBe("error");
    // Non-stale member is untouched
    expect(team?.members["fine_ready"]?.status).toBe("ready");
  });
});
