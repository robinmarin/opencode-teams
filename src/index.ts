import * as path from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { createFileSink, createLogger, type Logger } from "./logger.js";
import { createEventHandler } from "./messaging.js";
import { listTeams, teamDir } from "./state.js";
import { createTools } from "./tools.js";

const teamLoggers = new Map<string, Logger>();

async function initTeamLoggers(client: Parameters<Plugin>[0]["client"]) {
  const names = await listTeams();
  await Promise.allSettled(
    names.map(async (teamName) => {
      try {
        const logPath = path.join(teamDir(teamName), "logs", "debug.jsonl");
        const logger = createLogger(client, {
          teamName,
          minLevel: "debug",
        });
        const fileSink = createFileSink(teamName, logPath);
        logger.addDestination(fileSink);
        teamLoggers.set(teamName, logger);
      } catch (err) {
        console.error(
          `[opencode-teams] failed to init logger for team "${teamName}":`,
          err,
        );
      }
    }),
  );
}

export function getTeamLogger(teamName: string): Logger | undefined {
  return teamLoggers.get(teamName);
}

export function getOrCreateTeamLogger(
  client: Parameters<Plugin>[0]["client"],
  teamName: string,
): Logger {
  let logger = teamLoggers.get(teamName);
  if (logger !== undefined) return logger;
  const logPath = path.join(teamDir(teamName), "logs", "debug.jsonl");
  logger = createLogger(client, { teamName, minLevel: "debug" });
  logger.addDestination(createFileSink(teamName, logPath));
  teamLoggers.set(teamName, logger);
  return logger;
}

const TeamPlugin: Plugin = async ({ client }) => {
  initTeamLoggers(client);
  return {
    event: createEventHandler(client, getOrCreateTeamLogger),
    tool: createTools(client, getOrCreateTeamLogger),
  };
};

export const server = TeamPlugin;
export default TeamPlugin;
