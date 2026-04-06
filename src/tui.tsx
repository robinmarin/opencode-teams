/** @jsxImportSource @opentui/solid */

import * as fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TuiPlugin, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import { createSignal } from "solid-js";
import type { MemberStatus, TeamConfig, TeamMember } from "./state.js";

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

async function loadAllTeams(teamsDir: string): Promise<TeamConfig[]> {
  const result: TeamConfig[] = [];
  try {
    const entries = await readdir(teamsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = JSON.parse(
          await readFile(
            path.join(teamsDir, entry.name, "config.json"),
            "utf8",
          ),
        );
        result.push(raw as TeamConfig);
      } catch {
        // skip unreadable or missing config
      }
    }
  } catch {
    // directory doesn't exist yet — no teams
  }
  return result;
}

// ---------------------------------------------------------------------------
// Theme helpers
// ---------------------------------------------------------------------------

function statusFg(status: MemberStatus, theme: TuiThemeCurrent) {
  if (status === "ready") return theme.success;
  if (status === "busy") return theme.warning;
  if (status === "error") return theme.error;
  return theme.textMuted;
}

// ---------------------------------------------------------------------------
// SolidJS components
// ---------------------------------------------------------------------------

function MemberRow(props: { member: TeamMember; theme: TuiThemeCurrent }) {
  const nameCol = props.member.name.padEnd(18);
  const statusTag = `[${props.member.status}]`;
  return (
    <box flexDirection="row">
      <text fg={props.theme.text}>{nameCol}</text>
      <text fg={statusFg(props.member.status, props.theme)}>{statusTag}</text>
    </box>
  );
}

function TeamPanel(props: { team: TeamConfig; theme: TuiThemeCurrent }) {
  const members = Object.values(props.team.members);
  const tasks = Object.values(props.team.tasks);
  const doneCount = tasks.filter((t) => t.status === "completed").length;
  const sep = "─".repeat(32);

  return (
    <box flexDirection="column">
      <text fg={props.theme.accent}>{` Team: ${props.team.name}`}</text>
      <text fg={props.theme.border}>{sep}</text>
      {members.map((m) => (
        <MemberRow member={m} theme={props.theme} />
      ))}
      {tasks.length > 0 && (
        <box flexDirection="column">
          <text fg={props.theme.border}>{sep}</text>
          <text
            fg={props.theme.textMuted}
          >{` Tasks: ${doneCount}/${tasks.length} done`}</text>
        </box>
      )}
    </box>
  );
}

function TeamBadge(props: { team: TeamConfig; theme: TuiThemeCurrent }) {
  const members = Object.values(props.team.members);
  const working = members.filter((m) => m.status === "busy").length;
  const idle = members.filter((m) => m.status === "ready").length;
  const parts: string[] = [];
  if (working > 0) parts.push(`${working} working`);
  if (idle > 0) parts.push(`${idle} idle`);
  if (parts.length === 0) return null;
  return <text fg={props.theme.textMuted}>{` ${parts.join(" / ")} `}</text>;
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const tui: TuiPlugin = async (api) => {
  const teamsDir = path.join(os.homedir(), ".config", "opencode", "teams");
  const [teams, setTeams] = createSignal<TeamConfig[]>([]);
  const [visible, setVisible] = createSignal(true);

  const reload = () => void loadAllTeams(teamsDir).then((t) => setTeams(t));

  // Initial load
  reload();

  // Watch for file-system changes — prefer this over polling
  let watcher: fs.FSWatcher | undefined;
  try {
    fs.mkdirSync(teamsDir, { recursive: true });
    watcher = fs.watch(teamsDir, { recursive: true }, reload);
    api.lifecycle.onDispose(() => watcher?.close());
  } catch {
    // recursive watch not supported on this platform — events cover updates
  }

  // Refresh on session state transitions
  const unsubIdle = api.event.on("session.idle", reload);
  const unsubStatus = api.event.on("session.status", reload);
  api.lifecycle.onDispose(unsubIdle);
  api.lifecycle.onDispose(unsubStatus);

  // Toggle command
  const unregisterCommand = api.command.register(() => [
    {
      title: "Toggle team status",
      value: "team.status.toggle",
      description: "Show or hide the live team member status panel",
      category: "Teams",
      keybind: "ctrl+t",
      onSelect: () => setVisible((v) => !v),
    },
  ]);
  api.lifecycle.onDispose(unregisterCommand);

  // Slot renderers — sidebar_content for the full panel, session_prompt_right
  // for the compact badge shown next to the prompt bar
  api.slots.register({
    slots: {
      sidebar_content: (ctx, props) => {
        if (!visible()) return null;
        const team = teams().find((t) => t.leadSessionId === props.session_id);
        if (!team) return null;
        return <TeamPanel team={team} theme={ctx.theme.current} />;
      },
      session_prompt_right: (ctx, props) => {
        const team = teams().find((t) => t.leadSessionId === props.session_id);
        if (!team) return null;
        return <TeamBadge team={team} theme={ctx.theme.current} />;
      },
    },
  });
};
