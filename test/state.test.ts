import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendBulletinPost,
  appendEvent,
  claimTask,
  completeTask,
  findTeamBySession,
  getEvents,
  listTeams,
  markStaleMembersAsError,
  pruneEvents,
  readBulletinPosts,
  readDebugLogs,
  readTeam,
  setTestTeamsDir,
  teamDir,
  updateMember,
  writeTeam,
} from "../src/state.js";
import type { TeamConfig } from "../src/state.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-teams-state-"));
  setTestTeamsDir(tmpDir);
});

afterEach(async () => {
  setTestTeamsDir(undefined);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeTeam(overrides?: Partial<TeamConfig>): TeamConfig {
  return {
    name: "test-team",
    leadSessionId: "sess-lead-001",
    members: {},
    tasks: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("readTeam", () => {
  it("returns null for a missing team", async () => {
    const result = await readTeam("nonexistent");
    expect(result).toBeNull();
  });
});

describe("writeTeam + readTeam", () => {
  it("round-trips a team config correctly", async () => {
    const team = makeTeam();
    await writeTeam(team);
    const result = await readTeam(team.name);
    expect(result).not.toBeNull();
    expect(result?.name).toBe(team.name);
    expect(result?.leadSessionId).toBe(team.leadSessionId);
    expect(result?.createdAt).toBe(team.createdAt);
  });

  it("overwrites an existing team", async () => {
    const team = makeTeam();
    await writeTeam(team);
    const updated = { ...team, leadSessionId: "sess-new-lead" };
    await writeTeam(updated);
    const result = await readTeam(team.name);
    expect(result?.leadSessionId).toBe("sess-new-lead");
  });
});

describe("updateMember", () => {
  it("patches a member without overwriting other fields", async () => {
    const team = makeTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "sess-alice",
          status: "ready",
          agentType: "default",
          model: "claude-3",
          spawnedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    await writeTeam(team);
    await updateMember("test-team", "alice", { status: "busy" });

    const result = await readTeam("test-team");
    const alice = result?.members["alice"];
    expect(alice?.status).toBe("busy");
    expect(alice?.model).toBe("claude-3"); // unchanged
    expect(alice?.sessionId).toBe("sess-alice"); // unchanged
  });

  it("throws if member does not exist", async () => {
    const team = makeTeam();
    await writeTeam(team);
    await expect(
      updateMember("test-team", "nonexistent", { status: "error" }),
    ).rejects.toThrow("not found");
  });
});

describe("concurrent writes", () => {
  it("does not corrupt state under concurrent writes", async () => {
    const team = makeTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "sess-alice",
          status: "ready",
          agentType: "default",
          model: "claude-3",
          spawnedAt: "2026-01-01T00:00:00.000Z",
        },
        bob: {
          name: "bob",
          sessionId: "sess-bob",
          status: "ready",
          agentType: "default",
          model: "claude-3",
          spawnedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    await writeTeam(team);

    // Fire concurrent updates with no awaiting between them
    await Promise.all([
      updateMember("test-team", "alice", { status: "busy" }),
      updateMember("test-team", "bob", { status: "shutdown_requested" }),
    ]);

    const result = await readTeam("test-team");
    expect(result?.members["alice"]?.status).toBe("busy");
    expect(result?.members["bob"]?.status).toBe("shutdown_requested");
  });
});

describe("findTeamBySession", () => {
  it("returns null for an unknown session ID", async () => {
    const result = await findTeamBySession("sess-unknown");
    expect(result).toBeNull();
  });

  it("finds the lead session", async () => {
    const team = makeTeam({ leadSessionId: "sess-lead-007" });
    await writeTeam(team);

    const result = await findTeamBySession("sess-lead-007");
    expect(result).not.toBeNull();
    expect(result?.team.name).toBe("test-team");
    expect(result?.memberName).toBe("__lead__");
  });

  it("finds a member session", async () => {
    const team = makeTeam({
      members: {
        charlie: {
          name: "charlie",
          sessionId: "sess-charlie-123",
          status: "ready",
          agentType: "default",
          model: "claude-3",
          spawnedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    await writeTeam(team);

    const result = await findTeamBySession("sess-charlie-123");
    expect(result).not.toBeNull();
    expect(result?.memberName).toBe("charlie");
    expect(result?.team.name).toBe("test-team");
  });
});

describe("claimTask", () => {
  it("two concurrent claims for the same task result in exactly one success and one failure", async () => {
    const taskId = "task_contested";
    const team = makeTeam({
      tasks: {
        [taskId]: {
          id: taskId,
          title: "Contested task",
          description: "Two members race to claim this",
          status: "pending",
          assignee: null,
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
    await writeTeam(team);

    // Both claims fire concurrently
    const [r1, r2] = await Promise.all([
      claimTask("test-team", taskId, "alice"),
      claimTask("test-team", taskId, "bob"),
    ]);

    const successes = [r1, r2].filter((r) => r.ok);
    const failures = [r1, r2].filter((r) => !r.ok);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    // The task should be in_progress, assigned to whichever won
    const result = await readTeam("test-team");
    expect(result?.tasks[taskId]?.status).toBe("in_progress");
    const winner = successes[0];
    expect(winner?.ok).toBe(true);
  });
});

describe("completeTask", () => {
  it("completes a task and returns unblocked task IDs in one pass", async () => {
    const prereqId = "task_prereq";
    const team = makeTeam({
      tasks: {
        [prereqId]: {
          id: prereqId,
          title: "Prereq",
          description: "First",
          status: "in_progress",
          assignee: "alice",
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
        task_waiting: {
          id: "task_waiting",
          title: "Waiting",
          description: "Needs prereq",
          status: "pending",
          assignee: null,
          dependsOn: [prereqId],
          createdAt: new Date().toISOString(),
        },
      },
    });
    await writeTeam(team);

    const result = await completeTask("test-team", prereqId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.unblockedTaskIds).toContain("task_waiting");

    const updated = await readTeam("test-team");
    expect(updated?.tasks[prereqId]?.status).toBe("completed");
  });

  it("returns error when task not found", async () => {
    const team = makeTeam();
    await writeTeam(team);
    const result = await completeTask("test-team", "task_ghost");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("not found");
  });
});

describe("markStaleMembersAsError", () => {
  it("marks busy and shutdown_requested members as error in one lock pass", async () => {
    const team = makeTeam({
      members: {
        busy_one: {
          name: "busy_one",
          sessionId: "s1",
          status: "busy",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
        shutdown_one: {
          name: "shutdown_one",
          sessionId: "s2",
          status: "shutdown_requested",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
        ready_one: {
          name: "ready_one",
          sessionId: "s3",
          status: "ready",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
    });
    await writeTeam(team);

    const recovered = await markStaleMembersAsError("test-team");
    expect(recovered.length).toBe(2);
    const names = recovered.map((r) => r.memberName).sort();
    expect(names).toEqual(["busy_one", "shutdown_one"]);
    const statuses = recovered.map((r) => r.previousStatus).sort();
    expect(statuses).toContain("busy");
    expect(statuses).toContain("shutdown_requested");

    const updated = await readTeam("test-team");
    expect(updated?.members["busy_one"]?.status).toBe("error");
    expect(updated?.members["shutdown_one"]?.status).toBe("error");
    expect(updated?.members["ready_one"]?.status).toBe("ready");
  });

  it("returns empty array when no stale members exist", async () => {
    const team = makeTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "s-alice",
          status: "ready",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
    });
    await writeTeam(team);
    const recovered = await markStaleMembersAsError("test-team");
    expect(recovered).toEqual([]);
  });
});

describe("listTeams", () => {
  it("returns empty array when no teams exist", async () => {
    const teams = await listTeams();
    expect(teams).toEqual([]);
  });

  it("returns team names after creation", async () => {
    await writeTeam(makeTeam({ name: "team-a" }));
    await writeTeam(makeTeam({ name: "team-b" }));
    const teams = await listTeams();
    expect(teams.sort()).toEqual(["team-a", "team-b"]);
  });
});

describe("appendEvent + getEvents", () => {
  it("appends and retrieves events", async () => {
    await writeTeam(makeTeam({ name: "channel-team" }));
    const evt = await appendEvent("channel-team", {
      type: "message",
      sender: "alice",
      senderId: "sess-alice",
      content: "Hello team!",
    });
    expect(evt.id).toBeDefined();
    expect(evt.type).toBe("message");
    expect(evt.content).toBe("Hello team!");

    const { events } = await getEvents("channel-team", 10);
    expect(events.length).toBe(1);
    expect(events[0].content).toBe("Hello team!");
  });

  it("returns events with mentions", async () => {
    await writeTeam(makeTeam({ name: "mention-team" }));
    const evt = await appendEvent("mention-team", {
      type: "message",
      sender: "bob",
      senderId: "sess-bob",
      content: "Hey @alice!",
      mentions: ["alice"],
    });
    expect(evt.mentions).toEqual(["alice"]);

    const { events } = await getEvents("mention-team", 10);
    expect(events[0].mentions).toEqual(["alice"]);
  });

  it("respects limit parameter", async () => {
    await writeTeam(makeTeam({ name: "limit-team" }));
    for (let i = 0; i < 5; i++) {
      await appendEvent("limit-team", {
        type: "message",
        sender: "charlie",
        senderId: `sess-${i}`,
        content: `Message ${i}`,
      });
    }

    const { events } = await getEvents("limit-team", 3);
    expect(events.length).toBe(3);
  });

  it("returns empty for nonexistent team", async () => {
    const { events } = await getEvents("nonexistent", 10);
    expect(events).toEqual([]);
  });
});

describe("pruneEvents", () => {
  it("prunes old events keeping recent ones", async () => {
    await writeTeam(makeTeam({ name: "prune-team" }));
    for (let i = 0; i < 10; i++) {
      await appendEvent("prune-team", {
        type: "message",
        sender: "dan",
        senderId: `sess-${i}`,
        content: `Message ${i}`,
      });
    }

    const { pruned, remaining } = await pruneEvents("prune-team", 5);
    expect(pruned).toBe(5);
    expect(remaining).toBe(5);

    const { events } = await getEvents("prune-team", 10);
    expect(events.length).toBe(5);
  });

  it("returns zeros when no events to prune", async () => {
    await writeTeam(makeTeam({ name: "small-team" }));
    const { pruned, remaining } = await pruneEvents("small-team", 100);
    expect(pruned).toBe(0);
    expect(remaining).toBe(0);
  });
});

describe("appendBulletinPost + readBulletinPosts", () => {
  it("returns empty array when no posts exist", async () => {
    await writeTeam(makeTeam({ name: "bul-team" }));
    const posts = await readBulletinPosts("bul-team");
    expect(posts).toEqual([]);
  });

  it("round-trips a bulletin post", async () => {
    await writeTeam(makeTeam({ name: "bul-team" }));
    const post = await appendBulletinPost("bul-team", {
      author: "alice",
      authorId: "sess-alice",
      category: "finding",
      title: "DB schema discovered",
      body: "The users table has a soft-delete column `deleted_at`.",
    });

    expect(post.id).toMatch(/^bul_/);
    expect(post.author).toBe("alice");
    expect(post.category).toBe("finding");
    expect(post.title).toBe("DB schema discovered");

    const posts = await readBulletinPosts("bul-team");
    expect(posts.length).toBe(1);
    expect(posts[0]?.id).toBe(post.id);
    expect(posts[0]?.body).toBe(post.body);
  });

  it("respects the limit parameter", async () => {
    await writeTeam(makeTeam({ name: "bul-limit-team" }));
    for (let i = 0; i < 5; i++) {
      await appendBulletinPost("bul-limit-team", {
        author: "bob",
        authorId: "sess-bob",
        category: "update",
        title: `Update ${i}`,
        body: `Body ${i}`,
      });
    }

    const posts = await readBulletinPosts("bul-limit-team", 3);
    expect(posts.length).toBe(3);
    expect(posts[0]?.title).toBe("Update 2");
    expect(posts[2]?.title).toBe("Update 4");
  });

  it("appends multiple posts in order", async () => {
    await writeTeam(makeTeam({ name: "bul-order-team" }));
    await appendBulletinPost("bul-order-team", {
      author: "alice",
      authorId: "sess-alice",
      category: "blocker",
      title: "Blocked on API key",
      body: "Need the third-party API key to proceed.",
    });
    await appendBulletinPost("bul-order-team", {
      author: "bob",
      authorId: "sess-bob",
      category: "question",
      title: "Which endpoint?",
      body: "Should I use /v1 or /v2?",
    });

    const posts = await readBulletinPosts("bul-order-team");
    expect(posts.length).toBe(2);
    expect(posts[0]?.category).toBe("blocker");
    expect(posts[1]?.category).toBe("question");
  });
});

describe("updateMember patch mutation bug", () => {
  it("does not mutate the caller's patch object across calls", async () => {
    const team = makeTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "sess-alice",
          status: "ready",
          agentType: "default",
          model: "claude-3",
          spawnedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    await writeTeam(team);

    const patch: { status: "busy" } = { status: "busy" };
    await updateMember("test-team", "alice", patch);

    const result1 = await readTeam("test-team");
    expect(result1?.members["alice"]?.status).toBe("busy");

    await updateMember("test-team", "alice", patch);

    const result2 = await readTeam("test-team");
    expect(result2?.members["alice"]?.status).toBe("busy");
    expect(patch).not.toHaveProperty("lastStatusAt");
  });
});

describe("claimTask ghost member", () => {
  it("returns ok:true but does not write currentTask when assignee is not a member", async () => {
    const team = makeTeam({
      tasks: {
        task_ghost: {
          id: "task_ghost",
          title: "Ghost Task",
          description: "No such member",
          status: "pending",
          assignee: null,
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
    await writeTeam(team);

    const result = await claimTask("test-team", "task_ghost", "ghost_member");
    expect(result.ok).toBe(true);

    const updated = await readTeam("test-team");
    const ghostMember = updated?.members["ghost_member"];
    expect(ghostMember).toBeUndefined();
  });
});

describe("markStaleMembersAsError", () => {
  it("marks retrying members as error and preserves previousStatus", async () => {
    const team = makeTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "sess-alice",
          status: "retrying",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
    });
    await writeTeam(team);

    const recovered = await markStaleMembersAsError("test-team");
    expect(recovered.length).toBe(1);
    expect(recovered[0]?.memberName).toBe("alice");
    expect(recovered[0]?.previousStatus).toBe("retrying");

    const updated = await readTeam("test-team");
    expect(updated?.members["alice"]?.status).toBe("error");
  });
});

describe("updateMember clear param", () => {
  it("removes specified fields from the stored member", async () => {
    const team = makeTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "sess-alice",
          status: "busy",
          agentType: "default",
          model: "claude-3",
          spawnedAt: "2026-01-01T00:00:00.000Z",
          retryAttempt: 5,
          retryNextMs: 1000,
        },
      },
    });
    await writeTeam(team);

    await updateMember(
      "test-team",
      "alice",
      {},
      ["retryAttempt", "retryNextMs"],
    );

    const result = await readTeam("test-team");
    expect(result?.members["alice"]).not.toHaveProperty("retryAttempt");
    expect(result?.members["alice"]).not.toHaveProperty("retryNextMs");
  });
});

describe("corrupt JSON vs ENOENT", () => {
  it("readBulletinPosts throws on malformed JSON", async () => {
    const team = makeTeam({ name: "corrupt-bul-team" });
    await writeTeam(team);
    const bulPath = path.join(teamDir("corrupt-bul-team"), "bulletin.jsonl");
    await fs.mkdir(teamDir("corrupt-bul-team"), { recursive: true });
    await fs.writeFile(bulPath, '{"broken\n', "utf-8");

    await expect(readBulletinPosts("corrupt-bul-team")).rejects.toThrow();
  });

  it("getEvents throws on malformed JSON", async () => {
    const team = makeTeam({ name: "corrupt-evt-team" });
    await writeTeam(team);
    const evtPath = path.join(teamDir("corrupt-evt-team"), "events.jsonl");
    await fs.mkdir(teamDir("corrupt-evt-team"), { recursive: true });
    await fs.writeFile(evtPath, '{"broken\n', "utf-8");

    await expect(getEvents("corrupt-evt-team", 10)).rejects.toThrow();
  });
});

describe("findTeamBySession fast-path null after team deletion", () => {
  it("returns null without throwing when team directory is removed externally", async () => {
    const team = makeTeam({ name: "delete-me-team", leadSessionId: "sess-delete" });
    await writeTeam(team);

    await fs.rm(teamDir("delete-me-team"), { recursive: true, force: true });

    const result = await findTeamBySession("sess-delete");
    expect(result).toBeNull();
  });
});

describe("readDebugLogs", () => {
  it("reads and filters debug logs correctly", async () => {
    const team = makeTeam({ name: "debug-log-team" });
    await writeTeam(team);

    const logDir = path.join(teamDir("debug-log-team"), "logs");
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, "debug.jsonl");

    const entry1: string = JSON.stringify({
      id: "log_1",
      ts: "2026-01-01T00:00:00.000Z",
      level: "info",
      category: "status",
      sessionId: "sess-alice",
      teamName: "debug-log-team",
      memberName: "alice",
      correlationId: null,
      message: "alice is ready",
      context: {},
    }) + "\n";

    const entry2: string = JSON.stringify({
      id: "log_2",
      ts: "2026-01-01T00:01:00.000Z",
      level: "error",
      category: "status",
      sessionId: "sess-bob",
      teamName: "debug-log-team",
      memberName: "bob",
      correlationId: null,
      message: "bob encountered an error",
      context: {},
    }) + "\n";

    const entry3: string = JSON.stringify({
      id: "log_3",
      ts: "2026-01-01T00:02:00.000Z",
      level: "info",
      category: "status",
      sessionId: "sess-alice",
      teamName: "debug-log-team",
      memberName: "alice",
      correlationId: null,
      message: "alice completed task",
      context: {},
    }) + "\n";

    await fs.writeFile(logPath, entry1 + entry2 + entry3, "utf-8");

    const { logs: all } = await readDebugLogs("debug-log-team", {});
    expect(all.length).toBe(3);

    const { logs: byLevel } = await readDebugLogs("debug-log-team", { level: "error" });
    expect(byLevel.length).toBe(1);
    expect(byLevel[0]?.level).toBe("error");

    const { logs: bySessionId } = await readDebugLogs("debug-log-team", { sessionId: "sess-alice" });
    expect(bySessionId.length).toBe(2);

    const { logs: byMemberName } = await readDebugLogs("debug-log-team", { memberName: "bob" });
    expect(byMemberName.length).toBe(1);
    expect(byMemberName[0]?.memberName).toBe("bob");

    const { logs: bySince } = await readDebugLogs("debug-log-team", { since: "2026-01-01T00:01:30.000Z" });
    expect(bySince.length).toBe(1);
    expect(bySince[0]?.id).toBe("log_3");

    const { logs: byLimit } = await readDebugLogs("debug-log-team", { limit: 2 });
    expect(byLimit.length).toBe(2);

    const { logs: byLevelAndMember } = await readDebugLogs("debug-log-team", {
      level: "info",
      memberName: "alice",
    });
    expect(byLevelAndMember.length).toBe(2);
  });

  it("returns empty logs when file does not exist", async () => {
    const team = makeTeam({ name: "no-log-team" });
    await writeTeam(team);
    const { logs } = await readDebugLogs("no-log-team", {});
    expect(logs).toEqual([]);
  });
});

describe("concurrent claim on blocked task", () => {
  it("both concurrent claims on a blocked task return ok:false with blocked reason", async () => {
    const prereqId = "task_prereq_blocked";
    const blockedId = "task_blocked";
    const team = makeTeam({
      tasks: {
        [prereqId]: {
          id: prereqId,
          title: "Prereq",
          description: "Not done yet",
          status: "in_progress",
          assignee: "alice",
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
        [blockedId]: {
          id: blockedId,
          title: "Blocked Task",
          description: "Waiting on prereq",
          status: "pending",
          assignee: null,
          dependsOn: [prereqId],
          createdAt: new Date().toISOString(),
        },
      },
    });
    await writeTeam(team);

    const [r1, r2] = await Promise.all([
      claimTask("test-team", blockedId, "alice"),
      claimTask("test-team", blockedId, "bob"),
    ]);

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r1.reason).toContain("blocked");
    expect(r2.reason).toContain("blocked");
  });
});

// ---------------------------------------------------------------------------
// 1. updateMember patch mutation bug (BUG at state.ts:228-230)
// ---------------------------------------------------------------------------
describe("updateMember patch mutation bug", () => {
  it("does not mutate the caller's patch object across calls", async () => {
    const team = makeTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "sess-alice",
          status: "ready",
          agentType: "default",
          model: "claude-3",
          spawnedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    await writeTeam(team);

    const patch: { status: "busy" } = { status: "busy" };
    await updateMember("test-team", "alice", patch);

    const result1 = await readTeam("test-team");
    expect(result1?.members["alice"]?.status).toBe("busy");

    await updateMember("test-team", "alice", patch);

    const result2 = await readTeam("test-team");
    expect(result2?.members["alice"]?.status).toBe("busy");
    expect(patch).not.toHaveProperty("lastStatusAt");
  });
});

// ---------------------------------------------------------------------------
// 2. claimTask ghost member (BUG at state.ts:323-329)
// ---------------------------------------------------------------------------
describe("claimTask ghost member", () => {
  it("returns ok:true but does not write currentTask when assignee is not a member", async () => {
    const team = makeTeam({
      tasks: {
        task_ghost: {
          id: "task_ghost",
          title: "Ghost Task",
          description: "No such member",
          status: "pending",
          assignee: null,
          dependsOn: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
    await writeTeam(team);

    const result = await claimTask("test-team", "task_ghost", "ghost_member");
    expect(result.ok).toBe(true);

    const updated = await readTeam("test-team");
    const ghostMember = updated?.members["ghost_member"];
    expect(ghostMember).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. retrying status in markStaleMembersAsError
// ---------------------------------------------------------------------------
describe("markStaleMembersAsError", () => {
  it("marks retrying members as error and preserves previousStatus", async () => {
    const team = makeTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "sess-alice",
          status: "retrying",
          agentType: "default",
          model: "claude-3",
          spawnedAt: new Date().toISOString(),
        },
      },
    });
    await writeTeam(team);

    const recovered = await markStaleMembersAsError("test-team");
    expect(recovered.length).toBe(1);
    expect(recovered[0]?.memberName).toBe("alice");
    expect(recovered[0]?.previousStatus).toBe("retrying");

    const updated = await readTeam("test-team");
    expect(updated?.members["alice"]?.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// 4. clear param of updateMember
// ---------------------------------------------------------------------------
describe("updateMember clear param", () => {
  it("removes specified fields from the stored member", async () => {
    const team = makeTeam({
      members: {
        alice: {
          name: "alice",
          sessionId: "sess-alice",
          status: "busy",
          agentType: "default",
          model: "claude-3",
          spawnedAt: "2026-01-01T00:00:00.000Z",
          retryAttempt: 5,
          retryNextMs: 1000,
        },
      },
    });
    await writeTeam(team);

    await updateMember(
      "test-team",
      "alice",
      {},
      ["retryAttempt", "retryNextMs"],
    );

    const result = await readTeam("test-team");
    expect(result?.members["alice"]).not.toHaveProperty("retryAttempt");
    expect(result?.members["alice"]).not.toHaveProperty("retryNextMs");
  });
});

// ---------------------------------------------------------------------------
// 5. Corrupt JSON vs ENOENT
// ---------------------------------------------------------------------------
describe("corrupt JSON vs ENOENT", () => {
  it("readBulletinPosts throws on malformed JSON", async () => {
    const team = makeTeam({ name: "corrupt-bul-team" });
    await writeTeam(team);
    const bulPath = path.join(teamDir("corrupt-bul-team"), "bulletin.jsonl");
    await fs.mkdir(teamDir("corrupt-bul-team"), { recursive: true });
    await fs.writeFile(bulPath, '{"broken\n', "utf-8");

    await expect(readBulletinPosts("corrupt-bul-team")).rejects.toThrow();
  });

  it("getEvents throws on malformed JSON", async () => {
    const team = makeTeam({ name: "corrupt-evt-team" });
    await writeTeam(team);
    const evtPath = path.join(teamDir("corrupt-evt-team"), "events.jsonl");
    await fs.mkdir(teamDir("corrupt-evt-team"), { recursive: true });
    await fs.writeFile(evtPath, '{"broken\n', "utf-8");

    await expect(getEvents("corrupt-evt-team", 10)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. findTeamBySession fast-path null after team deletion
// ---------------------------------------------------------------------------
describe("findTeamBySession fast-path null after team deletion", () => {
  it("returns null without throwing when team directory is removed externally", async () => {
    const team = makeTeam({ name: "delete-me-team", leadSessionId: "sess-delete" });
    await writeTeam(team);

    await fs.rm(teamDir("delete-me-team"), { recursive: true, force: true });

    const result = await findTeamBySession("sess-delete");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. readDebugLogs fully untested
// ---------------------------------------------------------------------------
describe("readDebugLogs", () => {
  it("reads and filters debug logs correctly", async () => {
    const team = makeTeam({ name: "debug-log-team" });
    await writeTeam(team);

    const logDir = path.join(teamDir("debug-log-team"), "logs");
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, "debug.jsonl");

    const entry1 =
      JSON.stringify({
        id: "log_1",
        ts: "2026-01-01T00:00:00.000Z",
        level: "info",
        category: "status",
        sessionId: "sess-alice",
        teamName: "debug-log-team",
        memberName: "alice",
        correlationId: null,
        message: "alice is ready",
        context: {},
      }) + "\n";

    const entry2 =
      JSON.stringify({
        id: "log_2",
        ts: "2026-01-01T00:01:00.000Z",
        level: "error",
        category: "status",
        sessionId: "sess-bob",
        teamName: "debug-log-team",
        memberName: "bob",
        correlationId: null,
        message: "bob encountered an error",
        context: {},
      }) + "\n";

    const entry3 =
      JSON.stringify({
        id: "log_3",
        ts: "2026-01-01T00:02:00.000Z",
        level: "info",
        category: "status",
        sessionId: "sess-alice",
        teamName: "debug-log-team",
        memberName: "alice",
        correlationId: null,
        message: "alice completed task",
        context: {},
      }) + "\n";

    await fs.writeFile(logPath, entry1 + entry2 + entry3, "utf-8");

    const { logs: all } = await readDebugLogs("debug-log-team", {});
    expect(all.length).toBe(3);

    const { logs: byLevel } = await readDebugLogs("debug-log-team", { level: "error" });
    expect(byLevel.length).toBe(1);
    expect(byLevel[0]?.level).toBe("error");

    const { logs: bySessionId } = await readDebugLogs("debug-log-team", {
      sessionId: "sess-alice",
    });
    expect(bySessionId.length).toBe(2);

    const { logs: byMemberName } = await readDebugLogs("debug-log-team", {
      memberName: "bob",
    });
    expect(byMemberName.length).toBe(1);
    expect(byMemberName[0]?.memberName).toBe("bob");

    const { logs: bySince } = await readDebugLogs("debug-log-team", {
      since: "2026-01-01T00:01:30.000Z",
    });
    expect(bySince.length).toBe(1);
    expect(bySince[0]?.id).toBe("log_3");

    const { logs: byLimit } = await readDebugLogs("debug-log-team", { limit: 2 });
    expect(byLimit.length).toBe(2);

    const { logs: byLevelAndMember } = await readDebugLogs("debug-log-team", {
      level: "info",
      memberName: "alice",
    });
    expect(byLevelAndMember.length).toBe(2);
  });

  it("returns empty logs when file does not exist", async () => {
    const team = makeTeam({ name: "no-log-team" });
    await writeTeam(team);
    const { logs } = await readDebugLogs("no-log-team", {});
    expect(logs).toEqual([]);
  });
});
