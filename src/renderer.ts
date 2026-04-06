import type { TeamConfig } from "./state.js";

const ESC = "\x1b";
const CSI = `${ESC}[`;

export const ansi = {
  save: () => `${CSI}s`,
  restore: () => `${CSI}u`,
  clearLine: () => `${CSI}K`,
  hideCursor: () => `${CSI}?25l`,
  showCursor: () => `${CSI}?25h`,
  cursorTo: (row: number, col: number) => `${CSI}${row};${col}H`,
  cr: () => "\r",
  bold: () => `${CSI}1m`,
  dim: () => `${CSI}2m`,
  reset: () => `${CSI}0m`,
  fg: (n: number) => `${CSI}3${n}m`,
  bg: (n: number) => `${CSI}4${n}m`,
};

const STATUS_COLORS: Record<string, string> = {
  ready: ansi.fg(2),
  busy: ansi.fg(3),
  retrying: ansi.fg(5),
  error: ansi.fg(1),
  shutdown_requested: ansi.fg(5),
  shutdown: ansi.dim(),
};

function progressBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return (
    ansi.fg(6) +
    "█".repeat(Math.max(0, filled)) +
    ansi.dim() +
    "░".repeat(Math.max(0, empty)) +
    ansi.reset()
  );
}

function formatAge(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function memberLine(
  idx: number,
  name: string,
  status: string,
  role: string,
  currentTask: string,
  age: string,
): string {
  const color = STATUS_COLORS[status] ?? ansi.reset();
  const padName = name.padEnd(14, " ");
  const padRole = role.padEnd(18, " ");

  let activityPct = 0;
  let stateTag = status;
  if (status === "ready") {
    activityPct = 0;
    stateTag = "idle";
  } else if (status === "busy") {
    activityPct = 50 + Math.floor(Math.random() * 40);
    stateTag = "working";
  } else if (status === "retrying") {
    activityPct = 20;
    stateTag = "retrying";
  } else if (status === "error") {
    activityPct = 100;
    stateTag = "ERROR";
  }

  const bar = progressBar(activityPct);
  const colorTag =
    status === "error"
      ? ansi.fg(1)
      : status === "busy"
        ? ansi.fg(3)
        : ansi.fg(8);
  const tag = `${colorTag}[${stateTag.padEnd(8)}]${ansi.reset()}`;

  return (
    `${ansi.cursorTo(idx + 1, 1)}` +
    `${ansi.save()}` +
    `${ansi.clearLine()}` +
    `${color}${padName}${ansi.reset()}` +
    ` ${bar} ${tag}` +
    ` ${padRole}` +
    `${ansi.dim()}│${ansi.reset()} ` +
    `${currentTask || "(no task)"} ` +
    `${ansi.dim()}${age}${ansi.reset()}` +
    `${ansi.restore()}`
  );
}

export function renderTeamStatus(team: TeamConfig, maxRows = 8): string {
  const members = Object.values(team.members);
  if (members.length === 0) return "";

  const lines: string[] = [];

  lines.push(
    `${ansi.cursorTo(1, 1)}` +
      `${ansi.clearLine()}` +
      `${ansi.bold()}Team: ${team.name}${ansi.reset()}  ` +
      `${ansi.dim()}${members.length} member${members.length !== 1 ? "s" : ""}${ansi.reset()}`,
  );

  for (let i = 0; i < Math.min(members.length, maxRows - 2); i++) {
    const m = members.at(i);
    if (!m) continue;
    const age = formatAge(m.spawnedAt);
    const currentTask = m.status === "busy" ? "processing..." : "";
    lines.push(memberLine(i + 2, m.name, m.status, "member", currentTask, age));
  }

  for (let i = members.length; i < maxRows - 2; i++) {
    lines.push(`${ansi.cursorTo(i + 2, 1)}${ansi.clearLine()}`);
  }

  lines.push(
    `${ansi.cursorTo(maxRows, 1)}` +
      `${ansi.clearLine()}` +
      `${ansi.dim()}ctrl+t: toggle team status${ansi.reset()}`,
  );

  return lines.join("");
}

/**
 * Plain-text team status summary — safe to send to the model as prompt context.
 * No ANSI escape codes.
 */
export function renderTeamStatusPlain(team: TeamConfig): string {
  const members = Object.values(team.members);
  if (members.length === 0) return `Team ${team.name}: no members`;
  const lines = [
    `[Team ${team.name} — ${members.length} member${members.length !== 1 ? "s" : ""}]`,
  ];
  for (const m of members) {
    const age = formatAge(m.spawnedAt);
    let statusStr: string = m.status;
    if (m.status === "retrying" && m.retryAttempt !== undefined) {
      const nextSec =
        m.retryNextMs !== undefined
          ? `, retry in ${Math.ceil(m.retryNextMs / 1000)}s`
          : "";
      statusStr = `retrying (attempt ${m.retryAttempt}${nextSec})`;
    }
    lines.push(`  ${m.name}: ${statusStr} (${age})`);
  }
  return lines.join("\n");
}

export function renderSeparator(_width: number): string {
  return (
    `${ansi.cursorTo(1, 1)}` +
    `${ansi.clearLine()}` +
    `${ansi.bold()}──┬─────────────────────────────────────────────────────────────${ansi.reset()}`
  );
}

export const CLEAR_SCREEN = `${CSI}J`;
export const CURSOR_HOME = `${CSI}H`;
