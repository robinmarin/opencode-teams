import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  findTeamBySession,
  listTeams,
  readTeam,
  setTestTeamsDir,
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
