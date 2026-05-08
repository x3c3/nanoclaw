/**
 * Helper to restart all running containers for an agent group.
 *
 * Used by:
 * - self-mod approval handlers (after config change)
 * - ncl config-update (after CLI config change)
 */
import { killContainer } from './container-runner.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { writeSessionMessage } from './session-manager.js';

/**
 * Kill all running containers for an agent group and schedule wake messages
 * so the host sweep respawns them with fresh config.
 */
export function restartAgentGroupContainers(agentGroupId: string, reason: string): void {
  const sessions = getSessionsByAgentGroup(agentGroupId).filter((s) => s.status === 'active');

  for (const session of sessions) {
    killContainer(session.id, reason);
    writeSessionMessage(agentGroupId, session.id, {
      id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: agentGroupId,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `Container restarted: ${reason}. Resuming.`,
        sender: 'system',
        senderId: 'system',
      }),
      processAfter: new Date(Date.now() + 5000)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ''),
    });
  }

  if (sessions.length > 0) {
    log.info('Restarted agent group containers', { agentGroupId, reason, count: sessions.length });
  }
}
