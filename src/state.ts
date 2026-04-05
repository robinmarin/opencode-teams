import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemberStatus =
  | "ready"
  | "busy"
  | "shutdown_requested"
  | "shutdown"
  | "error";

export type TeamMember = {
  name: string;
  sessionId: string;
  status: MemberStatus;
  agentType: string;
  model: string;
  spawnedAt: string; // ISO timestamp
};

export type TeamTask = {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  assignee: string | null;
  dependsOn: string[]; // task IDs
  createdAt: string;
};

export type TeamConfig = {
  name: string;
  leadSessionId: string;
  members: Record<string, TeamMember>;
  tasks: Record<string, TeamTask>;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Overridable for testing — set via setTestTeamsDir()
let _overrideTeamsDir: string | undefined;

/** For use in tests only. Pass the temp directory to isolate state. */
export function setTestTeamsDir(dir: string | undefined): void {
  _overrideTeamsDir = dir;
  // Clear the reverse index so tests start clean
  sessionIndex.clear();
}

function teamsDir(): string {
  if (_overrideTeamsDir !== undefined) return _overrideTeamsDir;
  return path.join(os.homedir(), ".config", "opencode", "teams");
}

function teamDir(name: string): string {
  return path.join(teamsDir(), name);
}

function teamConfigPath(name: string): string {
  return path.join(teamDir(name), "config.json");
}

// ---------------------------------------------------------------------------
// In-process write lock (per team name)
// ---------------------------------------------------------------------------

const writeLocks = new Map<string, Promise<void>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const current = writeLocks.get(key) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((res) => {
    resolve = res;
  });
  writeLocks.set(key, next);
  return current.then(fn).finally(resolve);
}

// ---------------------------------------------------------------------------
// In-memory reverse index: sessionId → { teamName, memberName }
//
// Kept in sync on every write. Unknown sessions fall back to a full disk scan
// that populates the index as a side effect, making subsequent lookups O(1).
// ---------------------------------------------------------------------------

const sessionIndex = new Map<string, { teamName: string; memberName: string }>();

function indexTeam(config: TeamConfig): void {
  // Remove any stale entries for this team before re-indexing
  for (const [sessionId, entry] of sessionIndex) {
    if (entry.teamName === config.name) sessionIndex.delete(sessionId);
  }
  sessionIndex.set(config.leadSessionId, {
    teamName: config.name,
    memberName: "__lead__",
  });
  for (const [memberName, member] of Object.entries(config.members)) {
    sessionIndex.set(member.sessionId, { teamName: config.name, memberName });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function readTeam(name: string): Promise<TeamConfig | null> {
  const configPath = teamConfigPath(name);
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw) as TeamConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeTeam(config: TeamConfig): Promise<void> {
  return withLock(config.name, async () => {
    const dir = teamDir(config.name);
    await fs.mkdir(dir, { recursive: true });
    const configPath = teamConfigPath(config.name);
    const tmpPath = `${configPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    await fs.rename(tmpPath, configPath);
    indexTeam(config);
  });
}

export async function updateMember(
  teamName: string,
  memberName: string,
  patch: Partial<TeamMember>,
): Promise<void> {
  return withLock(teamName, async () => {
    const configPath = teamConfigPath(teamName);
    const raw = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as TeamConfig;
    const existing = config.members[memberName];
    if (existing === undefined) {
      throw new Error(`Member "${memberName}" not found in team "${teamName}"`);
    }
    config.members[memberName] = { ...existing, ...patch };
    const tmpPath = `${configPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    await fs.rename(tmpPath, configPath);
    indexTeam(config);
  });
}

export async function findTeamBySession(
  sessionId: string,
): Promise<{ team: TeamConfig; memberName: string } | null> {
  // Fast path: index hit
  const entry = sessionIndex.get(sessionId);
  if (entry !== undefined) {
    const team = await readTeam(entry.teamName);
    if (team === null) {
      sessionIndex.delete(sessionId);
      return null;
    }
    return { team, memberName: entry.memberName };
  }

  // Slow path: full disk scan; populate index as a side effect so future
  // lookups for any session in these teams are O(1).
  let names: string[];
  try {
    names = await listTeams();
  } catch {
    return null;
  }

  for (const name of names) {
    const team = await readTeam(name);
    if (team === null) continue;
    indexTeam(team);

    if (team.leadSessionId === sessionId) return { team, memberName: "__lead__" };
    for (const [memberName, member] of Object.entries(team.members)) {
      if (member.sessionId === sessionId) return { team, memberName };
    }
  }

  return null;
}

export async function claimTask(
  teamName: string,
  taskId: string,
  memberName: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return withLock(teamName, async () => {
    const configPath = teamConfigPath(teamName);
    const raw = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as TeamConfig;

    const task = config.tasks[taskId];
    if (task === undefined) {
      return { ok: false, reason: `Task "${taskId}" not found in team "${teamName}".` };
    }
    if (task.status !== "pending") {
      return { ok: false, reason: `Task "${taskId}" is not pending (current status: "${task.status}").` };
    }

    const blocking: string[] = [];
    for (const depId of task.dependsOn) {
      const dep = config.tasks[depId];
      if (dep === undefined || dep.status !== "completed") {
        blocking.push(depId);
      }
    }
    if (blocking.length > 0) {
      return {
        ok: false,
        reason: `Task "${taskId}" is blocked by: ${blocking.join(", ")}. Complete those tasks first.`,
      };
    }

    config.tasks[taskId] = { ...task, status: "in_progress", assignee: memberName };
    const tmpPath = `${configPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    await fs.rename(tmpPath, configPath);
    return { ok: true };
  });
}

/**
 * Atomically marks a task as completed and computes which tasks are now
 * unblocked — all in a single lock pass to avoid TOCTOU races.
 */
export async function completeTask(
  teamName: string,
  taskId: string,
): Promise<{ ok: true; unblockedTaskIds: string[] } | { ok: false; reason: string }> {
  return withLock(teamName, async () => {
    const configPath = teamConfigPath(teamName);
    const raw = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as TeamConfig;

    const task = config.tasks[taskId];
    if (task === undefined) {
      return { ok: false, reason: `Task "${taskId}" not found in team "${teamName}".` };
    }

    config.tasks[taskId] = { ...task, status: "completed" };

    const unblockedTaskIds: string[] = [];
    for (const [id, t] of Object.entries(config.tasks)) {
      if (t.status !== "pending") continue;
      if (!t.dependsOn.includes(taskId)) continue;
      const allDone = t.dependsOn.every(
        (depId) => config.tasks[depId]?.status === "completed",
      );
      if (allDone) unblockedTaskIds.push(id);
    }

    const tmpPath = `${configPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    await fs.rename(tmpPath, configPath);
    return { ok: true, unblockedTaskIds };
  });
}

/**
 * In a single lock pass, marks all busy/shutdown_requested members in a team
 * as error. Returns the list of recovered members with their previous status,
 * so callers can log without re-reading the file.
 */
export async function markStaleMembersAsError(
  teamName: string,
): Promise<Array<{ memberName: string; previousStatus: MemberStatus }>> {
  return withLock(teamName, async () => {
    const configPath = teamConfigPath(teamName);
    let raw: string;
    try {
      raw = await fs.readFile(configPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const config = JSON.parse(raw) as TeamConfig;

    const recovered: Array<{ memberName: string; previousStatus: MemberStatus }> = [];
    let dirty = false;
    for (const [name, member] of Object.entries(config.members)) {
      if (member.status === "busy" || member.status === "shutdown_requested") {
        recovered.push({ memberName: name, previousStatus: member.status });
        config.members[name] = { ...member, status: "error" };
        dirty = true;
      }
    }

    if (!dirty) return [];

    const tmpPath = `${configPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    await fs.rename(tmpPath, configPath);
    // Session IDs did not change — index does not need updating
    return recovered;
  });
}

export async function listTeams(): Promise<string[]> {
  const dir = teamsDir();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
