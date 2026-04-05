import type { PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { findTeamBySession } from "./state.js";

type Client = PluginInput["client"];

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

    // Lead going idle — check if any members are still busy
    if (memberName === "__lead__") {
      const busyMembers = Object.values(team.members).filter(
        (m) => m.status === "busy",
      );
      if (busyMembers.length > 0) {
        const names = busyMembers.map((m) => m.name).join(", ");
        console.debug(
          `[opencode-teams] Lead session ${sessionID} is idle but members [${names}] are still busy. ` +
            `Lead may need to be re-prompted when they finish.`,
        );
      }
      return;
    }

    // Team member going idle
    const member = team.members[memberName];
    if (member === undefined) return;

    const wasBusy = member.status === "busy";

    // Update member status to ready
    try {
      const { updateMember } = await import("./state.js");
      await updateMember(team.name, memberName, { status: "ready" });
    } catch (err) {
      console.error(
        `[opencode-teams] Failed to update member ${memberName} status to ready:`,
        err,
      );
      return;
    }

    // If they were busy, notify the lead
    if (wasBusy) {
      const notifyMsg = `[System]: Teammate ${memberName} has gone idle and may need a follow-up or new task.`;
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
  };
}
