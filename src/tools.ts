import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type {
  AgentPartInput,
  FilePartInput,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk";
import {
  findTeamBySession,
  readTeam,
  updateMember,
  writeTeam,
} from "./state.js";

// Use the plugin's bundled Zod instance to avoid version mismatch
const z = tool.schema;

// Re-export the client type for convenience
type Client = PluginInput["client"];

type PromptPart =
  | TextPartInput
  | FilePartInput
  | AgentPartInput
  | SubtaskPartInput;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sendAsync(
  client: Client,
  sessionId: string,
  text: string,
  system?: string,
  model?: { providerID: string; modelID: string },
): Promise<void> {
  const parts: PromptPart[] = [{ type: "text", text }];
  await client.session.promptAsync({
    path: { id: sessionId },
    body: {
      parts,
      ...(system !== undefined ? { system } : {}),
      ...(model !== undefined ? { model } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// tool definitions
// ---------------------------------------------------------------------------

function makeTools(client: Client): Record<string, ToolDefinition> {
  // ---------------------------------------------------------------------------
  // team_create
  // ---------------------------------------------------------------------------
  const team_create = tool({
    description:
      "Create a new agent team. The calling session becomes the team lead.",
    args: {
      name: z.string().describe("Unique team name"),
      description: z.string().optional().describe("Optional team description"),
    },
    async execute(args, context) {
      try {
        const existing = await readTeam(args.name);
        if (existing !== null) {
          return `Error: Team "${args.name}" already exists.`;
        }
        await writeTeam({
          name: args.name,
          leadSessionId: context.sessionID,
          members: {},
          tasks: {},
          createdAt: new Date().toISOString(),
        });
        return `Team "${args.name}" created. You are the lead (session: ${context.sessionID}).`;
      } catch (err) {
        console.error("[team_create] error:", err);
        return `Error creating team: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_spawn
  // ---------------------------------------------------------------------------
  const team_spawn = tool({
    description:
      "Spawn a new sub-agent session as a team member with a specific role.",
    args: {
      teamName: z.string().describe("Name of the team to add the member to"),
      memberName: z.string().describe("Unique name for this team member"),
      role: z
        .string()
        .describe(
          "Role description for this member (e.g. 'backend engineer', 'code reviewer')",
        ),
      initialPrompt: z
        .string()
        .describe("Initial task or instructions to send to the member"),
      model: z
        .string()
        .optional()
        .describe(
          "Model override (e.g. 'anthropic/claude-haiku-4-5'). Defaults to session model.",
        ),
    },
    async execute(args, context) {
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" does not exist. Create it first with team_create.`;
        }
        if (team.members[args.memberName] !== undefined) {
          return `Error: Member "${args.memberName}" already exists in team "${args.teamName}".`;
        }

        // Create the new session
        const createResult = await client.session.create({
          body: { title: `[${args.teamName}] ${args.memberName}` },
        });
        if (createResult.error !== undefined) {
          return `Error creating session for member: ${JSON.stringify(createResult.error)}`;
        }
        const sessionId = createResult.data.id;

        // Build system prompt for member isolation
        const systemPrompt = [
          `You are "${args.memberName}", a ${args.role} on team "${args.teamName}".`,
          `Your lead session ID is: ${team.leadSessionId}.`,
          `You were spawned to work on specific tasks. Complete them thoroughly.`,
          `IMPORTANT: You must NOT use team management tools (team_create, team_spawn, team_message, team_broadcast, team_status, team_shutdown). These tools are reserved for the team lead only.`,
          `When you complete a task, summarize your results clearly so the lead can review them.`,
        ].join("\n");

        // Parse optional model selector
        let modelOpt: { providerID: string; modelID: string } | undefined;
        if (typeof args.model === "string") {
          const slashIdx = args.model.indexOf("/");
          if (slashIdx !== -1) {
            modelOpt = {
              providerID: args.model.slice(0, slashIdx),
              modelID: args.model.slice(slashIdx + 1),
            };
          }
        }

        // Fire-and-forget initial prompt
        await sendAsync(
          client,
          sessionId,
          args.initialPrompt,
          systemPrompt,
          modelOpt,
        );

        // Write member into team state
        const now = new Date().toISOString();
        await writeTeam({
          ...team,
          members: {
            ...team.members,
            [args.memberName]: {
              name: args.memberName,
              sessionId,
              status: "busy",
              agentType: "default",
              model: args.model ?? "default",
              spawnedAt: now,
            },
          },
        });

        return `Member "${args.memberName}" spawned (session: ${sessionId}). Initial prompt sent.`;
      } catch (err) {
        console.error("[team_spawn] error:", err);
        return `Error spawning member: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_message
  // ---------------------------------------------------------------------------
  const team_message = tool({
    description: "Send a message to a specific team member or the team lead.",
    args: {
      teamName: z.string().describe("Name of the team"),
      to: z.string().describe("Recipient: member name or 'lead'"),
      message: z.string().describe("Message to send"),
    },
    async execute(args, context) {
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        // Determine sender name
        const senderInfo = await findTeamBySession(context.sessionID);
        const senderName =
          senderInfo !== null ? senderInfo.memberName : context.sessionID;

        // Resolve target session ID
        let targetSessionId: string;
        if (args.to === "lead") {
          targetSessionId = team.leadSessionId;
        } else {
          const member = team.members[args.to];
          if (member === undefined) {
            return `Error: Member "${args.to}" not found in team "${args.teamName}".`;
          }
          if (
            member.status === "shutdown" ||
            member.status === "shutdown_requested"
          ) {
            return `Error: Member "${args.to}" is in shutdown state and cannot receive messages.`;
          }
          targetSessionId = member.sessionId;
        }

        const prefixedMessage = `[Team message from ${senderName}]: ${args.message}`;
        await sendAsync(
          client,
          targetSessionId,
          prefixedMessage,
          undefined,
          undefined,
        );

        return `Message sent to "${args.to}".`;
      } catch (err) {
        console.error("[team_message] error:", err);
        return `Error sending message: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_broadcast
  // ---------------------------------------------------------------------------
  const team_broadcast = tool({
    description:
      "Broadcast a message to all active team members (status: ready or busy), excluding the sender.",
    args: {
      teamName: z.string().describe("Name of the team"),
      message: z
        .string()
        .describe("Message to broadcast to all active members"),
    },
    async execute(args, context) {
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        const senderInfo = await findTeamBySession(context.sessionID);
        const senderName =
          senderInfo !== null ? senderInfo.memberName : context.sessionID;

        const prefixedMessage = `[Team broadcast from ${senderName}]: ${args.message}`;
        const messaged: string[] = [];

        for (const [memberName, member] of Object.entries(team.members)) {
          if (member.sessionId === context.sessionID) continue; // skip sender
          if (member.status !== "ready" && member.status !== "busy") {
            continue;
          }
          try {
            await sendAsync(
              client,
              member.sessionId,
              prefixedMessage,
              undefined,
              undefined,
            );
            messaged.push(memberName);
          } catch (err) {
            console.error(
              `[team_broadcast] failed to message ${memberName}:`,
              err,
            );
          }
        }

        if (messaged.length === 0) {
          return `Broadcast sent to no members (no active members found excluding sender).`;
        }
        return `Broadcast sent to: ${messaged.join(", ")}.`;
      } catch (err) {
        console.error("[team_broadcast] error:", err);
        return `Error broadcasting: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_status
  // ---------------------------------------------------------------------------
  const team_status = tool({
    description:
      "Get the current status of a team: members, their statuses, and task counts.",
    args: {
      teamName: z.string().describe("Name of the team"),
    },
    async execute(args, _context) {
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        const memberLines = Object.values(team.members).map(
          (m) =>
            `  - ${m.name} [${m.status}] session=${m.sessionId} model=${m.model} spawned=${m.spawnedAt}`,
        );

        const tasksByStatus: Record<string, number> = {
          pending: 0,
          in_progress: 0,
          completed: 0,
          blocked: 0,
        };
        for (const task of Object.values(team.tasks)) {
          tasksByStatus[task.status] = (tasksByStatus[task.status] ?? 0) + 1;
        }

        const lines = [
          `Team: ${team.name}`,
          `Lead session: ${team.leadSessionId}`,
          `Created: ${team.createdAt}`,
          ``,
          `Members (${Object.keys(team.members).length}):`,
          ...memberLines,
          ``,
          `Tasks: pending=${tasksByStatus["pending"] ?? 0} in_progress=${tasksByStatus["in_progress"] ?? 0} completed=${tasksByStatus["completed"] ?? 0} blocked=${tasksByStatus["blocked"] ?? 0}`,
        ];

        return lines.join("\n");
      } catch (err) {
        console.error("[team_status] error:", err);
        return `Error getting status: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_shutdown
  // ---------------------------------------------------------------------------
  const team_shutdown = tool({
    description:
      "Shut down one or all team members by sending them a shutdown message.",
    args: {
      teamName: z.string().describe("Name of the team"),
      memberName: z
        .string()
        .optional()
        .describe("Member to shut down. Omit to shut down all active members."),
    },
    async execute(args, _context) {
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        const shutdownMsg =
          "[System]: You are being shut down. Complete your current thought and stop.";

        const targets: Array<{ name: string; sessionId: string }> = [];

        if (typeof args.memberName === "string") {
          const member = team.members[args.memberName];
          if (member === undefined) {
            return `Error: Member "${args.memberName}" not found in team "${args.teamName}".`;
          }
          targets.push({ name: args.memberName, sessionId: member.sessionId });
        } else {
          for (const [name, member] of Object.entries(team.members)) {
            if (member.status === "ready" || member.status === "busy") {
              targets.push({ name, sessionId: member.sessionId });
            }
          }
        }

        const shut: string[] = [];
        for (const target of targets) {
          try {
            await sendAsync(
              client,
              target.sessionId,
              shutdownMsg,
              undefined,
              undefined,
            );
            await updateMember(args.teamName, target.name, {
              status: "shutdown_requested",
            });
            shut.push(target.name);
          } catch (err) {
            console.error(`[team_shutdown] failed for ${target.name}:`, err);
          }
        }

        if (shut.length === 0) {
          return `No members were shut down (no active members found).`;
        }
        return `Shutdown requested for: ${shut.join(", ")}.`;
      } catch (err) {
        console.error("[team_shutdown] error:", err);
        return `Error shutting down: ${String(err)}`;
      }
    },
  });

  return {
    team_create,
    team_spawn,
    team_message,
    team_broadcast,
    team_status,
    team_shutdown,
  };
}

// ---------------------------------------------------------------------------
// Factory — call this at plugin init with the live client
// ---------------------------------------------------------------------------

export function createTools(client: Client): Record<string, ToolDefinition> {
  return makeTools(client);
}
