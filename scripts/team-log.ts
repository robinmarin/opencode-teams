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
 *   --html           write swimlane report as report.html and open it
 *   --no-open        skip auto-opening the browser
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
const autoOpen = !flags.has("--no-open");
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

interface StatusSpan {
  member: string;
  status: "busy" | "ready" | "retrying" | "error" | "shutdown";
  from: string;
  to: string;
}

function generateHtmlReport(
  teamName: string,
  events: Event[],
  members: string[],
  leadName: string,
  outputPath: string,
  doOpen: boolean,
  doFollow: boolean
): void {
  const allAgents = [leadName, ...members];

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const fmtT = (iso: string) => iso.slice(11, 19);

  const STATUS_COLORS: Record<string, string> = {
    busy: "#f59e0b", ready: "#22c55e", retrying: "#a855f7",
    error: "#ef4444", shutdown: "#6b7280",
  };

  const AGENT_COLORS = [
    "#06b6d4", "#eab308", "#22c55e", "#a855f7",
    "#3b82f6", "#ef4444", "#f97316", "#ec4899",
  ];

  const agentColorMap = new Map<string, string>();
  allAgents.forEach((a, i) => agentColorMap.set(a, AGENT_COLORS[i % AGENT_COLORS.length]));

  function statusAt(member: string, ts: string): string {
    const prior = events.filter(
      (e) => e.type === "status" && e.timestamp <= ts && (e.memberName ?? e.sender) === member
    );
    if (!prior.length) return "ready";
    const last = prior[prior.length - 1];
    return last.content?.split(" ").pop() ?? last.status ?? "ready";
  }

  const memberColWidth = 160;
  const timeColWidth = 80;

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Team: ${esc(teamName)}</title>`;

  if (doFollow) html += `\n<meta http-equiv="refresh" content="2">`;

  html += `
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; }
.container { overflow-x: auto; padding: 16px; }
h1 { font-size: 18px; font-weight: 600; margin-bottom: 4px; color: #f8fafc; }
.meta { font-size: 12px; color: #64748b; margin-bottom: 16px; }
.chart { display: grid; grid-template-columns: ${timeColWidth}px ${allAgents.map(() => memberColWidth + "px").join(" ")}; border: 1px solid #1e293b; border-radius: 6px; overflow: hidden; font-size: 12px; }
.header-cell { background: #1e293b; padding: 8px 6px; font-weight: 600; text-align: center; border-bottom: 1px solid #334155; position: sticky; top: 0; z-index: 10; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.time-cell { background: #161e2e; color: #64748b; padding: 4px 6px; border-right: 1px solid #1e293b; display: flex; align-items: center; font-size: 11px; white-space: nowrap; }
.agent-cell { border-right: 1px solid #1e293b; position: relative; min-height: 32px; }
.row { display: contents; }
.row:hover .time-cell, .row:hover .agent-cell { background: rgba(255,255,255,0.03); }
.status-bar { position: absolute; top: 2px; left: 0; right: 0; height: 4px; border-radius: 2px; }
.msg-row { display: flex; align-items: center; height: 32px; padding: 2px 6px; cursor: pointer; gap: 4px; }
.msg-row:hover { background: rgba(255,255,255,0.06); border-radius: 4px; }
.msg-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.arrow-line { height: 1px; flex: 1; opacity: 0.5; }
.arrow-head { flex-shrink: 0; opacity: 0.7; }
.msg-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 110px; color: #94a3b8; font-size: 11px; }
.msg-recv { color: #64748b; font-size: 11px; padding: 0 6px; }
.sys-row { grid-column: 1 / -1; padding: 3px 8px; color: #475569; font-style: italic; font-size: 11px; display: block; border-top: 1px solid #1e293b; }
.tooltip { position: fixed; background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 10px 14px; font-size: 13px; max-width: 440px; z-index: 100; display: none; box-shadow: 0 10px 40px rgba(0,0,0,0.6); }
.tooltip.show { display: block; }
.tooltip pre { white-space: pre-wrap; word-break: break-word; margin-top: 6px; color: #cbd5e1; line-height: 1.5; }
.tooltip .hdr { font-weight: 600; color: #e2e8f0; }
.tooltip .ts { font-size: 11px; color: #64748b; margin-bottom: 4px; }
.legend { display: flex; gap: 16px; margin-bottom: 12px; font-size: 12px; flex-wrap: wrap; }
.legend-item { display: flex; align-items: center; gap: 6px; }
.legend-dot { width: 9px; height: 9px; border-radius: 50%; }
</style>
</head>
<body>
<div class="container">
<h1>Team: ${esc(teamName)}</h1>
<div class="meta">${events.length} events · ${allAgents.length} agents · ${esc(outputPath)}</div>
<div class="legend">
  <div class="legend-item"><div class="legend-dot" style="background:#22c55e"></div>ready</div>
  <div class="legend-item"><div class="legend-dot" style="background:#f59e0b"></div>busy</div>
  <div class="legend-item"><div class="legend-dot" style="background:#a855f7"></div>retrying</div>
  <div class="legend-item"><div class="legend-dot" style="background:#ef4444"></div>error</div>
  <div class="legend-item"><div class="legend-dot" style="background:#6b7280"></div>shutdown</div>
</div>
<div class="chart" id="chart">`;

  // Header row
  html += `<div class="header-cell" style="color:#64748b">Time</div>`;
  for (const agent of allAgents) {
    const color = agentColorMap.get(agent) ?? "#06b6d4";
    const isLead = agent === leadName;
    html += `<div class="header-cell" style="color:${color}">${esc(isLead ? "lead ★" : agent)}</div>`;
  }

  // One row per message/status event
  const rowEvents = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Track each agent's current status so every cell can be colored accordingly
  const agentStatus: Record<string, string> = {};
  for (const a of allAgents) agentStatus[a] = "ready";

  function cellBg(agent: string, overrideAlpha?: number): string {
    const s = agentStatus[agent] ?? "ready";
    if (s === "busy") return `rgba(239,68,68,${overrideAlpha ?? 0.15})`;
    if (s === "ready") return `rgba(34,197,94,${overrideAlpha ?? 0.08})`;
    if (s === "error") return `rgba(239,68,68,0.3)`;
    if (s === "shutdown") return `rgba(100,116,139,0.1)`;
    return "transparent";
  }

  for (const ev of rowEvents) {
    if (ev.type === "system") {
      html += `<div class="sys-row"><span style="margin-right:8px;opacity:0.5">${esc(fmtT(ev.timestamp))}</span>${esc(ev.content)}</div>`;
      continue;
    }

    if (ev.type === "status") {
      const name = ev.memberName ?? ev.sender;
      const lastWord = ev.content?.split(" ").pop() ?? "ready";
      agentStatus[name] = lastWord; // update before rendering so the cell shows new status
      const agentIdx = allAgents.indexOf(name);
      if (agentIdx < 0) continue;

      html += `<div class="row">`;
      html += `<div class="time-cell">${esc(fmtT(ev.timestamp))}</div>`;
      for (let i = 0; i < allAgents.length; i++) {
        const bg = cellBg(allAgents[i]);
        if (i === agentIdx) {
          // Show the transition bar on top of the cell background
          html += `<div class="agent-cell" style="background:${bg}"><div class="status-bar" style="background:${STATUS_COLORS[lastWord] ?? STATUS_COLORS.ready}"></div></div>`;
        } else {
          html += `<div class="agent-cell" style="background:${bg}"></div>`;
        }
      }
      html += `</div>`;
      continue;
    }

    // message
    const from = ev.sender === "__lead__"
      ? leadName
      : (ev.sender && !ev.sender.startsWith("ses_") ? ev.sender : (sessionMap.get(ev.senderId) ?? leadName));
    const mentions = ev.mentions ?? [];
    const toNames = mentions.length > 0 ? mentions.map((m) => m === "__lead__" ? leadName : m) : allAgents;
    const content = ev.content ?? "";
    const short = content.split("\n")[0].slice(0, 40);
    const fromColor = agentColorMap.get(from) ?? "#06b6d4";
    const fromIdx = allAgents.indexOf(from);
    const firstToIdx = toNames[0] ? allAgents.indexOf(toNames[0]) : -1;

    html += `<div class="row">`;
    html += `<div class="time-cell">${esc(fmtT(ev.timestamp))}</div>`;

    for (let ci = 0; ci < allAgents.length; ci++) {
      const agent = allAgents[ci];
      const isFrom = ci === fromIdx;
      const isTo = toNames.includes(agent) && ci !== fromIdx;
      const bg = cellBg(agent);

      if (isFrom) {
        const toLabel = toNames.map(esc).join(", ");
        html += `<div class="agent-cell" style="background:${bg};outline:1px solid ${fromColor}33">`;
        html += `<div class="msg-row" data-msg="${esc(content)}" data-from="${esc(from)}" data-to="${toLabel}" data-ts="${esc(fmtT(ev.timestamp))}">`;
        html += `<div class="msg-dot" style="background:${fromColor}"></div>`;
        if (firstToIdx > fromIdx) {
          html += `<div class="arrow-line" style="background:${fromColor}"></div>`;
          html += `<div class="arrow-head" style="color:${fromColor}">▶</div>`;
        } else if (firstToIdx < fromIdx && firstToIdx >= 0) {
          html += `<div class="arrow-head" style="color:${fromColor}">◀</div>`;
          html += `<div class="arrow-line" style="background:${fromColor}"></div>`;
        }
        html += `<div class="msg-text" title="${esc(content)}">${esc(short)}</div>`;
        html += `</div></div>`;
      } else if (isTo) {
        html += `<div class="agent-cell" style="background:${bg};outline:1px solid ${fromColor}22">`;
        html += `<div class="msg-recv">◀ ${esc(from === leadName ? "lead" : from)}</div>`;
        html += `</div>`;
      } else {
        html += `<div class="agent-cell" style="background:${bg}"></div>`;
      }
    }
    html += `</div>`;
  }

  html += `
</div>
<div class="tooltip" id="tooltip"></div>
<script>
document.querySelectorAll('.msg-row[data-msg]').forEach(el => {
  el.addEventListener('click', e => {
    const tip = document.getElementById('tooltip');
    const from = el.getAttribute('data-from') || '';
    const to = el.getAttribute('data-to') || '';
    const ts = el.getAttribute('data-ts') || '';
    const msg = el.getAttribute('data-msg') || '';
    tip.innerHTML = '<div class="ts">' + ts + '</div><div class="hdr">' + from + ' → ' + to + '</div><pre>' + msg.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</pre>';
    tip.classList.add('show');
    const rect = el.getBoundingClientRect();
    tip.style.left = Math.min(rect.left, window.innerWidth - 460) + 'px';
    tip.style.top = Math.min(rect.bottom + 8, window.innerHeight - 200) + 'px';
    e.stopPropagation();
  });
});
document.addEventListener('click', () => document.getElementById('tooltip').classList.remove('show'));
</script>
</div>
</body>
</html>`;

  writeFileSync(outputPath, html, "utf8");

  if (doOpen) {
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    Bun.spawn([openCmd, outputPath]);
  }
}

// ─── ANSI-safe width helpers ──────────────────────────────────────────────────

function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padToVis(s: string, n: number): string {
  const vl = visLen(s);
  return vl < n ? s + " ".repeat(n - vl) : s;
}

// ─── Config reload + file-tail helper (shared by all follow modes) ────────────

function reloadConfig() {
  if (!existsSync(configPath)) return;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as TeamConfig;
    sessionMap = buildSessionMap(config);
    bootstrapSessionMapFromEvents(sessionMap);
  } catch {}
}

function checkFileBytes(path: string, offset: number): [string[], number] {
  if (!existsSync(path)) return [[], offset];
  const buf = readFileSync(path);
  if (buf.length <= offset) return [[], offset];
  const lines = buf.slice(offset).toString("utf8").split("\n").filter(Boolean);
  return [lines, buf.length];
}

// ─── Header (linear mode) ─────────────────────────────────────────────────────

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
  console.log(DIM(`  ${eventsPath}${follow ? "  (following)" : ""}${showDebug ? "  +debug" : ""}`));
  console.log(DIM("  ─".repeat(40)));
  console.log();
}

// ─── Main render ──────────────────────────────────────────────────────────────

const evLines = readLines(eventsPath);
const dbgLines = showDebug ? readLines(debugPath) : [];

function parseEvents(lines: string[]): Event[] {
  const out: Event[] = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line) as Event); } catch {}
  }
  return out;
}

// ── HTML mode ─────────────────────────────────────────────────────────────────

if (generateHtml) {
  const outputPath = join(teamDir, "report.html");
  const memberNames = config ? Object.keys(config.members) : [];

  function writeReport() {
    const events = parseEvents(readLines(eventsPath));
    generateHtmlReport(teamName, events, memberNames, "__lead__", outputPath, false, follow);
  }

  writeReport();
  if (autoOpen) {
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    Bun.spawn([openCmd, outputPath]);
  }
  console.log(`Written: ${outputPath}`);
  if (!follow) process.exit(0);

  // Follow: regenerate the file when new events arrive
  let evOff = readFileSync(eventsPath).length;
  setInterval(() => {
    reloadConfig();
    const [, newOff] = checkFileBytes(eventsPath, evOff);
    if (newOff > evOff) {
      evOff = newOff;
      writeReport();
    }
  }, 1000);
}

// ── Lanes mode ────────────────────────────────────────────────────────────────

else if (showLanes) {
  const memberNames = config ? Object.keys(config.members) : [];
  const allAgents = ["__lead__", ...memberNames];

  function dispName(name: string): string {
    return name === "__lead__" ? "lead" : name;
  }

  const termWidth = (process.stdout as { columns?: number }).columns ?? 200;
  const TIME_W = 9;
  const colW = Math.max(12, allAgents.reduce((m, a) => Math.max(m, dispName(a).length), 0) + 2);
  const maxAgents = Math.min(allAgents.length, Math.floor((termWidth - TIME_W - 1) / colW));
  const visAgents = allAgents.slice(0, maxAgents);
  const hiddenCount = allAgents.length - maxAgents;

  function printLanesHeader(): void {
    const t = padToVis(DIM("TIME"), TIME_W) + " ";
    const cols = visAgents.map((a) => padToVis(paint(a, dispName(a)), colW)).join("");
    console.log(t + cols + (hiddenCount > 0 ? DIM(` +${hiddenCount} more`) : ""));
    console.log(DIM("─".repeat(TIME_W + 1 + visAgents.length * colW)));
  }

  // Each cell: plain text + optional ANSI color applied at render time,
  // so padToVis always measures the correct visual width.
  type Cell = { text: string; color?: string };

  function flushLanesRow(timeStr: string, cells: Cell[]): void {
    const t = padToVis(DIM(timeStr), TIME_W) + " ";
    const parts = cells.map(({ text, color }) => {
      const truncated = text.length > colW - 1 ? text.slice(0, colW - 2) + "…" : text;
      const styled = color ? `${color}${truncated}${R}` : DIM(truncated);
      return padToVis(styled, colW);
    });
    let row = t + parts.join("");
    if (hiddenCount > 0) row += DIM(` +${hiddenCount}`);
    console.log(row);
  }

  // Render a batch of events that share the same second.
  // Status updates are merged into one row; messages each get their own row.
  function renderSecond(sec: string, evs: Event[], firstInOutput: boolean): void {
    const statusEvs = evs.filter((e) => e.type === "status" && afterSince(e.timestamp));
    const msgEvs = evs.filter((e) => e.type === "message" && afterSince(e.timestamp));

    // One combined row for all status changes this second
    if (statusEvs.length > 0) {
      const cells: Cell[] = visAgents.map(() => ({ text: "" }));
      for (const ev of statusEvs) {
        const name = ev.memberName ?? resolveSender(ev.sender, ev.senderId);
        const idx = visAgents.indexOf(name);
        if (idx < 0) continue;
        const isBusy = ev.content?.split(" ").pop() === "busy";
        cells[idx] = { text: isBusy ? "● busy" : "● ready", color: isBusy ? "\x1b[33m" : "\x1b[32m" };
      }
      flushLanesRow(sec, cells);
    }

    // One row per message (no bridge dashes — just arrow in from-cell, snippet in to-cell)
    for (let i = 0; i < msgEvs.length; i++) {
      const ev = msgEvs[i];
      const timeStr = i === 0 && statusEvs.length === 0 ? sec : "─".repeat(TIME_W);
      const from = resolveSender(ev.sender, ev.senderId);
      const mentions = ev.mentions ?? [];
      const recipients = mentions.length > 0 ? mentions : visAgents.filter((a) => a !== from);
      const content = (ev.content ?? "").split("\n")[0];

      const fromIdx = visAgents.indexOf(from);
      const toIdxs = recipients.map((r) => visAgents.indexOf(r)).filter((i) => i >= 0 && i !== fromIdx);
      if (fromIdx < 0 || toIdxs.length === 0) continue;

      const cells: Cell[] = visAgents.map(() => ({ text: "" }));
      cells[fromIdx] = { text: "→" + toIdxs.map((i) => dispName(visAgents[i])).join(","), color: colorFor(from) };
      const snip = colW - 3;
      for (const ti of toIdxs) {
        cells[ti] = { text: `"${content.slice(0, snip)}${content.length > snip ? "…" : ""}"` };
      }
      flushLanesRow(timeStr, cells);
    }
  }

  function renderLanesBatch(events: Event[]): void {
    // Group by second, preserving order
    const bySecond = new Map<string, Event[]>();
    for (const ev of events) {
      const sec = fmtTime(ev.timestamp);
      if (!bySecond.has(sec)) bySecond.set(sec, []);
      bySecond.get(sec)!.push(ev);
    }
    let first = true;
    for (const [sec, evs] of bySecond) {
      renderSecond(sec, evs, first);
      first = false;
    }
  }

  printLanesHeader();
  renderLanesBatch(parseEvents(evLines).filter((e) => e.type === "status" || e.type === "message"));
  if (!follow) process.exit(0);

  let evOff = readFileSync(eventsPath).length;
  setInterval(() => {
    reloadConfig();
    const [newLines, newOff] = checkFileBytes(eventsPath, evOff);
    evOff = newOff;
    const newEvs = newLines.flatMap((line) => {
      try { return [JSON.parse(line) as Event]; } catch { return []; }
    }).filter((e) => e.type === "status" || e.type === "message");
    if (newEvs.length > 0) renderLanesBatch(newEvs);
  }, 500);
}

// ── Linear mode (default) ─────────────────────────────────────────────────────

else {
  const timeline = buildTimeline(evLines, dbgLines);

  printHeader();

  let rendered = 0;
  for (const item of timeline) {
    const out = item.render();
    if (out) { console.log(out); rendered++; }
  }

  if (rendered === 0) console.log(DIM("  (no events to show)"));
  if (!follow) { console.log(); process.exit(0); }

  console.log();
  console.log(DIM("  ── live ──"));
  console.log();

  let evOff = readFileSync(eventsPath).length;
  let dbgOff = existsSync(debugPath) ? readFileSync(debugPath).length : 0;

  setInterval(() => {
    reloadConfig();
    const [newEvLines, newEvOff] = checkFileBytes(eventsPath, evOff);
    evOff = newEvOff;
    const [newDbgLines, newDbgOff] = checkFileBytes(debugPath, dbgOff);
    dbgOff = newDbgOff;
    const newItems = buildTimeline(newEvLines, showDebug ? newDbgLines : []);
    for (const item of newItems) {
      const out = item.render();
      if (out) console.log(out);
    }
  }, 500);
}
