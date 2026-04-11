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
 *
 * Defaults to the most recently modified team if no name given.
 */

import { readFileSync, existsSync, statSync, readdirSync } from "fs";
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

// Reload config periodically so new members are mapped correctly
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
