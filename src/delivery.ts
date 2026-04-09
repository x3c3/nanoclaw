/**
 * Outbound message delivery.
 * Polls active session DBs for undelivered messages_out, delivers through channel adapters.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { getRunningSessions, getActiveSessions, createPendingQuestion } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
import { openSessionDb, sessionDir } from './session-manager.js';
import { resetContainerIdleTimer } from './container-runner-v2.js';
import type { OutboundFile } from './channels/adapter.js';
import type { Session } from './types-v2.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
  ): Promise<void>;
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    const sessions = getRunningSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(pollSweep, SWEEP_POLL_MS);
}

async function deliverSessionMessages(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let db: Database.Database;
  try {
    db = openSessionDb(agentGroup.id, session.id);
  } catch {
    return; // Session DB might not exist yet
  }

  try {
    const undelivered = db
      .prepare(
        `SELECT * FROM messages_out
         WHERE delivered = 0
           AND (deliver_after IS NULL OR deliver_after <= datetime('now'))
         ORDER BY timestamp ASC`,
      )
      .all() as Array<{
      id: string;
      kind: string;
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
      content: string;
    }>;

    if (undelivered.length === 0) return;

    for (const msg of undelivered) {
      try {
        await deliverMessage(msg, session);
        db.prepare('UPDATE messages_out SET delivered = 1 WHERE id = ?').run(msg.id);
        resetContainerIdleTimer(session.id);
      } catch (err) {
        log.error('Failed to deliver message', { messageId: msg.id, sessionId: session.id, err });
      }
    }
  } finally {
    db.close();
  }
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
  },
  session: Session,
): Promise<void> {
  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return;
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally
  if (msg.kind === 'system') {
    log.info('System action from agent', { sessionId: session.id, action: content.action });
    // TODO: handle system actions (register_group, reset_session, etc.)
    return;
  }

  // Agent-to-agent — route to target session
  if (msg.channel_type === 'agent') {
    log.info('Agent-to-agent message', { from: session.id, target: msg.platform_id });
    // TODO: route to target agent's session DB
    return;
  }

  // Track pending questions for ask_user_question flow
  if (content.type === 'ask_question' && content.questionId) {
    createPendingQuestion({
      question_id: content.questionId,
      session_id: session.id,
      message_out_id: msg.id,
      platform_id: msg.platform_id,
      channel_type: msg.channel_type,
      thread_id: msg.thread_id,
      created_at: new Date().toISOString(),
    });
    log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
  }

  // Channel delivery
  if (!msg.channel_type || !msg.platform_id) {
    log.warn('Message missing routing fields', { id: msg.id });
    return;
  }

  // Read file attachments from outbox if the content declares files
  let files: OutboundFile[] | undefined;
  const outboxDir = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', msg.id);
  if (Array.isArray(content.files) && content.files.length > 0 && fs.existsSync(outboxDir)) {
    files = [];
    for (const filename of content.files as string[]) {
      const filePath = path.join(outboxDir, filename);
      if (fs.existsSync(filePath)) {
        files.push({ filename, data: fs.readFileSync(filePath) });
      } else {
        log.warn('Outbox file not found', { messageId: msg.id, filename });
      }
    }
    if (files.length === 0) files = undefined;
  }

  await deliveryAdapter.deliver(msg.channel_type, msg.platform_id, msg.thread_id, msg.kind, msg.content, files);
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
    fileCount: files?.length,
  });

  // Clean up outbox directory after successful delivery
  if (fs.existsSync(outboxDir)) {
    fs.rmSync(outboxDir, { recursive: true, force: true });
  }
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}
