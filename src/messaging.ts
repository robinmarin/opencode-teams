import type { PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import type { Logger } from "./logger.js";
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

// Per-session promise chain — serialises concurrent events for the same session
// so that a session.status(busy) arriving at the same ms as session.idle never
// clobbers the "ready" state written by the idle handler.
const sessionQueues = new Map<string, Promise<void>>();

function withSessionQueue(sessionId: string, fn: () => Promise<void>): void {
  const current = sessionQueues.get(sessionId) ?? Promise.resolve();
  const next = current.then(fn).catch(() => {
    // errors are already caught and logged inside fn
  });
  sessionQueues.set(sessionId, next);
}

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
type GetLogger = (client: Client, teamName: string) => Logger;

export function createEventHandler(
  client: Client,
  getLogger: GetLogger,
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
    const indexSize = sessionIndexSize();
    if (indexSize > 0 && !isKnownSession(sessionID)) return;

    console.debug(
      `[opencode-teams] event=${event.type} sessionID=${sessionID} indexSize=${indexSize}`,
    );

    // Serialise all events for the same session through a per-session queue.
    // This prevents concurrent session.status(busy) and session.idle events
    // from racing each other and clobbering the "ready" status on disk.
    withSessionQueue(sessionID, () => handleEvent(client, getLogger, event, sessionID));
  };
}

async function handleEvent(
  client: Client,
  getLogger: GetLogger,
  event: Event,
  sessionID: string,
): Promise<void> {

    let found: Awaited<ReturnType<typeof findTeamBySession>>;
    try {
      found = await findTeamBySession(sessionID);
    } catch (err) {
      console.error("[opencode-teams] error in findTeamBySession:", err);
      return;
    }

    if (found === null) {
      console.debug(
        `[opencode-teams] session ${sessionID} not found in any team; ignoring`,
      );
      return;
    }

    const { team, memberName } = found;
    const log = getLogger(client, team.name);

    log.debug("messaging", `event received`, {
      eventType: event.type,
      sessionId: sessionID,
      memberName,
      teamName: team.name,
    });

    // Defensive check: verify sessionId in the index still matches team config
    const indexedMember = team.members[memberName];
    if (indexedMember && indexedMember.sessionId !== sessionID) {
      log.warn("messaging", "session index drift detected; skipping event", {
        memberName,
        expectedSessionId: indexedMember.sessionId,
        receivedSessionId: sessionID,
      });
      return;
    }

    // Lead session — handle anti-loop guard
    if (memberName === LEAD_MEMBER_NAME) {
      // session.status for lead is always ignored (idle transitions handled by session.idle)
      if (event.type === "session.status") {
        log.debug("messaging", "lead session.status ignored (anti-loop)", {
          sessionId: sessionID,
        });
        return;
      }

      // Lead idle: check if members are still busy/retrying
      const busyMembers = Object.entries(team.members).filter(
        ([name, m]) =>
          name !== LEAD_MEMBER_NAME &&
          (m.status === "busy" || m.status === "retrying"),
      );

      log.debug("messaging", "lead went idle", {
        sessionId: sessionID,
        busyMemberCount: busyMembers.length,
        busyMembers: busyMembers.map(([n]) => n),
      });

      if (busyMembers.length > 0) {
        const content = `Lead idle — ${busyMembers.length} member(s) still busy`;

        // Post system event to channel so lead sees it in team history
        try {
          await appendEvent(team.name, {
            type: "system",
            sender: LEAD_MEMBER_NAME,
            senderId: sessionID,
            content,
          });
          log.debug("messaging", "posted lead-idle system event to channel");
        } catch (err) {
          log.error("messaging", "failed to post lead-idle system event", {
            error: String(err),
          });
        }

        // Surface to lead via promptAsync (plain text)
        log.debug("messaging", "prompting lead about busy members", {
          leadSessionId: team.leadSessionId,
          busyMemberCount: busyMembers.length,
        });
        try {
          const result = await client.session.promptAsync({
            path: { id: team.leadSessionId },
            body: {
              parts: [{ type: "text" as const, text: content }],
            },
          });
          if (result.error !== undefined) {
            log.error("messaging", "promptAsync returned error for lead", {
              leadSessionId: team.leadSessionId,
              error: JSON.stringify(result.error),
            });
          } else {
            log.info("messaging", "lead notified of busy members", {
              leadSessionId: team.leadSessionId,
            });
          }
        } catch (err) {
          log.error("messaging", "promptAsync threw for lead (busy-members notice)", {
            leadSessionId: team.leadSessionId,
            error: String(err),
          });
        }
      }
      return;
    }

    const member = team.members[memberName];
    if (member === undefined) {
      log.warn("messaging", "member found by session index but missing from team config", {
        memberName,
        sessionId: sessionID,
      });
      return;
    }

    // -----------------------------------------------------------------------
    // session.status — update member status silently; no lead notification.
    // Idle transitions are handled by session.idle below.
    // -----------------------------------------------------------------------
    if (event.type === "session.status") {
      const { status } = event.properties;
      if (status.type === "idle") {
        log.debug("messaging", "session.status idle ignored; waiting for session.idle", {
          memberName,
          sessionId: sessionID,
        });
        return;
      }

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

      log.debug("messaging", "updating member status from session.status", {
        memberName,
        previousStatus: member.status,
        newStatus,
        sessionId: sessionID,
      });
      try {
        await updateMember(team.name, memberName, patch, clearFields);
        log.info("messaging", "member status updated", {
          memberName,
          newStatus,
        });
      } catch (err) {
        log.error("messaging", "failed to update member status", {
          memberName,
          newStatus,
          error: String(err),
        });
      }
      return;
    }

    // -----------------------------------------------------------------------
    // session.idle
    // -----------------------------------------------------------------------
    const wasBusy = member.status === "busy" || member.status === "retrying";

    log.info("messaging", "member session idle", {
      memberName,
      sessionId: sessionID,
      previousStatus: member.status,
      wasBusy,
      leadSessionId: team.leadSessionId,
    });

    // Update member status to ready; clear any retry context
    try {
      await updateMember(team.name, memberName, { status: "ready" }, [
        "retryAttempt",
        "retryNextMs",
        "currentTask",
      ]);
      log.debug("messaging", "member status set to ready", { memberName });
    } catch (err) {
      log.error("messaging", "failed to set member status to ready", {
        memberName,
        error: String(err),
      });
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

      log.debug("messaging", "cooldown check for status event", {
        memberName,
        elapsedMs: elapsed,
        cooldownMs: COOLDOWN_MS,
        withinCooldown: elapsed < COOLDOWN_MS,
      });

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
            log.error("messaging", "failed to post queued status event", {
              memberName,
              error: String(err),
            });
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
          log.debug("messaging", "status event posted to channel", { memberName });
        } catch (err) {
          log.error("messaging", "failed to post status event to channel", {
            memberName,
            error: String(err),
          });
        }
      }
    }

    // Only notify the lead when the member was actually busy before going idle.
    // If the member was already ready (e.g. a duplicate session.idle event fired
    // while a concurrent handler already processed it), skip — the lead was
    // already notified by the first handler and there is nothing new to report.
    if (!wasBusy) {
      log.debug("messaging", "skipping lead notification — member was not busy", {
        memberName,
      });
      return;
    }

    // Send a plain-text team status summary to the lead.
    // Plain text (no ANSI escapes) so the model receives clean, readable context.
    log.debug("messaging", "sending team status to lead via promptAsync", {
      memberName,
      leadSessionId: team.leadSessionId,
    });
    try {
      const result = await client.session.promptAsync({
        path: { id: team.leadSessionId },
        body: {
          parts: [
            { type: "text" as const, text: renderTeamStatusPlain(updatedTeam) },
          ],
        },
      });
      if (result.error !== undefined) {
        log.error("messaging", "promptAsync returned error when notifying lead", {
          memberName,
          leadSessionId: team.leadSessionId,
          error: JSON.stringify(result.error),
        });
      } else {
        log.info("messaging", "lead notified of member idle", {
          memberName,
          leadSessionId: team.leadSessionId,
        });
      }
    } catch (err) {
      log.error("messaging", "promptAsync threw when notifying lead", {
        memberName,
        leadSessionId: team.leadSessionId,
        error: String(err),
      });
    }
}
