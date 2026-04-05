import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createEventHandler } from "../src/messaging.js";
import { readTeam, setTestTeamsDir, writeTeam } from "../src/state.js";

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

  it("does NOT auto-prompt lead when lead goes idle with busy members", async () => {
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

    // Must NOT prompt lead automatically
    expect(calls.filter((c) => c.sessionId === "lead-sess").length).toBe(0);
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

    // Two calls: 1) notification that carol completed, 2) team status render
    expect(calls.length).toBe(2);
    const notificationCall = calls.find((c) => c.text.includes("completed a work cycle"));
    expect(notificationCall?.sessionId).toBe("gamma-lead");
    expect(notificationCall?.text).toContain("carol");
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
    expect(team?.members["stale_shutdown"]?.status).toBe("error");
    // Non-stale member is untouched
    expect(team?.members["fine_ready"]?.status).toBe("ready");
  });
});
