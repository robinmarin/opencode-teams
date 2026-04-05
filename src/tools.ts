import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  appendEvent,
  claimTask,
  completeTask,
  findTeamBySession,
  getEvents,
  pruneEvents,
  readTeam,
  updateMember,
  writeTeam,
} from "./state.js";

// Use the plugin's bundled Zod instance to avoid version mismatch
const z = tool.schema;

// Re-export the client type for convenience
type Client = PluginInput["client"];

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

        // SDK audit: @opencode-ai/sdk exposes no silent system-prompt injection
        // (no appendSystem / updateSystem / systemPrompt field on session). The
        // behavioural framing is therefore sent as a visible promptAsync message
        // to the lead's own session. This is acceptable — it frames the lead's
        // role at team creation time and appears once in their chat history.
        const leadBehaviourMsg = [
          `[Team Protocol]: You are the lead of an agent team. Your role is to delegate work and synthesise results — not to micromanage. Follow these rules strictly:`,
          ``,
          `When you spawn a teammate, trust them to complete their task. Do not message them again unless you have new specific instructions that change their task.`,
          `When you receive an idle notification for a teammate, acknowledge it internally and wait. Do not call team_message or team_broadcast in response to an idle notification unless the task genuinely requires new input.`,
          `Never send check-in messages like "how is it going?" or "any updates?". Teammates will notify you when they are done.`,
          `Your job is to wait for results, synthesise them, and decide on next steps — not to fill silence with coordination overhead.`,
          `If all teammates are busy, do nothing. Wait.`,
        ].join("\n");
        try {
          await client.session.promptAsync({
            path: { id: context.sessionID },
            body: {
              parts: [{ type: "text" as const, text: leadBehaviourMsg }],
            },
          });
        } catch (behaviorErr) {
          console.warn(
            "[team_create] failed to send lead behavioural prompt (non-fatal):",
            behaviorErr,
          );
        }

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
    async execute(args, _context) {
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

        // Known limitation: @opencode-ai/sdk session.create() only accepts
        // { parentID, title } in its body — there is no deny list or permissions
        // field. Sub-agent tool isolation is therefore instruction-only. A
        // future SDK version may expose a deny list; at that point add explicit
        // deny rules for all six team tools here for defence in depth.
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

        // Write member into team state BEFORE firing the prompt so that state
        // is always consistent — a live session always has a state record.
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

        // Fire initial prompt; if it throws, mark the member as error so
        // callers know the session is in an unknown state.
        try {
          await client.session.promptAsync({
            path: { id: sessionId },
            body: {
              parts: [{ type: "text" as const, text: args.initialPrompt }],
              system: systemPrompt,
              ...(modelOpt !== undefined ? { model: modelOpt } : {}),
            },
          });
        } catch (promptErr) {
          console.error("[team_spawn] promptAsync failed:", promptErr);
          try {
            await updateMember(args.teamName, args.memberName, {
              status: "error",
            });
          } catch (updateErr) {
            console.error(
              "[team_spawn] failed to update member status to error:",
              updateErr,
            );
          }
          return `Error sending initial prompt to member "${args.memberName}": ${String(promptErr)}`;
        }

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
        await client.session.promptAsync({
          path: { id: targetSessionId },
          body: { parts: [{ type: "text" as const, text: prefixedMessage }] },
        });

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
            await client.session.promptAsync({
              path: { id: member.sessionId },
              body: {
                parts: [{ type: "text" as const, text: prefixedMessage }],
              },
            });
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
          `Tasks: pending=${tasksByStatus.pending ?? 0} in_progress=${tasksByStatus.in_progress ?? 0} completed=${tasksByStatus.completed ?? 0} blocked=${tasksByStatus.blocked ?? 0}`,
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
            await client.session.promptAsync({
              path: { id: target.sessionId },
              body: { parts: [{ type: "text" as const, text: shutdownMsg }] },
            });
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

  // ---------------------------------------------------------------------------
  // team_task_add
  // ---------------------------------------------------------------------------
  const team_task_add = tool({
    description: "Add a task to the team's task board.",
    args: {
      teamName: z.string().describe("Name of the team"),
      title: z.string().describe("Short title for the task"),
      description: z.string().describe("Full description of the task"),
      assignee: z
        .string()
        .optional()
        .describe("Name of the member to assign the task to (optional)"),
      dependsOn: z
        .array(z.string())
        .optional()
        .describe("Task IDs this task is blocked by (optional)"),
    },
    async execute(args, _context) {
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }
        const taskId = `task_${Date.now()}`;
        const now = new Date().toISOString();
        await writeTeam({
          ...team,
          tasks: {
            ...team.tasks,
            [taskId]: {
              id: taskId,
              title: args.title,
              description: args.description,
              status: "pending",
              assignee: args.assignee ?? null,
              dependsOn: args.dependsOn ?? [],
              createdAt: now,
            },
          },
        });
        return `Task "${args.title}" added with ID: ${taskId}.`;
      } catch (err) {
        console.error("[team_task_add] error:", err);
        return `Error adding task: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_task_claim
  // ---------------------------------------------------------------------------
  const team_task_claim = tool({
    description:
      "Claim a pending task, marking it as in_progress. Fails if the task has incomplete dependencies.",
    args: {
      teamName: z.string().describe("Name of the team"),
      taskId: z.string().describe("ID of the task to claim"),
    },
    async execute(args, context) {
      try {
        const found = await findTeamBySession(context.sessionID);
        const memberName =
          found !== null && found.memberName !== "__lead__"
            ? found.memberName
            : context.sessionID;

        const result = await claimTask(args.teamName, args.taskId, memberName);
        if (!result.ok) {
          return `Error: ${result.reason}`;
        }
        return `Task "${args.taskId}" claimed by "${memberName}" and is now in_progress.`;
      } catch (err) {
        console.error("[team_task_claim] error:", err);
        return `Error claiming task: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_task_done
  // ---------------------------------------------------------------------------
  const team_task_done = tool({
    description:
      "Mark a task as completed and report any newly unblocked tasks.",
    args: {
      teamName: z.string().describe("Name of the team"),
      taskId: z.string().describe("ID of the task to mark as completed"),
    },
    async execute(args, _context) {
      try {
        const result = await completeTask(args.teamName, args.taskId);
        if (!result.ok) {
          return `Error: ${result.reason}`;
        }
        const unblockedMsg =
          result.unblockedTaskIds.length > 0
            ? ` Newly unblocked: ${result.unblockedTaskIds.join(", ")}.`
            : "";
        return `Task "${args.taskId}" marked as completed.${unblockedMsg}`;
      } catch (err) {
        console.error("[team_task_done] error:", err);
        return `Error completing task: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_post
  // ---------------------------------------------------------------------------
  const VALID_REACTIONS = [
    "+1",
    "-1",
    "eyes",
    "rocket",
    "white_check_mark",
  ] as const;
  type Reaction = (typeof VALID_REACTIONS)[number];

  function isValidReaction(r: string): r is Reaction {
    return (VALID_REACTIONS as readonly string[]).includes(r);
  }

  const team_post = tool({
    description:
      "Post a message to the team's general channel. Supports @mentions to notify specific members.",
    args: {
      teamName: z.string().describe("Name of the team"),
      message: z.string().describe("Message to post to the channel"),
      mentions: z
        .array(z.string())
        .optional()
        .describe("Member names to @mention in this message"),
    },
    async execute(args, context) {
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        const senderInfo = await findTeamBySession(context.sessionID);
        const senderName =
          senderInfo !== null ? senderInfo.memberName : "unknown";
        const senderId = context.sessionID;

        const validatedMentions: string[] = [];
        if (args.mentions) {
          for (const m of args.mentions) {
            if (team.members[m] !== undefined) {
              validatedMentions.push(m);
            }
          }
        }

        const event = await appendEvent(args.teamName, {
          type: "message",
          sender: senderName,
          senderId,
          content: args.message,
          ...(validatedMentions.length > 0
            ? { mentions: validatedMentions }
            : {}),
        });

        for (const mentioned of validatedMentions) {
          const member = team.members[mentioned];
          if (
            member &&
            member.status !== "shutdown" &&
            member.status !== "shutdown_requested"
          ) {
            try {
              await client.session.promptAsync({
                path: { id: member.sessionId },
                body: {
                  parts: [
                    {
                      type: "text" as const,
                      text: `[@mention from ${senderName}]: ${args.message}`,
                    },
                  ],
                },
              });
            } catch (err) {
              console.error(
                `[team_post] failed to notify mentioned member ${mentioned}:`,
                err,
              );
            }
          }
        }

        return `Posted to channel: ${event.id}`;
      } catch (err) {
        console.error("[team_post] error:", err);
        return `Error posting message: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_history
  // ---------------------------------------------------------------------------
  const team_history = tool({
    description: "Read recent messages from the team's channel history.",
    args: {
      teamName: z.string().describe("Name of the team"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Number of recent messages to retrieve (default: 50)"),
    },
    async execute(args, _context) {
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        const { events } = await getEvents(args.teamName, args.limit);
        if (events.length === 0) {
          return "No channel messages yet.";
        }

        const lines = events.map(
          (e) => `[${e.timestamp}] ${e.sender}: ${e.content}`,
        );
        return ["Channel history:", ...lines].join("\n");
      } catch (err) {
        console.error("[team_history] error:", err);
        return `Error fetching history: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_announce
  // ---------------------------------------------------------------------------
  const team_announce = tool({
    description:
      "Broadcast a message to all active team members INCLUDING the sender. Useful for status updates.",
    args: {
      teamName: z.string().describe("Name of the team"),
      message: z.string().describe("Message to announce to all members"),
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
        const senderId = context.sessionID;

        await appendEvent(args.teamName, {
          type: "message",
          sender: senderName,
          senderId,
          content: `[ANNOUNCEMENT] ${args.message}`,
        });

        const messaged: string[] = [];
        for (const [memberName, member] of Object.entries(team.members)) {
          if (member.status !== "ready" && member.status !== "busy") {
            continue;
          }
          try {
            await client.session.promptAsync({
              path: { id: member.sessionId },
              body: {
                parts: [
                  {
                    type: "text" as const,
                    text: `[Announcement from ${senderName}]: ${args.message}`,
                  },
                ],
              },
            });
            messaged.push(memberName);
          } catch (err) {
            console.error(
              `[team_announce] failed to message ${memberName}:`,
              err,
            );
          }
        }

        return `Announcement sent to: ${messaged.join(", ")} (including sender).`;
      } catch (err) {
        console.error("[team_announce] error:", err);
        return `Error sending announcement: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_react
  // ---------------------------------------------------------------------------
  const team_react = tool({
    description: "Add a reaction to a channel message by its event ID.",
    args: {
      teamName: z.string().describe("Name of the team"),
      messageId: z.string().describe("ID of the message to react to"),
      reaction: z
        .string()
        .describe(
          `Reaction emoji (shortcode). Valid: ${VALID_REACTIONS.join(", ")}`,
        ),
    },
    async execute(args, context) {
      try {
        if (!isValidReaction(args.reaction)) {
          return `Error: Invalid reaction "${args.reaction}". Valid: ${VALID_REACTIONS.join(", ")}`;
        }

        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        const senderInfo = await findTeamBySession(context.sessionID);
        const senderName =
          senderInfo !== null ? senderInfo.memberName : context.sessionID;
        const senderId = context.sessionID;

        const event = await appendEvent(args.teamName, {
          type: "reaction",
          sender: senderName,
          senderId,
          content: `reacted with ${args.reaction}`,
          targetId: args.messageId,
          reaction: args.reaction,
        });

        return `Reaction ${args.reaction} added to ${args.messageId}: ${event.id}`;
      } catch (err) {
        console.error("[team_react] error:", err);
        return `Error adding reaction: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_prune
  // ---------------------------------------------------------------------------
  const team_prune = tool({
    description:
      "Compact the events log, keeping only the most recent N entries. Use to prevent unbounded file growth.",
    args: {
      teamName: z.string().describe("Name of the team"),
      keep: z
        .number()
        .optional()
        .default(1000)
        .describe("Number of recent events to keep (default: 1000)"),
    },
    async execute(args, _context) {
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        const { pruned, remaining } = await pruneEvents(
          args.teamName,
          args.keep,
        );
        return `Pruned ${pruned} events. ${remaining} events remaining.`;
      } catch (err) {
        console.error("[team_prune] error:", err);
        return `Error pruning events: ${String(err)}`;
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
    team_task_add,
    team_task_claim,
    team_task_done,
    team_post,
    team_history,
    team_announce,
    team_react,
    team_prune,
  };
}

// ---------------------------------------------------------------------------
// Factory — call this at plugin init with the live client
// ---------------------------------------------------------------------------

export function createTools(client: Client): Record<string, ToolDefinition> {
  return makeTools(client);
}
