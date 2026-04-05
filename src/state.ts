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
  });
}

export async function findTeamBySession(
  sessionId: string,
): Promise<{ team: TeamConfig; memberName: string } | null> {
  let names: string[];
  try {
    names = await listTeams();
  } catch {
    return null;
  }

  for (const name of names) {
    const team = await readTeam(name);
    if (team === null) continue;

    // Check if this session is the lead
    if (team.leadSessionId === sessionId) {
      // Return with a special sentinel member name for the lead
      return { team, memberName: "__lead__" };
    }

    // Check all members
    for (const [memberName, member] of Object.entries(team.members)) {
      if (member.sessionId === sessionId) {
        return { team, memberName };
      }
    }
  }

  return null;
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
