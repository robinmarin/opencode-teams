import type { PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { ansi, renderTeamStatus } from "./renderer.js";
import {
  findTeamBySession,
  listTeams,
  markStaleMembersAsError,
  updateMember,
} from "./state.js";

// leadSessionId_memberName -> last notification timestamp (ms)
const lastNotified = new Map<string, number>();

type Client = PluginInput["client"];

/**
 * On startup, scan all teams for members whose status is "busy" or
 * "shutdown_requested" — these represent sessions that were live when the
 * process last died. Mark them as "error" so the lead can decide what to do.
 */
async function recoverStaleMembers(): Promise<void> {
  const teamNames = await listTeams();
  for (const teamName of teamNames) {
    try {
      const recovered = await markStaleMembersAsError(teamName);
      for (const { memberName, previousStatus } of recovered) {
        console.log(
          `[opencode-teams] Recovery: member ${memberName} in team ${teamName} was stale (${previousStatus}), marked as error`,
        );
      }
    } catch (err) {
      console.error(
        `[opencode-teams] Recovery: failed to recover team ${teamName}:`,
        err,
      );
    }
  }
}

/**
 * Creates an event handler to be registered as the `event` hook in the plugin's
 * returned Hooks object.
 *
 * On every `session.idle` event:
 * - If the session is not part of any team → ignore
 * - If the session is the team lead → log if any members are busy (no auto-prompt)
 * - If the session is a team member going idle → update status to "ready";
 *   if they were previously "busy", notify the lead
 */
export function createEventHandler(
  client: Client,
): (input: { event: Event }) => Promise<void> {
  // Fire-and-forget startup recovery — do not block plugin init
  recoverStaleMembers().catch((err) => {
    console.error("[opencode-teams] recoverStaleMembers failed:", err);
  });

  return async ({ event }) => {
    if (event.type !== "session.idle") return;

    const { sessionID } = event.properties;

    let found: Awaited<ReturnType<typeof findTeamBySession>>;
    try {
      found = await findTeamBySession(sessionID);
    } catch (err) {
      console.error("[opencode-teams] error in findTeamBySession:", err);
      return;
    }

    if (found === null) return;

    const { team, memberName } = found;

    // Lead going idle — no action needed
    if (memberName === "__lead__") {
      return;
    }

    // Team member going idle
    const member = team.members[memberName];
    if (member === undefined) return;

    const wasBusy = member.status === "busy";

    // Update member status to ready
    try {
      await updateMember(team.name, memberName, { status: "ready" });
    } catch (err) {
      console.error(
        `[opencode-teams] Failed to update member ${memberName} status to ready:`,
        err,
      );
      return;
    }

    // If they were busy, notify the lead (with cooldown)
    if (wasBusy) {
      const cooldownKey = `${team.leadSessionId}_${memberName}`;
      const lastTime = lastNotified.get(cooldownKey) ?? 0;
      if (Date.now() - lastTime < 30_000) return;
      lastNotified.set(cooldownKey, Date.now());

      const notifyMsg = `[System]: Teammate ${memberName} has completed a work cycle and is now ready. Only send them a new message if you have specific new instructions. If they still have tasks in progress, they will continue without prompting.`;
      try {
        const parts = [{ type: "text" as const, text: notifyMsg }];
        await client.session.promptAsync({
          path: { id: team.leadSessionId },
          body: { parts },
        });
      } catch (err) {
        console.error(
          `[opencode-teams] Failed to notify lead of idle member ${memberName}:`,
          err,
        );
      }
    }

    // Render team status meters for the lead
    try {
      const leadMsg = ansi.save() + renderTeamStatus(team) + ansi.restore();
      await client.session.promptAsync({
        path: { id: team.leadSessionId },
        body: {
          parts: [{ type: "text" as const, text: leadMsg }],
        },
      });
    } catch {}
  };
}
