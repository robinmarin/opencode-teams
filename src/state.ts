import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemberStatus =
  | "ready"
  | "busy"
  | "retrying"
  | "shutdown_requested"
  | "shutdown"
  | "error";

export type TeamMember = {
  name: string;
  sessionId: string;
  status: MemberStatus;
  agentType: string;
  model: string;
  spawnedAt: string;
  lastStatusAt?: string;
  currentTask?: string;
  // Populated when status === "retrying"; cleared on any other status transition.
  retryAttempt?: number;
  retryNextMs?: number; // ms until the SDK fires the next attempt
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

export type ChannelEventType =
  | "message"
  | "status"
  | "task"
  | "reaction"
  | "system";

export type ChannelEvent = {
  id: string;
  type: ChannelEventType;
  sender: string;
  senderId: string;
  content: string;
  timestamp: string;
  mentions?: string[];
  reaction?: string;
  targetId?: string;
};

export const MAX_EVENTS_LINES = 1000;

// ---------------------------------------------------------------------------
// Member predicates and constants
// ---------------------------------------------------------------------------

/** Sentinel member name used to identify the team lead in the session index. */
export const LEAD_MEMBER_NAME = "__lead__";

/** True when a member can receive messages and perform work. */
export function isMemberActive(member: TeamMember): boolean {
  return (
    member.status === "ready" ||
    member.status === "busy" ||
    member.status === "retrying"
  );
}

/** True when a member is in a terminal shutdown state and cannot receive messages. */
export function isMemberShutdown(member: TeamMember): boolean {
  return member.status === "shutdown" || member.status === "shutdown_requested";
}

/**
 * Resolves the display name for the session making a tool call.
 * Falls back to the raw sessionID if the session is not part of any team.
 * Never returns "unknown" — the sessionID is always a meaningful fallback
 * for debugging event logs.
 */
export async function resolveSenderName(sessionID: string): Promise<string> {
  const info = await findTeamBySession(sessionID);
  return info !== null ? info.memberName : sessionID;
}

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
  // Disable write coalescing in tests so reads see writes immediately
  _eventDebounceMs = dir !== undefined ? 0 : 100;
}

function teamsDir(): string {
  if (_overrideTeamsDir !== undefined) return _overrideTeamsDir;
  return path.join(os.homedir(), ".config", "opencode", "teams");
}

export function teamDir(name: string): string {
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

const sessionIndex = new Map<
  string,
  { teamName: string; memberName: string }
>();

/**
 * Returns true if the given sessionId is present in the in-memory index.
 * Use as a fast pre-check before calling findTeamBySession: if the index is
 * non-empty and the session is absent, it is definitely not a team session.
 */
export function isKnownSession(sessionId: string): boolean {
  return sessionIndex.has(sessionId);
}

/** Returns the current number of entries in the session index. */
export function sessionIndexSize(): number {
  return sessionIndex.size;
}

function indexTeam(config: TeamConfig): void {
  // Remove any stale entries for this team before re-indexing
  for (const [sessionId, entry] of sessionIndex) {
    if (entry.teamName === config.name) sessionIndex.delete(sessionId);
  }
  sessionIndex.set(config.leadSessionId, {
    teamName: config.name,
    memberName: LEAD_MEMBER_NAME,
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
  clear?: (keyof TeamMember)[],
): Promise<void> {
  return withLock(teamName, async () => {
    const configPath = teamConfigPath(teamName);
    const raw = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as TeamConfig;
    const existing = config.members[memberName];
    if (existing === undefined) {
      throw new Error(`Member "${memberName}" not found in team "${teamName}"`);
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
      patch.lastStatusAt = new Date().toISOString();
    }
    const merged = { ...existing, ...patch } as TeamMember;
    for (const key of clear ?? []) delete merged[key];
    config.members[memberName] = merged;
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

    if (team.leadSessionId === sessionId)
      return { team, memberName: LEAD_MEMBER_NAME };
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
      return {
        ok: false,
        reason: `Task "${taskId}" not found in team "${teamName}".`,
      };
    }
    if (task.status !== "pending") {
      return {
        ok: false,
        reason: `Task "${taskId}" is not pending (current status: "${task.status}").`,
      };
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

    config.tasks[taskId] = {
      ...task,
      status: "in_progress",
      assignee: memberName,
    };

    const member = config.members[memberName];
    if (member !== undefined) {
      config.members[memberName] = {
        ...member,
        currentTask: task.title,
      };
    }

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
): Promise<
  { ok: true; unblockedTaskIds: string[] } | { ok: false; reason: string }
> {
  return withLock(teamName, async () => {
    const configPath = teamConfigPath(teamName);
    const raw = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as TeamConfig;

    const task = config.tasks[taskId];
    if (task === undefined) {
      return {
        ok: false,
        reason: `Task "${taskId}" not found in team "${teamName}".`,
      };
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

    const recovered: Array<{
      memberName: string;
      previousStatus: MemberStatus;
    }> = [];
    let dirty = false;
    for (const [name, member] of Object.entries(config.members)) {
      if (
        member.status === "busy" ||
        member.status === "retrying" ||
        member.status === "shutdown_requested"
      ) {
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

function eventsFilePath(teamName: string): string {
  return path.join(teamDir(teamName), "events.jsonl");
}

// ---------------------------------------------------------------------------
// Event write coalescing — batches rapid appendEvent calls into a single
// fs.appendFile per team, controlled by a debounce timer.
// In test mode (_eventDebounceMs === 0) writes are immediate and synchronous.
// ---------------------------------------------------------------------------

let _eventDebounceMs = 100;
const _eventBuffer = new Map<string, string[]>();
const _eventTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function flushEventBuffer(teamName: string): Promise<void> {
  const lines = _eventBuffer.get(teamName);
  if (!lines || lines.length === 0) return;
  _eventBuffer.delete(teamName);

  const eventsPath = eventsFilePath(teamName);
  await withLock(teamName, async () => {
    const dir = teamDir(teamName);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(eventsPath, lines.join(""), "utf-8");
  });
}

export async function appendEvent(
  teamName: string,
  event: Omit<ChannelEvent, "id" | "timestamp">,
): Promise<ChannelEvent> {
  const fullEvent: ChannelEvent = {
    ...event,
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };
  const line = `${JSON.stringify(fullEvent)}\n`;

  if (_eventDebounceMs === 0) {
    // No debounce (test mode): write immediately
    const eventsPath = eventsFilePath(teamName);
    await withLock(teamName, async () => {
      const dir = teamDir(teamName);
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(eventsPath, line, "utf-8");
    });
    return fullEvent;
  }

  // Buffer the line and (re)start the debounce timer
  const existing = _eventBuffer.get(teamName) ?? [];
  existing.push(line);
  _eventBuffer.set(teamName, existing);

  const existingTimer = _eventTimers.get(teamName);
  if (existingTimer !== undefined) clearTimeout(existingTimer);
  _eventTimers.set(
    teamName,
    setTimeout(() => {
      _eventTimers.delete(teamName);
      flushEventBuffer(teamName).catch((err) => {
        console.error(
          `[opencode-teams] Failed to flush event buffer for team "${teamName}":`,
          err,
        );
      });
    }, _eventDebounceMs),
  );

  return fullEvent;
}

export async function getEvents(
  teamName: string,
  limit: number = 50,
): Promise<{ events: ChannelEvent[]; offset: number }> {
  const eventsPath = eventsFilePath(teamName);
  try {
    const content = await fs.readFile(eventsPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    const total = lines.length;
    const start = Math.max(0, total - limit);
    const selected = lines.slice(start);
    const events = selected.map((l) => JSON.parse(l) as ChannelEvent);
    return { events, offset: total };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], offset: 0 };
    }
    throw err;
  }
}

export async function pruneEvents(
  teamName: string,
  keep: number = MAX_EVENTS_LINES,
): Promise<{ pruned: number; remaining: number }> {
  return withLock(teamName, async () => {
    const eventsPath = eventsFilePath(teamName);
    let content: string;
    try {
      content = await fs.readFile(eventsPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { pruned: 0, remaining: 0 };
      }
      throw err;
    }

    const lines = content.split("\n").filter((l) => l.trim() !== "");
    if (lines.length <= keep) {
      return { pruned: 0, remaining: lines.length };
    }

    const toKeep = lines.slice(-keep);
    const pruned = lines.length - keep;

    const tmpPath = `${eventsPath}.tmp`;
    await fs.writeFile(tmpPath, `${toKeep.join("\n")}\n`, "utf-8");
    await fs.rename(tmpPath, eventsPath);

    return { pruned, remaining: toKeep.length };
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
