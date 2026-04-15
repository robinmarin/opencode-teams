#!/usr/bin/env bun
/**
 * team-log — visualize opencode-teams event logs
 *
 * Usage:
 *   bun scripts/team-log.ts [team-name] [options]
 *
 * Options:
 *   -f, --follow     tail the log live (like tail -f)
 *   --debug          also show low-level debug.jsonl entries
 *   --no-status      hide status-change events
 *   --no-system      hide system events (spawns, shutdowns)
 *   --since <time>   only show events after HH:MM or ISO timestamp
 *   --html           write swimlane report as team.html
 *   --open           auto-open HTML report in browser
 *   --lanes          terminal swimlane view (best-effort)
 *
 * Defaults to the most recently modified team if no name given.
 */

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { watch } from "fs";

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const R = "\x1b[0m";
const B = (s: string) => `\x1b[1m${s}${R}`;
const DIM = (s: string) => `\x1b[2m${s}${R}`;
const italic = (s: string) => `\x1b[3m${s}${R}`;

const COLORS = [
  "\x1b[36m", // cyan
  "\x1b[33m", // yellow
  "\x1b[32m", // green
  "\x1b[35m", // magenta
  "\x1b[34m", // blue
  "\x1b[91m", // bright red
  "\x1b[93m", // bright yellow
  "\x1b[92m", // bright green
  "\x1b[96m", // bright cyan
  "\x1b[95m", // bright magenta
];

const LEAD_COLOR = "\x1b[1;36m"; // bold cyan — always the lead

// ─── Argument parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("-")));
const positional = args.filter((a) => !a.startsWith("-"));

const follow = flags.has("-f") || flags.has("--follow");
const showDebug = flags.has("--debug");
const hideStatus = flags.has("--no-status");
const hideSystem = flags.has("--no-system");
const generateHtml = flags.has("--html");
const autoOpen = flags.has("--open");
const showLanes = flags.has("--lanes");

const sinceIdx = args.findIndex((a) => a === "--since");
const sinceRaw = sinceIdx >= 0 ? args[sinceIdx + 1] : null;

// ─── Locate the team directory ───────────────────────────────────────────────

const teamsBase = join(
  process.env.HOME ?? "/tmp",
  ".config/opencode/teams"
);

function latestTeam(): string {
  const dirs = readdirSync(teamsBase, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const evPath = join(teamsBase, d.name, "events.jsonl");
      const mtime = existsSync(evPath) ? statSync(evPath).mtimeMs : 0;
      return { name: d.name, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (!dirs.length) throw new Error("No teams found in " + teamsBase);
  return dirs[0].name;
}

const teamName = positional[0] ?? latestTeam();
const teamDir = join(teamsBase, teamName);
const eventsPath = join(teamDir, "events.jsonl");
const debugPath = join(teamDir, "logs", "debug.jsonl");
const configPath = join(teamDir, "config.json");

if (!existsSync(eventsPath)) {
  console.error(`No events log found at ${eventsPath}`);
  process.exit(1);
}

// ─── Load config — session ID → member name map ──────────────────────────────

interface MemberConfig {
  name: string;
  sessionId: string;
  status: string;
  agentType: string;
}
interface TeamConfig {
  leadSessionId: string;
  members: Record<string, MemberConfig>;
}

let config: TeamConfig | null = null;
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as TeamConfig;
  } catch {}
}

// Build session → name map (updated when config reloads)
function buildSessionMap(cfg: TeamConfig | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!cfg) return map;
  map.set(cfg.leadSessionId, "__lead__");
  for (const m of Object.values(cfg.members)) {
    map.set(m.sessionId, m.name);
  }
  return map;
}

let sessionMap = buildSessionMap(config);

// Bootstrap: scan events.jsonl to discover all lead session IDs
// (there can be multiple lead sessions over the team's lifetime)
function bootstrapSessionMapFromEvents(map: Map<string, string>) {
  const lines = readLines(eventsPath);
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as Event;
      // Any event where sender is explicitly "__lead__" tells us that senderId is a lead session
      if (ev.sender === "__lead__" && ev.senderId && !map.has(ev.senderId)) {
        map.set(ev.senderId, "__lead__");
      }
      // status events: sender is the member name
      if (ev.type === "status" && ev.sender && !ev.sender.startsWith("ses_") && ev.senderId) {
        if (!map.has(ev.senderId)) map.set(ev.senderId, ev.sender);
      }
    } catch {}
  }
}

bootstrapSessionMapFromEvents(sessionMap);

function resolveSession(sid: string): string {
  return sessionMap.get(sid) ?? sid.slice(0, 12) + "…";
}

function resolveSender(sender: string, senderId: string): string {
  if (sender === "__lead__") return "__lead__";
  if (sender && !sender.startsWith("ses_")) return sender;
  return resolveSession(senderId ?? sender);
}

// ─── Color assignment ─────────────────────────────────────────────────────────

const colorCache = new Map<string, string>();
let colorIdx = 0;

function colorFor(name: string): string {
  if (name === "__lead__") return LEAD_COLOR;
  if (!colorCache.has(name)) {
    colorCache.set(name, COLORS[colorIdx++ % COLORS.length]);
  }
  return colorCache.get(name)!;
}

function paint(name: string, text: string): string {
  return `${colorFor(name)}${text}${R}`;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  // HH:MM:SS
  return iso.slice(11, 19);
}

function parseTime(raw: string): number {
  // HH:MM → minutes from midnight for comparison
  const m = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3] ?? "0");
  return 0;
}

function tsToSeconds(iso: string): number {
  const m = iso.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
}

const sinceSeconds = sinceRaw ? parseTime(sinceRaw) : -1;

function afterSince(iso: string): boolean {
  if (sinceSeconds < 0) return true;
  return tsToSeconds(iso) >= sinceSeconds;
}

// ─── Event types ──────────────────────────────────────────────────────────────

interface Event {
  type: "system" | "status" | "message";
  sender: string;
  senderId: string;
  content: string;
  mentions?: string[];
  status?: string;
  memberName?: string;
  id: string;
  timestamp: string;
}

interface DebugEntry {
  ts: string;
  level: string;
  category: string;
  message: string;
  memberName?: string | null;
  context?: Record<string, unknown> | null;
}

function renderEvent(ev: Event): string | null {
  if (!afterSince(ev.timestamp)) return null;
  const t = DIM(fmtTime(ev.timestamp));

  if (ev.type === "system") {
    if (hideSystem) return null;
    const who = resolveSender(ev.sender, ev.senderId);
    return `${t}  ${DIM("·")} ${DIM(italic(ev.content))}`;
  }

  if (ev.type === "status") {
    if (hideStatus) return null;
    const name = ev.memberName ?? resolveSender(ev.sender, ev.senderId);
    // content is like "dx is now ready" — extract the final word as the status
    const lastWord = ev.content?.split(" ").pop() ?? ev.status ?? "?";
    const isBusy = lastWord === "busy";
    const dot = isBusy ? "\x1b[33m●\x1b[0m" : "\x1b[32m●\x1b[0m";
    const statusLabel = isBusy ? "\x1b[33mbusy\x1b[0m" : "\x1b[32mready\x1b[0m";
    return `${t}  ${dot} ${paint(name, name)} ${statusLabel}`;
  }

  if (ev.type === "message") {
    const from = resolveSender(ev.sender, ev.senderId);
    const mentions = ev.mentions ?? [];
    const toStr =
      mentions.length > 0
        ? mentions.map((m) => paint(m, m)).join(", ")
        : DIM("broadcast");
    const label = `${paint(from, B(from))} → ${toStr}`;
    const content = ev.content ?? "";
    const lines = content.split("\n");
    const firstLine = lines[0];
    const rest = lines.slice(1).join("\n").trimEnd();
    let out = `${t}  ${label}\n`;
    out += `         ${firstLine}`;
    if (rest) {
      out +=
        "\n" +
        rest
          .split("\n")
          .map((l) => `         ${l}`)
          .join("\n");
    }
    return out;
  }

  return null;
}

// High-signal debug messages to surface when --debug is on
const DEBUG_KEEP = new Set([
  "member spawned",
  "member status set to ready",
  "lead notified of member idle",
  "lead notified of busy members",
  "prompting lead about busy members",
  "lead session.status ignored (anti-loop)",
  "team_shutdown called",
  "shutdown requested",
]);

function renderDebug(d: DebugEntry): string | null {
  if (!afterSince(d.ts)) return null;
  if (!DEBUG_KEEP.has(d.message)) return null;
  const t = DIM(fmtTime(d.ts));
  const lvl = d.level === "warn" ? "\x1b[33mWARN\x1b[0m" : DIM("DBG ");
  const ctx = d.context ? " " + DIM(JSON.stringify(d.context)) : "";
  return `${t}  ${lvl} ${DIM(d.message)}${ctx}`;
}

// ─── Parse files ──────────────────────────────────────────────────────────────

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

// Merge events + debug by timestamp
interface Timestamped {
  ts: string;
  render: () => string | null;
}

function buildTimeline(evLines: string[], dbgLines: string[]): Timestamped[] {
  const items: Timestamped[] = [];

  for (const line of evLines) {
    try {
      const ev = JSON.parse(line) as Event;
      items.push({ ts: ev.timestamp, render: () => renderEvent(ev) });
    } catch {}
  }

  if (showDebug) {
    for (const line of dbgLines) {
      try {
        const d = JSON.parse(line) as DebugEntry;
        items.push({ ts: d.ts, render: () => renderDebug(d) });
      } catch {}
    }
  }

  items.sort((a, b) => a.ts.localeCompare(b.ts));
  return items;
}

// ─── HTML report ─────────────────────────────────────────────────────────────

interface HtmlEvent {
  type: "system" | "status" | "message";
  sender: string;
  senderId: string;
  content: string;
  mentions?: string[];
  status?: string;
  memberName?: string;
  id: string;
  timestamp: string;
}

interface StatusSpan {
  member: string;
  status: "busy" | "ready" | "retrying" | "error" | "shutdown";
  from: string;
  to: string;
}

function generateHtmlReport(
  teamName: string,
  events: HtmlEvent[],
  members: string[],
  leadName: string,
  outputPath: string,
  doOpen: boolean,
  doFollow: boolean
): void {
  const allAgents = [leadName, ...members];

  const statusSpans: StatusSpan[] = [];
  const memberLastStatus: Record<string, { status: string; ts: string }> = {};

  for (const ev of events) {
    if (ev.type === "status") {
      const name = ev.memberName ?? ev.sender;
      const lastWord = ev.content?.split(" ").pop() ?? ev.status ?? "ready";
      let status: StatusSpan["status"] = "ready";
      if (lastWord === "busy") status = "busy";
      else if (lastWord === "retrying") status = "retrying";
      else if (lastWord === "shutdown") status = "shutdown";
      else if (lastWord === "error") status = "error";

      if (memberLastStatus[name]) {
        const prev = memberLastStatus[name];
        statusSpans.push({ member: name, status: prev.status as StatusSpan["status"], from: prev.ts, to: ev.timestamp });
      }
      memberLastStatus[name] = { status, ts: ev.timestamp };
    }
  }

  for (const m of allAgents) {
    if (!memberLastStatus[m]) {
      memberLastStatus[m] = { status: "ready", ts: events[0]?.timestamp ?? new Date().toISOString() };
    }
  }

  const messages = events.filter((e) => e.type === "message");
  const sysEvents = events.filter((e) => e.type === "system");

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const fmtTime = (iso: string) => iso.slice(11, 19);

  const STATUS_COLORS: Record<string, string> = {
    busy: "#f59e0b",
    ready: "#22c55e",
    retrying: "#a855f7",
    error: "#ef4444",
    shutdown: "#6b7280",
  };

  const AGENT_COLORS = [
    "#06b6d4", "#eab308", "#22c55e", "#a855f7", "#3b82f6", "#ef4444", "#f97316", "#ec4899",
  ];

  const agentColorMap = new Map<string, string>();
  allAgents.forEach((a, i) => agentColorMap.set(a, AGENT_COLORS[i % AGENT_COLORS.length]));

  const memberColWidth = 160;
  const timeColWidth = 80;
  const colWidth = memberColWidth;
  const totalWidth = timeColWidth + allAgents.length * colWidth + 20;

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Team: ${esc(teamName)} — Timeline Report</title>`;

  if (doFollow) {
    html += `\n<meta http-equiv="refresh" content="2">`;
  }

  html += `
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
.container { max-width: 100vw; overflow-x: auto; padding: 16px; }
h1 { font-size: 18px; font-weight: 600; margin-bottom: 12px; color: #f8fafc; }
.meta { font-size: 12px; color: #64748b; margin-bottom: 16px; }
.chart { display: grid; grid-template-columns: ${timeColWidth}px ${allAgents.map(() => colWidth + "px").join(" ")}; border: 1px solid #1e293b; border-radius: 6px; overflow: hidden; font-size: 12px; }
.header-cell { background: #1e293b; padding: 8px 6px; font-weight: 600; text-align: center; border-bottom: 1px solid #334155; position: sticky; top: 0; z-index: 10; }
.header-cell.lead { color: #22d3ee; }
.time-cell { background: #1e293b; color: #64748b; padding: 4px 6px; border-right: 1px solid #334155; display: flex; align-items: center; font-size: 11px; }
.agent-cell { border-right: 1px solid #1e293b; position: relative; min-height: 40px; }
.row { display: contents; }
.row:hover .time-cell { background: #1e3a5f; }
.row:hover .agent-cell { background: #1a2744; }
.status-bar { position: absolute; top: 2px; left: 0; right: 0; height: 6px; border-radius: 3px; }
.status-bar.busy { background: #f59e0b; }
.status-bar.ready { background: #22c55e; }
.status-bar.retrying { background: #a855f7; }
.status-bar.error { background: #ef4444; }
.status-bar.shutdown { background: #6b7280; }
.msg-row { display: flex; align-items: center; height: 36px; padding: 2px 4px; cursor: pointer; }
.msg-row:hover { background: #1e3a5f; border-radius: 4px; }
.msg-arrow { flex: 1; display: flex; align-items: center; overflow: hidden; height: 100%; }
.arrow-line { height: 2px; flex: 1; }
.arrow-head { width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; border-left: 8px solid currentColor; }
.msg-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin: 0 4px; }
.msg-text { margin-left: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; color: #94a3b8; }
.tooltip { position: fixed; background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 10px 14px; font-size: 13px; max-width: 400px; z-index: 100; display: none; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
.tooltip.show { display: block; }
.tooltip pre { white-space: pre-wrap; word-break: break-word; margin-top: 6px; color: #cbd5e1; }
.tooltip .msg-header { font-weight: 600; color: #e2e8f0; }
.tooltip .msg-time { font-size: 11px; color: #64748b; margin-bottom: 4px; }
.legend { display: flex; gap: 16px; margin-bottom: 12px; font-size: 12px; }
.legend-item { display: flex; align-items: center; gap: 6px; }
.legend-dot { width: 10px; height: 10px; border-radius: 50%; }
.sys-row { grid-column: 1 / -1; padding: 4px 8px; color: #475569; font-style: italic; font-size: 11px; }
</style>
</head>
<body>
<div class="container">
<h1>Team: ${esc(teamName)}</h1>
<div class="meta">${events.length} events · ${allAgents.length} agents · ${outputPath}</div>
<div class="legend">
  <div class="legend-item"><div class="legend-dot" style="background:#22c55e"></div>ready</div>
  <div class="legend-item"><div class="legend-dot" style="background:#f59e0b"></div>busy</div>
  <div class="legend-item"><div class="legend-dot" style="background:#a855f7"></div>retrying</div>
  <div class="legend-item"><div class="legend-dot" style="background:#ef4444"></div>error</div>
  <div class="legend-item"><div class="legend-dot" style="background:#6b7280"></div>shutdown</div>
</div>
<div class="chart" id="chart">`;

  html += `<div class="header-cell">Time</div>`;
  for (const agent of allAgents) {
    const isLead = agent === leadName;
    html += `<div class="header-cell${isLead ? " lead" : ""}">${esc(agent)}${isLead ? " ★" : ""}</div>`;
  }

  const statusAtTs: Record<string, Record<string, StatusSpan["status"]>> = {};
  const openSpans: Record<string, StatusSpan> = {};

  function getStatusAt(member: string, ts: string): StatusSpan["status"] {
    if (statusAtTs[ts]?.[member]) return statusAtTs[ts][member];
    const sorted = events.filter((e) => e.timestamp <= ts && e.type === "status");
    const lastStatus = sorted.filter((e) => (e.memberName ?? e.sender) === member).slice(-1)[0];
    const lastWord = lastStatus?.content?.split(" ").pop() ?? lastStatus?.status ?? "ready";
    if (lastWord === "busy") return "busy";
    if (lastWord === "retrying") return "retrying";
    if (lastWord === "shutdown") return "shutdown";
    if (lastWord === "error") return "error";
    return "ready";
  }

  const timelineEvents = events.filter((e) => e.type === "message" || e.type === "system");
  const firstTs = events[0]?.timestamp ?? new Date().toISOString();
  const lastTs = events[events.length - 1]?.timestamp ?? new Date().toISOString();

  const stepMs = 60000;
  let curTs = firstTs.slice(0, 14) + "00:00.000Z";
  while (curTs <= lastTs) {
    const rowTime = curTs.slice(11, 19);
    const rowIso = curTs;

    html += `<div class="row">`;
    html += `<div class="time-cell">${esc(rowTime)}</div>`;

    for (const agent of allAgents) {
      const st = getStatusAt(agent, rowIso);
      const color = STATUS_COLORS[st] ?? "#22c55e";
      html += `<div class="agent-cell">
        <div class="status-bar ${esc(st)}" style="background:${color}"></div>
      </div>`;
    }

    html += `</div>`;
    curTs = new Date(new Date(curTs).getTime() + stepMs).toISOString();
  }

  const msgEvents = events.filter((e) => e.type === "message");
  for (const ev of msgEvents) {
    const from = ev.sender === "__lead__" ? leadName : (ev.sender && !ev.sender.startsWith("ses_") ? ev.sender : resolveSession(ev.senderId));
    const mentions = ev.mentions ?? [];
    const toNames = mentions.length > 0
      ? mentions.map((m) => (m === "__lead__" ? leadName : m))
      : allAgents;
    const content = ev.content ?? "";
    const short = content.split("\n")[0].slice(0, 40);
    const fullEsc = esc(content);
    const shortEsc = esc(short);
    const timeEsc = esc(fmtTime(ev.timestamp));
    const fromColor = agentColorMap.get(from) ?? "#06b6d4";
    const toColor = toNames[0] ? (agentColorMap.get(toNames[0]) ?? "#06b6d4") : fromColor;
    const fromIdx = allAgents.indexOf(from);
    const firstToIdx = toNames[0] ? allAgents.indexOf(toNames[0]) : 0;
    const arrowDir = firstToIdx >= fromIdx ? "right" : "left";

    html += `<div class="row">`;
    html += `<div class="time-cell">${timeEsc}</div>`;

    for (let ci = 0; ci < allAgents.length; ci++) {
      const agent = allAgents[ci];
      const isFrom = ci === fromIdx;
      const isTo = toNames.includes(agent);
      const cellBg = isFrom ? "background:#1e3a5f;border-radius:4px;margin:2px 0;" : "";

      html += `<div class="agent-cell" style="${cellBg}">`;

      if (isFrom) {
        html += `<div class="msg-row" data-msg="${esc(fullEsc)}" data-from="${esc(from)}" data-to="${toNames.map(esc).join(", ")}">`;
        html += `<div class="msg-arrow" style="color:${fromColor}">`;
        html += `<div class="msg-dot" style="background:${fromColor}"></div>`;
        html += `<div class="arrow-line" style="background:${fromColor}"></div>`;
        if (arrowDir === "right") {
          html += `<div class="arrow-head" style="border-left-color:${fromColor}"></div>`;
        }
        html += `</div>`;
        html += `<div class="msg-text" title="${esc(content)}">${shortEsc}</div>`;
        html += `</div>`;
      } else if (isTo) {
        html += `<div class="msg-row">`;
        html += `<div class="msg-arrow" style="color:${toColor}">`;
        if (arrowDir === "left") {
          html += `<div class="arrow-head" style="border-left-color:${toColor};transform:rotate(180deg)"></div>`;
        }
        html += `<div class="arrow-line" style="background:${toColor}"></div>`;
        html += `<div class="msg-dot" style="background:${toColor}"></div>`;
        html += `</div>`;
        html += `<div class="msg-text">${shortEsc}</div>`;
        html += `</div>`;
      }

      html += `</div>`;
    }

    html += `</div>`;
  }

  for (const ev of sysEvents) {
    html += `<div class="row sys-row"><div class="time-cell">${esc(fmtTime(ev.timestamp))}</div><div>${esc(ev.content)}</div></div>`;
  }

  html += `
</div>
<div class="tooltip" id="tooltip"></div>
<script>
document.querySelectorAll('.msg-row[data-msg]').forEach(el => {
  el.addEventListener('click', (e) => {
    const tip = document.getElementById('tooltip');
    const msg = el.getAttribute('data-msg') ?? '';
    const from = el.getAttribute('data-from') ?? '';
    const to = el.getAttribute('data-to') ?? '';
    tip.innerHTML = '<div class="msg-time">' + from + ' → ' + to + '</div><pre>' + msg + '</pre>';
    tip.classList.add('show');
    const rect = el.getBoundingClientRect();
    tip.style.left = Math.min(rect.left, window.innerWidth - 420) + 'px';
    tip.style.top = (rect.bottom + 8) + 'px';
    e.stopPropagation();
  });
});
document.addEventListener('click', () => {
  document.getElementById('tooltip').classList.remove('show');
});
</script>
</div>
</body>
</html>`;

  writeFileSync(outputPath, html, "utf8");

  if (doOpen) {
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    Bun.spawn([openCmd, outputPath], { stdio: "inherit" });
  }
}

// ─── Header ───────────────────────────────────────────────────────────────────

function printHeader() {
  const members = config ? Object.keys(config.members) : [];
  console.log();
  console.log(B(`  Team: ${teamName}`));
  if (members.length) {
    const roster = members
      .map((m) => {
        const mc = config!.members[m];
        const dot = mc.status === "busy" ? "\x1b[33m●\x1b[0m" : "\x1b[32m●\x1b[0m";
        return `${dot} ${paint(m, m)}`;
      })
      .join("   ");
    console.log(`  ${roster}`);
  }
  console.log(
    DIM(
      `  ${eventsPath}${follow ? "  (following)" : ""}${showDebug ? "  +debug" : ""}`
    )
  );
  console.log(DIM("  ─".repeat(40)));
  console.log();
}

// ─── Main render ──────────────────────────────────────────────────────────────

const evLines = readLines(eventsPath);
const dbgLines = showDebug ? readLines(debugPath) : [];
const timeline = buildTimeline(evLines, dbgLines);

if (generateHtml) {
  const htmlEvents: HtmlEvent[] = [];
  for (const line of evLines) {
    try { htmlEvents.push(JSON.parse(line) as HtmlEvent); } catch {}
  }

  const memberNames = config ? Object.keys(config.members) : [];
  const leadName = "__lead__";
  const outputPath = join(teamDir, "report.html");
  generateHtmlReport(teamName, htmlEvents, memberNames, leadName, outputPath, autoOpen, follow);

  if (!follow) {
    process.exit(0);
  }
}

if (showLanes) {
  const htmlEvents: HtmlEvent[] = [];
  for (const line of evLines) {
    try { htmlEvents.push(JSON.parse(line) as HtmlEvent); } catch {}
  }
  const memberNames = config ? Object.keys(config.members) : [];
  const allAgents = ["__lead__", ...memberNames];

  function displayName(name: string): string {
    return name === "__lead__" ? "lead" : name;
  }

  const termWidth = (process.stdout as { columns?: number }).columns ?? 200;
  const timeColWidth = 9;
  const maxAgentName = allAgents.reduce((m, a) => Math.max(m, displayName(a).length), 0);
  const agentColWidth = Math.max(10, maxAgentName + 2);
  const maxAgents = Math.min(allAgents.length, Math.floor((termWidth - timeColWidth - 1) / agentColWidth));
  const visibleAgents = allAgents.slice(0, maxAgents);
  const hiddenCount = allAgents.length - maxAgents;

  function colStart(colIdx: number): number {
    return timeColWidth + 1 + colIdx * agentColWidth;
  }

  function rowForTime(time: string): string {
    return (time + " ").padEnd(timeColWidth + 1) + visibleAgents.map((_, i) => " ".repeat(agentColWidth)).join("");
  }

  function renderHeader(): void {
    const timeHdr = B("TIME".padEnd(timeColWidth)) + " ";
    const agentsHdr = visibleAgents.map((a) => B(displayName(a).padEnd(agentColWidth))).join("");
    console.log(timeHdr + agentsHdr + (hiddenCount > 0 ? DIM(` +${hiddenCount}`) : ""));
    console.log(DIM("─".repeat(timeColWidth + 1 + visibleAgents.length * agentColWidth)));
  }

  const filtered = htmlEvents.filter((e) => e.type === "status" || e.type === "message");
  let lastTsFormatted = "\n";

  function sameTs(ts: string): boolean {
    const t = fmtTime(ts);
    return lastTsFormatted !== "\n" && t === lastTsFormatted;
  }

  renderHeader();

  for (const ev of filtered) {
    if (ev.type === "status") {
      const name = ev.memberName ?? ev.sender;
      const lastWord = ev.content?.split(" ").pop() ?? ev.status ?? "ready";
      statusMap[name] = lastWord;
      const agentIdx = allAgents.indexOf(name);
      if (agentIdx >= maxAgents) continue;
      const timeStr = sameTs(ev.timestamp) ? "─".repeat(timeColWidth) : fmtTime(ev.timestamp);
      if (!sameTs(ev.timestamp)) lastTsFormatted = fmtTime(ev.timestamp);

      let row = rowForTime(timeStr);
      const label = lastWord === "busy" ? DIM("[busy]") : DIM("[ready]");
      row = row.slice(0, colStart(agentIdx)) + label + row.slice(colStart(agentIdx) + label.length);
      console.log(row + (hiddenCount > 0 ? DIM(` +${hiddenCount}`) : ""));
    }

    if (ev.type === "message") {
      const from = ev.sender === "__lead__" ? "__lead__" : (ev.sender && !ev.sender.startsWith("ses_") ? ev.sender : resolveSession(ev.senderId));
      const mentions = ev.mentions ?? [];
      const recipients = mentions.length > 0 ? mentions : allAgents.filter((a) => a !== from);
      const content = (ev.content ?? "").split("\n")[0];

      const fromIdx = allAgents.indexOf(from);
      const toIdxs = recipients
        .map((r) => allAgents.indexOf(r))
        .filter((idx) => idx >= 0 && idx < maxAgents && idx !== fromIdx);

      if (fromIdx < 0 || fromIdx >= maxAgents) continue;
      if (toIdxs.length === 0) continue;

      const timeStr = sameTs(ev.timestamp) ? "─".repeat(timeColWidth) : fmtTime(ev.timestamp);
      if (!sameTs(ev.timestamp)) lastTsFormatted = fmtTime(ev.timestamp);

      let row = rowForTime(timeStr);
      const firstTo = toIdxs[0];
      const toName = displayName(visibleAgents[firstTo]);

      const arrowStr = "→" + toName;
      row = row.slice(0, colStart(fromIdx)) + arrowStr + row.slice(colStart(fromIdx) + arrowStr.length);

      const dashStart = colStart(fromIdx) + arrowStr.length;
      const dashEnd = colStart(firstTo);
      const dashLen = Math.max(0, Math.min(dashEnd - dashStart, termWidth - dashStart));
      if (dashLen > 0) {
        row = row.slice(0, dashStart) + DIM("─".repeat(dashLen)) + row.slice(dashStart + dashLen);
      }

      const maxContent = agentColWidth - 3;
      const contentStr = `"${content.slice(0, maxContent)}${content.length > maxContent ? "…" : ""}"`;
      const contentStart = colStart(firstTo);
      row = row.slice(0, contentStart) + DIM(contentStr) + row.slice(contentStart + contentStr.length);

      console.log(row + (hiddenCount > 0 ? DIM(` +${hiddenCount}`) : ""));
    }
  }

  if (!follow) {
    process.exit(0);
  }
}
  const memberNames = config ? Object.keys(config.members) : [];
  const allAgents = ["__lead__", ...memberNames];

  function displayName(name: string): string {
    return name === "__lead__" ? "lead" : name;
  }

  const termWidth = (process.stdout as { columns?: number }).columns ?? 200;
  const timeColWidth = 9;
  const agentColWidth = Math.max(12, allAgents.reduce((m, a) => Math.max(m, displayName(a).length), 0) + 2);
  const maxAgents = Math.min(allAgents.length, Math.floor((termWidth - timeColWidth - 1) / agentColWidth));
  const visibleAgents = allAgents.slice(0, maxAgents);
  const hiddenCount = allAgents.length - maxAgents;
  const rowWidth = timeColWidth + 1 + maxAgents * agentColWidth;

  function colStart(colIdx: number): number {
    return timeColWidth + 1 + colIdx * agentColWidth;
  }

  function writeAt(row: string, start: number, s: string): string {
    const before = row.slice(0, start);
    const after = row.slice(start + s.length);
    return before + s + after;
  }

  function writeDimAt(row: string, start: number, s: string): string {
    const d = "\x1b[2m";
    const r = "\x1b[0m";
    const before = row.slice(0, start);
    const after = row.slice(start + s.length);
    return before + d + s + r + after;
  }

  function flushRow(row: string): void {
    if (hiddenCount > 0) row += DIM(` +${hiddenCount}`);
    console.log(row);
  }

  function makeRow(): string {
    return " ".repeat(rowWidth);
  }

  function renderHeader(): void {
    let row = makeRow();
    row = writeDimAt(row, 0, "TIME".padEnd(timeColWidth));
    for (let i = 0; i < visibleAgents.length; i++) {
      row = writeDimAt(row, colStart(i), displayName(visibleAgents[i]).padEnd(agentColWidth));
    }
    flushRow(row);
    console.log(DIM("─".repeat(rowWidth)));
  }

  const statusMap: Record<string, string> = {};
  for (const a of allAgents) statusMap[a] = "ready";

  const filtered = htmlEvents.filter((e) => e.type === "status" || e.type === "message");
  let lastTsFormatted = "\n"; // won't match any fmtTime output

  function sameTs(ts: string): boolean {
    const t = fmtTime(ts);
    return lastTsFormatted !== "\n" && t === lastTsFormatted;
  }

  renderHeader();

  for (const ev of filtered) {
    if (ev.type === "status") {
      const name = ev.memberName ?? ev.sender;
      const lastWord = ev.content?.split(" ").pop() ?? ev.status ?? "ready";
      statusMap[name] = lastWord;
      const agentIdx = allAgents.indexOf(name);
      if (agentIdx >= maxAgents) continue;
      const timeStr = sameTs(ev.timestamp) ? "─".repeat(timeColWidth) : fmtTime(ev.timestamp);
      if (!sameTs(ev.timestamp)) lastTsFormatted = fmtTime(ev.timestamp);

      let row = makeRow();
      row = writeAt(row, 0, timeStr + " ");
      const label = lastWord === "busy" ? DIM("[busy]") : DIM("[ready]");
      row = writeAt(row, colStart(agentIdx), label);
      flushRow(row);
    }

    if (ev.type === "message") {
      const from = ev.sender === "__lead__" ? "__lead__" : (ev.sender && !ev.sender.startsWith("ses_") ? ev.sender : resolveSession(ev.senderId));
      const mentions = ev.mentions ?? [];
      const recipients = mentions.length > 0 ? mentions : allAgents.filter((a) => a !== from);
      const content = (ev.content ?? "").split("\n")[0];

      const fromIdx = allAgents.indexOf(from);
      const toIdxs = recipients
        .map((r) => allAgents.indexOf(r))
        .filter((idx) => idx >= 0 && idx < maxAgents && idx !== fromIdx);

      if (fromIdx < 0 || fromIdx >= maxAgents) continue;

      const timeStr = sameTs(ev.timestamp) ? "─".repeat(timeColWidth) : fmtTime(ev.timestamp);
      if (!sameTs(ev.timestamp)) lastTsFormatted = fmtTime(ev.timestamp);

      let row = makeRow();
      row = writeAt(row, 0, timeStr + " ");

      if (toIdxs.length === 0) continue;

      const firstTo = toIdxs[0];
      const toName = displayName(visibleAgents[firstTo]);

      const arrowStr = "→" + toName;
      row = writeDimAt(row, colStart(fromIdx), arrowStr);

      const dashStart = colStart(fromIdx) + arrowStr.length;
      const dashEnd = colStart(firstTo);
      if (dashStart < dashEnd && dashStart < rowWidth) {
        const dashLen = Math.min(dashEnd - dashStart, rowWidth - dashStart);
        row = writeDimAt(row, dashStart, "─".repeat(dashLen));
      }

      const maxContent = agentColWidth - 3;
      const contentStr = `"${content.slice(0, maxContent)}${content.length > maxContent ? "…" : ""}"`;
      row = writeDimAt(row, colStart(firstTo), contentStr);

      flushRow(row);
    }
  }

  if (!follow) {
    process.exit(0);
  }
}

printHeader();

let rendered = 0;
for (const item of timeline) {
  const out = item.render();
  if (out) {
    console.log(out);
    rendered++;
  }
}

if (rendered === 0) {
  console.log(DIM("  (no events to show)"));
}

if (!follow) {
  console.log();
  process.exit(0);
}

// ─── Follow mode — tail both files ───────────────────────────────────────────

console.log();
console.log(DIM("  ── live ──"));
console.log();

let evOffset = readFileSync(eventsPath).length;
let dbgOffset = existsSync(debugPath) ? readFileSync(debugPath).length : 0;

function reloadConfig() {
  if (!existsSync(configPath)) return;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as TeamConfig;
    sessionMap = buildSessionMap(config);
    bootstrapSessionMapFromEvents(sessionMap);
  } catch {}
}

function checkFile(path: string, offset: number): [string[], number] {
  if (!existsSync(path)) return [[], offset];
  const buf = readFileSync(path);
  if (buf.length <= offset) return [[], offset];
  const newBytes = buf.slice(offset);
  const lines = newBytes.toString("utf8").split("\n").filter(Boolean);
  return [lines, buf.length];
}

function pollEvents() {
  reloadConfig();
  const [newEvLines, newEvOff] = checkFile(eventsPath, evOffset);
  evOffset = newEvOff;

  const [newDbgLines, newDbgOff] = checkFile(debugPath, dbgOffset);
  dbgOffset = newDbgOff;

  const newItems = buildTimeline(newEvLines, showDebug ? newDbgLines : []);
  for (const item of newItems) {
    const out = item.render();
    if (out) console.log(out);
  }
}

setInterval(pollEvents, 500);
