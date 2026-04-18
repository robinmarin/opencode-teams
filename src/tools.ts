import * as fs from "node:fs/promises";
import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { Logger } from "./logger.js";
import {
  appendBulletinPost,
  appendEvent,
  claimTask,
  completeTask,
  findTeamBySession,
  getEvents,
  isMemberActive,
  isMemberShutdown,
  LEAD_MEMBER_NAME,
  listTeams,
  pruneEvents,
  readBulletinPosts,
  readDebugLogs,
  readTeam,
  resolveSenderName,
  teamDir,
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

function makeTools(
  client: Client,
  _getLogger: (client: Client, teamName: string) => Logger,
): Record<string, ToolDefinition> {
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
      const log = _getLogger(client, args.name);
      log.debug("tool", "team_create called", {
        name: args.name,
        hasDescription: args.description !== undefined,
        sessionId: context.sessionID,
      });
      try {
        const existing = await readTeam(args.name);
        if (existing !== null) {
          log.warn("tool", "team_create skipped — team already exists", {
            name: args.name,
          });
          return `Error: Team "${args.name}" already exists.`;
        }
        await writeTeam({
          name: args.name,
          leadSessionId: context.sessionID,
          members: {},
          tasks: {},
          createdAt: new Date().toISOString(),
        });
        log.info("tool", "team created", {
          name: args.name,
          leadSessionId: context.sessionID,
        });

        // SDK audit: @opencode-ai/sdk exposes no silent system-prompt injection
        // (no appendSystem / updateSystem / systemPrompt field on session). The
        // behavioural framing is therefore sent as a visible promptAsync message
        // to the lead's own session. This is acceptable — it frames the lead's
        // role at team creation time and appears once in their chat history.
        const leadBehaviourMsg = [
          `[Team Protocol] You are the lead of team "${args.name}". Your job is to set direction and synthesise results — not to dispatch or supervise every action.`,
          ``,
          `Before spawning members:`,
          `- Post shared context (goals, constraints, known facts) to team_bulletin_post so members start informed.`,
          `- Add tasks to the board with team_task_add. Members self-claim — you do not need to assign work individually.`,
          ``,
          `After spawning:`,
          `- Trust members to work autonomously. They will notify you the moment they finish. Do not message them in the meantime.`,
          `- While members are busy, your only valid actions are read-only: team_timeline, team_bulletin_read, team_task_list, team_status. Do not call team_message, team_broadcast, or team_announce.`,
          `- The urge to check in ("any updates?", "how is it going?", "just checking", "what's your interpretation?") is always wrong. It interrupts work in progress and adds no information — members cannot give you an update mid-task. Suppress it.`,
          `- If all members are busy and you have nothing to read, stop. Wait. Idleness on your part is correct behaviour, not a problem.`,
          `- When you receive an idle notification, read the result and decide next steps. Do not automatically reply.`,
          ``,
          `When something goes wrong or you need the full picture:`,
          `- team_timeline — chronological view of all messages, task events, and bulletin posts.`,
          `- team_bulletin_read — shared findings and blockers posted by members.`,
          `- team_task_list — see what's pending, in progress, or blocked.`,
          `- team_logs — structured debug logs if you need to trace an event handler issue.`,
          ``,
          `To send genuinely new instructions to a specific member: team_message to="<name>". For a true emergency that cannot wait: team_interrupt. These are not for status checks.`,
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
        log.error("tool", "team_create failed", {
          name: args.name,
          error: String(err),
        });
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
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_spawn called", {
        memberName: args.memberName,
        role: args.role,
        model: args.model,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          log.warn("tool", "team_spawn skipped — team not found", {
            teamName: args.teamName,
          });
          return `Error: Team "${args.teamName}" does not exist. Create it first with team_create.`;
        }
        if (team.members[args.memberName] !== undefined) {
          log.warn("tool", "team_spawn skipped — member already exists", {
            teamName: args.teamName,
            memberName: args.memberName,
          });
          return `Error: Member "${args.memberName}" already exists in team "${args.teamName}".`;
        }

        const sessionCreateRetries = [1000, 2000, 4000] as const;
        const promptRetries = [500, 1000] as const;
        let sessionId: string | undefined;
        let sessionCreateErr: unknown;

        for (let attempt = 0; attempt <= 3; attempt++) {
          if (attempt > 0) {
            const delay = sessionCreateRetries[attempt - 1] as number;
            await new Promise((res) => setTimeout(res, delay));
            try {
              await updateMember(args.teamName, args.memberName, {
                status: "retrying",
                retryAttempt: attempt,
                retryNextMs: delay,
              });
            } catch (updateErr) {
              console.error(
                "[team_spawn] failed to update member status to retrying:",
                updateErr,
              );
            }
          }

          const createResult = await client.session.create({
            body: { title: `[${args.teamName}] ${args.memberName}` },
          });

          if (createResult.error === undefined) {
            sessionId = createResult.data.id;
            break;
          }

          sessionCreateErr = createResult.error;

          if (attempt === 3) {
            try {
              await updateMember(
                args.teamName,
                args.memberName,
                {
                  status: "error",
                },
                ["retryAttempt", "retryNextMs"],
              );
            } catch (updateErr) {
              console.error(
                "[team_spawn] failed to update member status to error:",
                updateErr,
              );
            }
            return `Error creating session for member: ${JSON.stringify(sessionCreateErr)}`;
          }
        }

        if (sessionId === undefined) {
          throw new Error("session ID not created");
        }

        const now = new Date().toISOString();
        await writeTeam({
          ...team,
          members: {
            ...team.members,
            [args.memberName]: {
              name: args.memberName,
              sessionId,
              status: "busy",
              agentType: args.role,
              model: args.model ?? "default",
              spawnedAt: now,
            },
          },
        });

        const systemPrompt = [
          `[Team Protocol] You are "${args.memberName}", a ${args.role} on team "${args.teamName}".`,
          ``,
          `Do NOT use team management tools (team_create, team_spawn, team_shutdown). Those are lead-only.`,
          ``,
          `Before starting work:`,
          `- Read team_bulletin_read. The lead may have posted context, constraints, or findings you need.`,
          ``,
          `While working:`,
          `- If you need information a peer might have, ask them directly: team_message to="<memberName>". Don't route through the lead.`,
          `- If you discover something the team should know (a finding, a blocker, a question), post it: team_bulletin_post.`,
          ``,
          `When you receive a message from a peer (team_message):`,
          `- Act on it immediately. Your initial task tells you what to do — do it now.`,
          `- If your task says to pass something to another member, use team_message right away. Do not ask the sender for clarification.`,
          `- Never reply back to the sender asking "what's your interpretation?" or "what should I do?". That is a loop. Just act on what you received.`,
          `- One message received = one action taken. Then go idle or continue your task.`,
          ``,
          `When you finish your current task:`,
          `- Report results to the lead: team_message to="lead", teamName="${args.teamName}".`,
          `- Check for more work: team_task_list status="pending", then team_task_claim to self-assign. Do not wait for the lead to give you the next task.`,
          `- If nothing is pending and you have no more work, go idle.`,
          ``,
          `Before going idle:`,
          `- Post any significant findings or unresolved blockers to team_bulletin_post so teammates and the lead have the full picture.`,
        ].join("\n");

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

        let promptErr: unknown;
        for (let attempt = 0; attempt <= 2; attempt++) {
          if (attempt > 0) {
            const delay = promptRetries[attempt - 1] as number;
            await new Promise((res) => setTimeout(res, delay));
            try {
              await updateMember(args.teamName, args.memberName, {
                status: "retrying",
                retryAttempt: attempt,
                retryNextMs: delay,
              });
            } catch (updateErr) {
              console.error(
                "[team_spawn] failed to update member status to retrying:",
                updateErr,
              );
            }
          }

          try {
            await client.session.promptAsync({
              path: { id: sessionId },
              body: {
                parts: [{ type: "text" as const, text: args.initialPrompt }],
                system: systemPrompt,
                ...(modelOpt !== undefined ? { model: modelOpt } : {}),
              },
            });
            promptErr = undefined;
            break;
          } catch (err) {
            promptErr = err;

            if (attempt === 2) {
              try {
                await updateMember(
                  args.teamName,
                  args.memberName,
                  {
                    status: "error",
                  },
                  ["retryAttempt", "retryNextMs"],
                );
              } catch (updateErr) {
                console.error(
                  "[team_spawn] failed to update member status to error:",
                  updateErr,
                );
              }
              return `Error sending initial prompt to member "${args.memberName}": ${String(promptErr)}`;
            }
          }
        }

        log.info("tool", "member spawned", {
          memberName: args.memberName,
          sessionId,
          teamName: args.teamName,
        });
        await appendEvent(args.teamName, {
          type: "system",
          sender: LEAD_MEMBER_NAME,
          senderId: _context.sessionID,
          content: `spawned member "${args.memberName}" as ${args.role}`,
        });
        return `Member "${args.memberName}" spawned (session: ${sessionId}). Initial prompt sent.`;
      } catch (err) {
        log.error("tool", "team_spawn failed", {
          memberName: args.memberName,
          teamName: args.teamName,
          error: String(err),
        });
        console.error("[team_spawn] error:", err);
        return `Error spawning member: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_message
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
      const log = _getLogger(client, args.teamName);
      log.debug("messaging", "team_message called", {
        to: args.to,
        teamName: args.teamName,
        senderSessionId: context.sessionID,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          log.warn("messaging", "team_message skipped — team not found", {
            teamName: args.teamName,
          });
          return `Error: Team "${args.teamName}" not found.`;
        }

        const senderName = await resolveSenderName(context.sessionID);

        // Resolve target session ID
        let targetSessionId: string;
        if (args.to === "lead" || args.to === LEAD_MEMBER_NAME) {
          targetSessionId = team.leadSessionId;
        } else {
          const member = team.members[args.to];
          if (member === undefined) {
            log.warn("messaging", "team_message skipped — member not found", {
              to: args.to,
              teamName: args.teamName,
            });
            return `Error: Member "${args.to}" not found in team "${args.teamName}".`;
          }
          if (isMemberShutdown(member)) {
            log.warn("messaging", "team_message skipped — member shutdown", {
              to: args.to,
              teamName: args.teamName,
            });
            return `Error: Member "${args.to}" is in shutdown state and cannot receive messages.`;
          }
          // Soft guard: warn the lead against messaging busy members.
          // Members cannot give useful updates mid-task; this message would
          // only interrupt their work. Use team_interrupt for true emergencies.
          if (
            context.sessionID === team.leadSessionId &&
            (member.status === "busy" || member.status === "retrying")
          ) {
            log.info("messaging", "team_message lead-to-busy-member blocked", {
              to: args.to,
              memberStatus: member.status,
            });
            return `Not sent. "${args.to}" is currently busy — messaging them mid-task interrupts their work and won't get you a useful response. They will notify you when done. If this genuinely cannot wait, use team_interrupt instead.`;
          }
          targetSessionId = member.sessionId;
        }

        const prefixedMessage = `[Team message from ${senderName}]: ${args.message}`;
        await client.session.promptAsync({
          path: { id: targetSessionId },
          body: { parts: [{ type: "text" as const, text: prefixedMessage }] },
        });

        const recipient =
          args.to === "lead" || args.to === LEAD_MEMBER_NAME
            ? LEAD_MEMBER_NAME
            : args.to;
        await appendEvent(args.teamName, {
          type: "message",
          sender: senderName,
          senderId: context.sessionID,
          content: args.message,
          mentions: [recipient],
        });

        log.info("messaging", "message sent", {
          to: args.to,
          teamName: args.teamName,
        });
        return `Message sent to "${args.to}".`;
      } catch (err) {
        log.error("messaging", "team_message failed", {
          to: args.to,
          teamName: args.teamName,
          error: String(err),
        });
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
      const log = _getLogger(client, args.teamName);
      log.debug("messaging", "team_broadcast called", {
        teamName: args.teamName,
        senderSessionId: context.sessionID,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          log.warn("messaging", "team_broadcast skipped — team not found", {
            teamName: args.teamName,
          });
          return `Error: Team "${args.teamName}" not found.`;
        }

        const senderName = await resolveSenderName(context.sessionID);

        const prefixedMessage = `[Team broadcast from ${senderName}]: ${args.message}`;

        const activeMembers = Object.entries(team.members).filter(
          ([_, member]) =>
            member.sessionId !== context.sessionID && isMemberActive(member),
        );

        const messaged: string[] = [];
        await Promise.all(
          activeMembers.map(async ([memberName, member]) => {
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
          }),
        );

        if (messaged.length === 0) {
          log.info("messaging", "team_broadcast — no active members", {
            teamName: args.teamName,
          });
          return `Broadcast sent to no members (no active members found excluding sender).`;
        }

        await appendEvent(args.teamName, {
          type: "message",
          sender: senderName,
          senderId: context.sessionID,
          content: `[broadcast] ${args.message}`,
          mentions: messaged,
        });

        log.info("messaging", "team_broadcast sent", {
          teamName: args.teamName,
          recipients: messaged,
        });
        return `Broadcast sent to: ${messaged.join(", ")}.`;
      } catch (err) {
        log.error("messaging", "team_broadcast failed", {
          teamName: args.teamName,
          error: String(err),
        });
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
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_status called", { teamName: args.teamName });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          log.warn("tool", "team_status skipped — team not found", {
            teamName: args.teamName,
          });
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

        log.info("tool", "team_status retrieved", {
          teamName: args.teamName,
          memberCount: Object.keys(team.members).length,
          taskCount: Object.keys(team.tasks).length,
        });
        return lines.join("\n");
      } catch (err) {
        log.error("tool", "team_status failed", {
          teamName: args.teamName,
          error: String(err),
        });
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
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_shutdown called", {
        teamName: args.teamName,
        targetMember: args.memberName ?? "all",
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          log.warn("tool", "team_shutdown skipped — team not found", {
            teamName: args.teamName,
          });
          return `Error: Team "${args.teamName}" not found.`;
        }

        const shutdownMsg =
          "[System]: You are being shut down. Complete your current thought and stop.";

        const targets: Array<{ name: string; sessionId: string }> = [];

        if (typeof args.memberName === "string") {
          const member = team.members[args.memberName];
          if (member === undefined) {
            log.warn("tool", "team_shutdown skipped — member not found", {
              teamName: args.teamName,
              memberName: args.memberName,
            });
            return `Error: Member "${args.memberName}" not found in team "${args.teamName}".`;
          }
          targets.push({ name: args.memberName, sessionId: member.sessionId });
        } else {
          for (const [name, member] of Object.entries(team.members)) {
            if (isMemberActive(member)) {
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
          log.info("tool", "team_shutdown — no active members to shut down", {
            teamName: args.teamName,
          });
          return `No members were shut down (no active members found).`;
        }
        log.info("tool", "shutdown requested", {
          teamName: args.teamName,
          shutMembers: shut,
        });
        return `Shutdown requested for: ${shut.join(", ")}.`;
      } catch (err) {
        log.error("tool", "team_shutdown failed", {
          teamName: args.teamName,
          error: String(err),
        });
        console.error("[team_shutdown] error:", err);
        return `Error shutting down: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_interrupt
  // ---------------------------------------------------------------------------
  const team_interrupt = tool({
    description:
      "Interrupt a busy team member mid-task and deliver a priority message. Aborts their current generation immediately, then queues the message as their next prompt.",
    args: {
      teamName: z.string().describe("Name of the team"),
      memberName: z.string().describe("Name of the member to interrupt"),
      message: z
        .string()
        .describe(
          "Priority message or question to deliver after the interrupt",
        ),
    },
    async execute(args, context) {
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_interrupt called", {
        teamName: args.teamName,
        memberName: args.memberName,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          log.warn("tool", "team_interrupt skipped — team not found", {
            teamName: args.teamName,
          });
          return `Error: Team "${args.teamName}" not found.`;
        }

        const member = team.members[args.memberName];
        if (member === undefined) {
          log.warn("tool", "team_interrupt skipped — member not found", {
            teamName: args.teamName,
            memberName: args.memberName,
          });
          return `Error: Member "${args.memberName}" not found in team "${args.teamName}".`;
        }
        if (isMemberShutdown(member)) {
          log.warn("tool", "team_interrupt skipped — member shutdown", {
            teamName: args.teamName,
            memberName: args.memberName,
          });
          return `Error: Member "${args.memberName}" is in shutdown state and cannot be interrupted.`;
        }

        // Stop the member's current generation
        const abortResult = await client.session.abort({
          path: { id: member.sessionId },
        });
        if (abortResult.error !== undefined) {
          log.error("tool", "team_interrupt abort failed", {
            teamName: args.teamName,
            memberName: args.memberName,
            error: JSON.stringify(abortResult.error),
          });
          return `Error: Failed to interrupt member "${args.memberName}": ${JSON.stringify(abortResult.error)}`;
        }

        const wasRunning = abortResult.data === true;

        // Deliver the priority message immediately after abort
        try {
          await client.session.promptAsync({
            path: { id: member.sessionId },
            body: {
              parts: [
                {
                  type: "text" as const,
                  text: `[Priority interrupt from lead]: ${args.message}`,
                },
              ],
            },
          });
        } catch (promptErr) {
          console.error(
            "[team_interrupt] promptAsync failed after abort:",
            promptErr,
          );
          log.error("tool", "team_interrupt promptAsync failed after abort", {
            teamName: args.teamName,
            memberName: args.memberName,
            error: String(promptErr),
          });
          return `Member "${args.memberName}" interrupted, but failed to deliver message: ${String(promptErr)}`;
        }

        const senderName = await resolveSenderName(context.sessionID);
        await appendEvent(args.teamName, {
          type: "message",
          sender: senderName,
          senderId: context.sessionID,
          content: `[interrupt] ${args.message}`,
          mentions: [args.memberName],
        });

        log.info("tool", "member interrupted", {
          teamName: args.teamName,
          memberName: args.memberName,
          wasRunning,
        });
        return wasRunning
          ? `Member "${args.memberName}" interrupted and priority message delivered.`
          : `Member "${args.memberName}" was idle — priority message delivered without interruption.`;
      } catch (err) {
        log.error("tool", "team_interrupt failed", {
          teamName: args.teamName,
          memberName: args.memberName,
          error: String(err),
        });
        console.error("[team_interrupt] error:", err);
        return `Error interrupting member: ${String(err)}`;
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
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_task_add called", {
        teamName: args.teamName,
        title: args.title,
        assignee: args.assignee,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          log.warn("tool", "team_task_add skipped — team not found", {
            teamName: args.teamName,
          });
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
        log.info("tool", "task added", {
          teamName: args.teamName,
          taskId,
          title: args.title,
        });
        return `Task "${args.title}" added with ID: ${taskId}.`;
      } catch (err) {
        log.error("tool", "team_task_add failed", {
          teamName: args.teamName,
          error: String(err),
        });
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
      const baseLog = _getLogger(client, args.teamName);
      try {
        const found = await findTeamBySession(context.sessionID);
        const memberName =
          found !== null && found.memberName !== LEAD_MEMBER_NAME
            ? found.memberName
            : context.sessionID;
        const log = baseLog.child({ memberName });
        log.debug("tool", "team_task_claim called", {
          teamName: args.teamName,
          taskId: args.taskId,
          sessionId: context.sessionID,
        });

        const result = await claimTask(args.teamName, args.taskId, memberName);
        if (!result.ok) {
          log.warn("tool", "team_task_claim failed", {
            teamName: args.teamName,
            taskId: args.taskId,
            reason: result.reason,
          });
          return `Error: ${result.reason}`;
        }
        log.info("tool", "task claimed", {
          teamName: args.teamName,
          taskId: args.taskId,
          memberName,
        });
        await appendEvent(args.teamName, {
          type: "task",
          sender: memberName,
          senderId: context.sessionID,
          content: `claimed task ${args.taskId}`,
          targetId: args.taskId,
        });
        return `Task "${args.taskId}" claimed by "${memberName}" and is now in_progress.`;
      } catch (err) {
        baseLog.error("tool", "team_task_claim failed", {
          teamName: args.teamName,
          taskId: args.taskId,
          error: String(err),
        });
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
    async execute(args, context) {
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_task_done called", {
        teamName: args.teamName,
        taskId: args.taskId,
      });
      try {
        const result = await completeTask(args.teamName, args.taskId);
        if (!result.ok) {
          log.warn("tool", "team_task_done failed", {
            teamName: args.teamName,
            taskId: args.taskId,
            reason: result.reason,
          });
          return `Error: ${result.reason}`;
        }
        const unblockedMsg =
          result.unblockedTaskIds.length > 0
            ? ` Newly unblocked: ${result.unblockedTaskIds.join(", ")}.`
            : "";
        log.info("tool", "task completed", {
          teamName: args.teamName,
          taskId: args.taskId,
          unblocked: result.unblockedTaskIds,
        });
        const senderName = await resolveSenderName(context.sessionID);
        const completedContent =
          result.unblockedTaskIds.length > 0
            ? `completed task ${args.taskId} — unblocked: ${result.unblockedTaskIds.join(", ")}`
            : `completed task ${args.taskId}`;
        await appendEvent(args.teamName, {
          type: "task",
          sender: senderName,
          senderId: context.sessionID,
          content: completedContent,
          targetId: args.taskId,
        });
        return `Task "${args.taskId}" marked as completed.${unblockedMsg}`;
      } catch (err) {
        log.error("tool", "team_task_done failed", {
          teamName: args.teamName,
          taskId: args.taskId,
          error: String(err),
        });
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
      const log = _getLogger(client, args.teamName);
      log.debug("messaging", "team_post called", {
        teamName: args.teamName,
        senderSessionId: context.sessionID,
        hasMentions: args.mentions !== undefined,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          log.warn("messaging", "team_post skipped — team not found", {
            teamName: args.teamName,
          });
          return `Error: Team "${args.teamName}" not found.`;
        }

        const senderName = await resolveSenderName(context.sessionID);
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

        await Promise.all(
          validatedMentions.map(async (mentioned) => {
            const member = team.members[mentioned];
            if (!member || isMemberShutdown(member)) return;
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
          }),
        );

        log.info("messaging", "posted to channel", {
          teamName: args.teamName,
          eventId: event.id,
          mentions: validatedMentions,
        });
        return `Posted to channel: ${event.id}`;
      } catch (err) {
        log.error("messaging", "team_post failed", {
          teamName: args.teamName,
          error: String(err),
        });
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
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_history called", {
        teamName: args.teamName,
        limit: args.limit,
      });
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
      const log = _getLogger(client, args.teamName);
      log.debug("messaging", "team_announce called", {
        teamName: args.teamName,
        senderSessionId: context.sessionID,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          log.warn("messaging", "team_announce skipped — team not found", {
            teamName: args.teamName,
          });
          return `Error: Team "${args.teamName}" not found.`;
        }

        const senderName = await resolveSenderName(context.sessionID);
        const senderId = context.sessionID;

        await appendEvent(args.teamName, {
          type: "message",
          sender: senderName,
          senderId,
          content: `[ANNOUNCEMENT] ${args.message}`,
        });

        const messaged: string[] = [];
        await Promise.all(
          Object.entries(team.members).map(async ([memberName, member]) => {
            if (!isMemberActive(member)) return;
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
          }),
        );

        log.info("messaging", "announcement sent", {
          teamName: args.teamName,
          recipients: messaged,
        });
        return `Announcement sent to: ${messaged.join(", ")} (including sender).`;
      } catch (err) {
        log.error("messaging", "team_announce failed", {
          teamName: args.teamName,
          error: String(err),
        });
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
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_react called", {
        teamName: args.teamName,
        messageId: args.messageId,
        reaction: args.reaction,
      });
      try {
        if (!isValidReaction(args.reaction)) {
          log.warn("tool", "team_react skipped — invalid reaction", {
            teamName: args.teamName,
            reaction: args.reaction,
          });
          return `Error: Invalid reaction "${args.reaction}". Valid: ${VALID_REACTIONS.join(", ")}`;
        }

        const team = await readTeam(args.teamName);
        if (team === null) {
          log.warn("tool", "team_react skipped — team not found", {
            teamName: args.teamName,
          });
          return `Error: Team "${args.teamName}" not found.`;
        }

        const senderName = await resolveSenderName(context.sessionID);
        const senderId = context.sessionID;

        const event = await appendEvent(args.teamName, {
          type: "reaction",
          sender: senderName,
          senderId,
          content: `reacted with ${args.reaction}`,
          targetId: args.messageId,
          reaction: args.reaction,
        });

        log.info("tool", "reaction added", {
          teamName: args.teamName,
          messageId: args.messageId,
          reaction: args.reaction,
        });
        return `Reaction ${args.reaction} added to ${args.messageId}: ${event.id}`;
      } catch (err) {
        log.error("tool", "team_react failed", {
          teamName: args.teamName,
          error: String(err),
        });
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
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_prune called", {
        teamName: args.teamName,
        keep: args.keep,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          log.warn("tool", "team_prune skipped — team not found", {
            teamName: args.teamName,
          });
          return `Error: Team "${args.teamName}" not found.`;
        }

        const { pruned, remaining } = await pruneEvents(
          args.teamName,
          args.keep,
        );
        log.info("tool", "events pruned", {
          teamName: args.teamName,
          pruned,
          remaining,
        });
        return `Pruned ${pruned} events. ${remaining} events remaining.`;
      } catch (err) {
        log.error("tool", "team_prune failed", {
          teamName: args.teamName,
          error: String(err),
        });
        console.error("[team_prune] error:", err);
        return `Error pruning events: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_list
  // ---------------------------------------------------------------------------
  const team_list = tool({
    description:
      "List all existing teams. Returns array of team names with basic info (member count, task count, created date).",
    args: {},
    async execute(_args, _context) {
      try {
        const names = await listTeams();
        if (names.length === 0) {
          return "No teams exist yet.";
        }

        const lines: string[] = [];
        for (const name of names) {
          const team = await readTeam(name);
          if (team === null) continue;
          const memberCount = Object.keys(team.members).length;
          const taskCount = Object.keys(team.tasks).length;
          lines.push(
            `  - ${team.name}: ${memberCount} member(s), ${taskCount} task(s), created=${team.createdAt}`,
          );
        }
        return ["Teams:", ...lines].join("\n");
      } catch (err) {
        console.error("[team_list] error:", err);
        return `Error listing teams: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_delete
  // ---------------------------------------------------------------------------
  const team_delete = tool({
    description:
      "Delete/dissolve a team. Only the lead can do this. Removes the team's config directory entirely.",
    args: {
      teamName: z.string().describe("Name of the team to delete"),
    },
    async execute(args, context) {
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        if (team.leadSessionId !== context.sessionID) {
          return `Error: Only the team lead can delete the team.`;
        }

        const memberNames = Object.keys(team.members);
        if (memberNames.length > 0) {
          return `Warning: Team "${args.teamName}" has ${memberNames.length} active member(s): ${memberNames.join(", ")}. Shutdown members first with team_shutdown, then retry.`;
        }

        const dir = teamDir(args.teamName);
        await fs.rm(dir, { recursive: true, force: true });
        return `Team "${args.teamName}" deleted.`;
      } catch (err) {
        console.error("[team_delete] error:", err);
        return `Error deleting team: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_task_list
  // ---------------------------------------------------------------------------
  const team_task_list = tool({
    description: "List all tasks for a team with optional status filtering.",
    args: {
      teamName: z.string().describe("Name of the team"),
      status: z
        .enum(["pending", "in_progress", "completed", "blocked"])
        .optional()
        .describe("Filter tasks by status"),
    },
    async execute(args, _context) {
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_task_list called", {
        teamName: args.teamName,
        status: args.status,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        const tasks = Object.values(team.tasks);
        const filtered = args.status
          ? tasks.filter((t) => t.status === args.status)
          : tasks;

        if (filtered.length === 0) {
          return `No tasks found${args.status ? ` with status "${args.status}"` : ""} in team "${args.teamName}".`;
        }

        const lines = filtered.map(
          (t) =>
            `  - [${t.status}] ${t.id}: ${t.title} (assignee: ${t.assignee ?? "unassigned"})${t.dependsOn.length > 0 ? ` blocked by: ${t.dependsOn.join(", ")}` : ""}`,
        );
        return [
          `Tasks in "${args.teamName}"${args.status ? ` (${args.status})` : ""}:`,
          ...lines,
        ].join("\n");
      } catch (err) {
        console.error("[team_task_list] error:", err);
        return `Error listing tasks: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_task_update
  // ---------------------------------------------------------------------------
  const team_task_update = tool({
    description: "Update task fields (title, description, assignee).",
    args: {
      teamName: z.string().describe("Name of the team"),
      taskId: z.string().describe("ID of the task to update"),
      title: z.string().optional().describe("New title for the task"),
      description: z
        .string()
        .optional()
        .describe("New description for the task"),
      assignee: z
        .string()
        .optional()
        .describe("New assignee for the task (use null to unassign)"),
    },
    async execute(args, _context) {
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_task_update called", {
        teamName: args.teamName,
        taskId: args.taskId,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          log.warn("tool", "team_task_update skipped — team not found", {
            teamName: args.teamName,
          });
          return `Error: Team "${args.teamName}" not found.`;
        }

        const task = team.tasks[args.taskId];
        if (task === undefined) {
          log.warn("tool", "team_task_update skipped — task not found", {
            teamName: args.teamName,
            taskId: args.taskId,
          });
          return `Error: Task "${args.taskId}" not found in team "${args.teamName}".`;
        }

        if (
          args.title === undefined &&
          args.description === undefined &&
          args.assignee === undefined
        ) {
          log.warn("tool", "team_task_update skipped — no fields to update", {
            teamName: args.teamName,
            taskId: args.taskId,
          });
          return `Error: No fields to update. Provide at least one of: title, description, assignee.`;
        }

        await writeTeam({
          ...team,
          tasks: {
            ...team.tasks,
            [args.taskId]: {
              ...task,
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.description !== undefined
                ? { description: args.description }
                : {}),
              ...(args.assignee !== undefined
                ? { assignee: args.assignee }
                : {}),
            },
          },
        });

        log.info("tool", "task updated", {
          teamName: args.teamName,
          taskId: args.taskId,
        });
        return `Task "${args.taskId}" updated.`;
      } catch (err) {
        log.error("tool", "team_task_update failed", {
          teamName: args.teamName,
          taskId: args.taskId,
          error: String(err),
        });
        console.error("[team_task_update] error:", err);
        return `Error updating task: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_member_info
  // ---------------------------------------------------------------------------
  const team_member_info = tool({
    description: "Get detailed info about a specific member.",
    args: {
      teamName: z.string().describe("Name of the team"),
      memberName: z.string().describe("Name of the member to get info about"),
    },
    async execute(args, _context) {
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_member_info called", {
        teamName: args.teamName,
        memberName: args.memberName,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        const member = team.members[args.memberName];
        if (member === undefined) {
          return `Error: Member "${args.memberName}" not found in team "${args.teamName}".`;
        }

        const currentTask = Object.values(team.tasks).find(
          (t) => t.assignee === args.memberName && t.status === "in_progress",
        );

        const lines = [
          `Member: ${member.name}`,
          `Session ID: ${member.sessionId}`,
          `Status: ${member.status}`,
          `Model: ${member.model}`,
          `Agent type: ${member.agentType}`,
          `Spawned at: ${member.spawnedAt}`,
          ...(currentTask
            ? [`Current task: ${currentTask.id} - ${currentTask.title}`]
            : []),
        ];
        return lines.join("\n");
      } catch (err) {
        console.error("[team_member_info] error:", err);
        return `Error getting member info: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_member_session
  // ---------------------------------------------------------------------------
  const team_member_session = tool({
    description:
      "Read the raw conversation of a specific member's session: the prompts they received, their responses, and the tools they called. Use this to understand exactly what a member is doing or has done — their 'voice'.",
    args: {
      teamName: z.string().describe("Name of the team"),
      memberName: z.string().describe("Name of the member to inspect"),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Number of most recent messages to show (default: 20)"),
    },
    async execute(args, _context) {
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_member_session called", {
        teamName: args.teamName,
        memberName: args.memberName,
        limit: args.limit,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        const member = team.members[args.memberName];
        if (member === undefined) {
          return `Error: Member "${args.memberName}" not found in team "${args.teamName}".`;
        }

        const result = await client.session.messages({
          path: { id: member.sessionId },
          query: { limit: 200 },
        });

        if (result.error !== undefined) {
          log.error("tool", "team_member_session fetch failed", {
            memberName: args.memberName,
            error: JSON.stringify(result.error),
          });
          return `Error fetching session messages: ${JSON.stringify(result.error)}`;
        }

        const all = result.data;
        const limit = args.limit ?? 20;
        const selected = all.slice(-limit);

        const header = [
          `Member: ${args.memberName}  status: ${member.status}  session: ${member.sessionId}`,
          `Showing ${selected.length} of ${all.length} messages`,
          "",
        ];

        const TEXT_LIMIT = 600;
        const TOOL_OUTPUT_LIMIT = 400;

        const body: string[] = [];
        for (const { info, parts } of selected) {
          const ts = new Date(info.time.created).toISOString().slice(11, 19); // HH:MM:SS

          if (info.role === "user") {
            body.push(`── RECEIVED @ ${ts} ${"─".repeat(50)}`);
            for (const p of parts) {
              if (p.type !== "text") continue;
              if (p.synthetic) continue; // skip system-injected markers
              const text = p.text.length > TEXT_LIMIT
                ? `${p.text.slice(0, TEXT_LIMIT)}…`
                : p.text;
              body.push(text);
            }
          } else {
            body.push(`── ${args.memberName} @ ${ts} ${"─".repeat(50)}`);
            // First, render any error on the assistant message
            if (info.error !== undefined) {
              body.push(`[ERROR] ${JSON.stringify(info.error)}`);
            }
            for (const p of parts) {
              if (p.type === "text") {
                if (p.synthetic) continue;
                const text = p.text.length > TEXT_LIMIT
                  ? `${p.text.slice(0, TEXT_LIMIT)}…`
                  : p.text;
                body.push(text);
              } else if (p.type === "tool") {
                const inputStr = JSON.stringify(p.state.input);
                const truncInput =
                  inputStr.length > 300 ? `${inputStr.slice(0, 300)}…` : inputStr;
                if (p.state.status === "completed") {
                  const out = p.state.output.length > TOOL_OUTPUT_LIMIT
                    ? `${p.state.output.slice(0, TOOL_OUTPUT_LIMIT)}…`
                    : p.state.output;
                  body.push(`  [tool: ${p.tool}]`);
                  body.push(`  in:  ${truncInput}`);
                  body.push(`  out: ${out}`);
                } else if (p.state.status === "error") {
                  body.push(`  [tool: ${p.tool}] ERROR: ${p.state.error.slice(0, 200)}`);
                } else {
                  body.push(`  [tool: ${p.tool}] (${p.state.status})`);
                }
              }
            }
          }
          body.push("");
        }

        log.info("tool", "team_member_session retrieved", {
          memberName: args.memberName,
          totalMessages: all.length,
          shown: selected.length,
        });
        return [...header, ...body].join("\n");
      } catch (err) {
        log.error("tool", "team_member_session failed", {
          teamName: args.teamName,
          memberName: args.memberName,
          error: String(err),
        });
        console.error("[team_member_session] error:", err);
        return `Error reading member session: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_logs
  // ---------------------------------------------------------------------------
  const team_logs = tool({
    description:
      "Read recent debug log entries for a team. Logs are written to a debug.jsonl file when structured logging is enabled for the team.",
    args: {
      teamName: z.string().describe("Name of the team"),
      level: z
        .enum(["debug", "info", "warn", "error"])
        .optional()
        .describe("Filter by log level"),
      sessionId: z.string().optional().describe("Filter by session ID"),
      memberName: z.string().optional().describe("Filter by member name"),
      since: z
        .string()
        .optional()
        .describe("ISO timestamp — only logs after this time"),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe("Maximum number of log entries to return (default: 100)"),
    },
    async execute(args, _context) {
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_logs called", {
        teamName: args.teamName,
        level: args.level,
        limit: args.limit,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        const { logs, total } = await readDebugLogs(args.teamName, {
          ...(args.level !== undefined ? { level: args.level } : {}),
          ...(args.sessionId !== undefined
            ? { sessionId: args.sessionId }
            : {}),
          ...(args.memberName !== undefined
            ? { memberName: args.memberName }
            : {}),
          ...(args.since !== undefined ? { since: args.since } : {}),
          limit: args.limit,
        });

        if (logs.length === 0) {
          return `No debug logs found for team "${args.teamName}" matching the given filters.`;
        }

        const lines = [
          `Debug logs for "${args.teamName}" (${logs.length} of ${total} total):`,
          ...logs.map(
            (e) =>
              `[${e.ts}] ${e.level.toUpperCase()} [${e.category}] ${e.memberName ?? "-"}: ${e.message}${e.context !== undefined ? ` ${JSON.stringify(e.context)}` : ""}`,
          ),
        ];
        return lines.join("\n");
      } catch (err) {
        console.error("[team_logs] error:", err);
        return `Error reading debug logs: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_bulletin_post
  // ---------------------------------------------------------------------------
  const team_bulletin_post = tool({
    description:
      "Post a finding, blocker, question, or update to the team's shared bulletin board. Other members read this before escalating to the lead.",
    args: {
      teamName: z.string().describe("Name of the team"),
      category: z
        .enum(["finding", "blocker", "question", "update"])
        .describe(
          "finding: discovered information; blocker: something preventing progress; question: need input; update: progress note",
        ),
      title: z.string().describe("Short summary (one line)"),
      body: z.string().describe("Full content of the post"),
    },
    async execute(args, context) {
      const baseLog = _getLogger(client, args.teamName);
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }
        const author = await resolveSenderName(context.sessionID);
        const log = baseLog.child({ memberName: author });
        log.debug("tool", "team_bulletin_post called", {
          teamName: args.teamName,
          category: args.category,
          senderSessionId: context.sessionID,
        });
        const post = await appendBulletinPost(args.teamName, {
          author,
          authorId: context.sessionID,
          category: args.category,
          title: args.title,
          body: args.body,
        });
        log.info("tool", "bulletin post created", {
          teamName: args.teamName,
          postId: post.id,
          category: args.category,
        });
        return `Bulletin post created: ${post.id}`;
      } catch (err) {
        baseLog.error("tool", "team_bulletin_post failed", {
          teamName: args.teamName,
          error: String(err),
        });
        return `Error posting to bulletin: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_bulletin_read
  // ---------------------------------------------------------------------------
  const team_bulletin_read = tool({
    description:
      "Read recent posts from the team's shared bulletin board. Check this before asking the lead or a peer for information that may already be documented.",
    args: {
      teamName: z.string().describe("Name of the team"),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Number of recent posts to retrieve (default: 20)"),
    },
    async execute(args, _context) {
      const log = _getLogger(client, args.teamName);
      log.debug("tool", "team_bulletin_read called", {
        teamName: args.teamName,
        limit: args.limit,
      });
      try {
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }
        const posts = await readBulletinPosts(args.teamName, args.limit);
        if (posts.length === 0) {
          return "No bulletin posts yet.";
        }
        const lines = posts.map(
          (p) =>
            `[${p.timestamp}] [${p.category.toUpperCase()}] ${p.author}: ${p.title}\n  ${p.body}`,
        );
        return ["Bulletin board:", ...lines].join("\n\n");
      } catch (err) {
        log.error("tool", "team_bulletin_read failed", {
          teamName: args.teamName,
          error: String(err),
        });
        return `Error reading bulletin: ${String(err)}`;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // team_timeline
  // ---------------------------------------------------------------------------
  const team_timeline = tool({
    description:
      "Unified chronological view of all team activity: messages, task events, status changes, bulletin posts, and system events — merged and sorted by time. Use this for debugging coordination and reviewing what happened.",
    args: {
      teamName: z.string().describe("Name of the team"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe(
          "Total number of entries to show across all sources (default: 50)",
        ),
    },
    async execute(args, context) {
      const baseLog = _getLogger(client, args.teamName);
      try {
        const callerName = await resolveSenderName(context.sessionID);
        const log = baseLog.child({ memberName: callerName });
        log.debug("tool", "team_timeline called", {
          teamName: args.teamName,
          limit: args.limit,
        });
        const team = await readTeam(args.teamName);
        if (team === null) {
          return `Error: Team "${args.teamName}" not found.`;
        }

        // Fetch more than the limit from each source so the merge has enough
        // entries to fill the requested window after sorting.
        const fetchN = args.limit * 2;
        const [{ events }, bulletinPosts] = await Promise.all([
          getEvents(args.teamName, fetchN),
          readBulletinPosts(args.teamName, fetchN),
        ]);

        type TimelineEntry = { timestamp: string; line: string };
        const entries: TimelineEntry[] = [];

        for (const e of events) {
          let label: string;
          if (e.type === "task") {
            label = `[TASK]`;
          } else if (e.type === "system") {
            label = `[SYSTEM]`;
          } else if (e.type === "status") {
            label = `[STATUS]`;
          } else if (e.type === "reaction") {
            label = `[REACT]`;
          } else {
            const to =
              e.mentions && e.mentions.length > 0
                ? ` → ${e.mentions.join(", ")}`
                : "";
            label = `[MSG${to}]`;
          }
          entries.push({
            timestamp: e.timestamp,
            line: `${e.timestamp} ${label} ${e.sender}: ${e.content}`,
          });
        }

        for (const p of bulletinPosts) {
          entries.push({
            timestamp: p.timestamp,
            line: `${p.timestamp} [${p.category.toUpperCase()}] ${p.author}: ${p.title} — ${p.body}`,
          });
        }

        entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const selected = entries.slice(-args.limit);

        if (selected.length === 0) {
          return "No activity recorded yet.";
        }

        return [`Timeline for "${args.teamName}":`, ...selected.map((e) => e.line)].join("\n");
      } catch (err) {
        baseLog.error("tool", "team_timeline failed", {
          teamName: args.teamName,
          error: String(err),
        });
        return `Error reading timeline: ${String(err)}`;
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
    team_interrupt,
    team_task_add,
    team_task_claim,
    team_task_done,
    team_post,
    team_history,
    team_announce,
    team_react,
    team_prune,
    team_list,
    team_delete,
    team_task_list,
    team_task_update,
    team_member_info,
    team_member_session,
    team_logs,
    team_bulletin_post,
    team_bulletin_read,
    team_timeline,
  };
}

// ---------------------------------------------------------------------------
// Factory — call this at plugin init with the live client
// ---------------------------------------------------------------------------

const noOpLogger: {
  debug: (_c: string, _m: string, _x?: Record<string, unknown>) => void;
  info: (_c: string, _m: string, _x?: Record<string, unknown>) => void;
  warn: (_c: string, _m: string, _x?: Record<string, unknown>) => void;
  error: (_c: string, _m: string, _x?: Record<string, unknown>) => void;
  child: (_overrides: Record<string, unknown>) => typeof noOpLogger;
} = {
  debug: (_c, _m, _x) => {},
  info: (_c, _m, _x) => {},
  warn: (_c, _m, _x) => {},
  error: (_c, _m, _x) => {},
  child: (_overrides) => noOpLogger,
};

export function createTools(
  client: Client,
  getLogger?: (client: Client, teamName: string) => Logger,
): Record<string, ToolDefinition> {
  return makeTools(
    client,
    getLogger ?? (() => noOpLogger as unknown as Logger),
  );
}
