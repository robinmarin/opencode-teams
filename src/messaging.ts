import type { PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { renderTeamStatusPlain } from "./renderer.js";
import type { TeamConfig } from "./state.js";
import {
  appendEvent,
  findTeamBySession,
  isKnownSession,
  LEAD_MEMBER_NAME,
  listTeams,
  markStaleMembersAsError,
  sessionIndexSize,
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
  // Teams have independent locks — recover them in parallel
  await Promise.all(
    teamNames.map(async (teamName) => {
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
    }),
  );
}

/**
 * Creates an event handler to be registered as the `event` hook in the plugin's
 * returned Hooks object.
 *
 * Handled events:
 * - `session.status` (busy | retrying | idle):
 *     busy     → member status = "busy"  (silent, no lead notification)
 *     retrying → member status = "retrying", stores attempt + next-retry delay
 *     idle     → ignored (session.idle fires separately and is handled below)
 * - `session.idle`:
 *     Lead going idle   → no action (anti-loop guard)
 *     Member going idle → status = "ready"; if was busy/retrying, notify lead
 */
export function createEventHandler(
  client: Client,
): (input: { event: Event }) => Promise<void> {
  // Fire-and-forget startup recovery — do not block plugin init
  recoverStaleMembers().catch((err) => {
    console.error("[opencode-teams] recoverStaleMembers failed:", err);
  });

  return async ({ event }) => {
    if (event.type !== "session.idle" && event.type !== "session.status")
      return;

    const { sessionID } = event.properties;

    // Fast pre-check: if the index is populated and this session is absent,
    // it is definitely not a team session — skip the disk scan entirely.
    if (sessionIndexSize() > 0 && !isKnownSession(sessionID)) return;

    let found: Awaited<ReturnType<typeof findTeamBySession>>;
    try {
      found = await findTeamBySession(sessionID);
    } catch (err) {
      console.error("[opencode-teams] error in findTeamBySession:", err);
      return;
    }

    if (found === null) return;

    const { team, memberName } = found;

    // Lead session — no action needed for either event type
    if (memberName === LEAD_MEMBER_NAME) return;

    const member = team.members[memberName];
    if (member === undefined) return;

    // -----------------------------------------------------------------------
    // session.status — update member status silently; no lead notification.
    // Idle transitions are handled by session.idle below.
    // -----------------------------------------------------------------------
    if (event.type === "session.status") {
      const { status } = event.properties;
      if (status.type === "idle") return; // let session.idle handle it

      // SDK uses "retry"; our MemberStatus uses "retrying"
      const newStatus =
        status.type === "retry" ? ("retrying" as const) : ("busy" as const);
      const patch: Partial<typeof member> =
        status.type === "retry"
          ? {
              status: newStatus,
              retryAttempt: status.attempt,
              retryNextMs: status.next,
            }
          : { status: newStatus };
      // Clear stale retry context when transitioning to busy
      const clearFields =
        status.type !== "retry"
          ? (["retryAttempt", "retryNextMs"] as (keyof typeof member)[])
          : undefined;

      try {
        await updateMember(team.name, memberName, patch, clearFields);
      } catch (err) {
        console.error(
          `[opencode-teams] Failed to update member ${memberName} status to ${newStatus}:`,
          err,
        );
      }
      return;
    }

    // -----------------------------------------------------------------------
    // session.idle
    // -----------------------------------------------------------------------
    const wasBusy = member.status === "busy" || member.status === "retrying";

    // Update member status to ready; clear any retry context
    try {
      await updateMember(team.name, memberName, { status: "ready" }, [
        "retryAttempt",
        "retryNextMs",
      ]);
    } catch (err) {
      console.error(
        `[opencode-teams] Failed to update member ${memberName} status to ready:`,
        err,
      );
      return;
    }

    // Build an up-to-date team snapshot for the render (the object returned by
    // findTeamBySession predates the updateMember call above — apply the patch
    // in-memory so the lead sees the correct "ready" state).
    // Build snapshot with retry context stripped and status set to ready.
    const { retryAttempt: _ra, retryNextMs: _rnm, ...memberBase } = member;
    const updatedTeam: TeamConfig = {
      ...team,
      members: {
        ...team.members,
        [memberName]: { ...memberBase, status: "ready" as const },
      },
    };

    // If they were busy, post a status event to the channel (with cooldown).
    // The render fires regardless of cooldown so the lead always gets a status
    // update — only the channel event is rate-limited.
    if (wasBusy) {
      // Use \x00 as separator to prevent key collisions between team names and
      // member names that contain underscores.
      const cooldownKey = `${team.name}\x00${memberName}`;
      const lastTime = lastNotified.get(cooldownKey) ?? 0;
      const elapsed = Date.now() - lastTime;
      const COOLDOWN_MS = 5_000;

      if (elapsed < COOLDOWN_MS) {
        // Queue the channel event; the render below still fires immediately.
        const delay = COOLDOWN_MS - elapsed;
        setTimeout(() => {
          lastNotified.set(cooldownKey, Date.now());
          appendEvent(team.name, {
            type: "status",
            sender: memberName,
            senderId: member.sessionId,
            content: `${memberName} is now ready`,
          }).catch((err) => {
            console.error(
              `[opencode-teams] Failed to post queued status event for ${memberName}:`,
              err,
            );
          });
        }, delay);
      } else {
        lastNotified.set(cooldownKey, Date.now());
        try {
          await appendEvent(team.name, {
            type: "status",
            sender: memberName,
            senderId: member.sessionId,
            content: `${memberName} is now ready`,
          });
        } catch (err) {
          console.error(
            `[opencode-teams] Failed to post status event for ${memberName}:`,
            err,
          );
        }
      }
    }

    // Send a plain-text team status summary to the lead.
    // Plain text (no ANSI escapes) so the model receives clean, readable context.
    try {
      await client.session.promptAsync({
        path: { id: team.leadSessionId },
        body: {
          parts: [
            { type: "text" as const, text: renderTeamStatusPlain(updatedTeam) },
          ],
        },
      });
    } catch (err) {
      console.error(
        `[opencode-teams] Failed to send team status to lead ${team.leadSessionId}:`,
        err,
      );
    }
  };
}
