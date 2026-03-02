# NanoClaw Code Walkthrough

*2026-03-02T22:59:20Z by Showboat 0.6.1*
<!-- showboat-id: d9ad0cf2-6d98-44e2-bbce-9bbd3974062f -->

NanoClaw is a personal Claude assistant that connects to WhatsApp, routes messages through a polling loop, and executes Claude Agent SDK inside isolated Linux containers. The entire system is a single Node.js process plus containerized agents. Here's every file and how they fit together.

## Architecture at a Glance

The data flow is linear:

```
WhatsApp (baileys) → SQLite → Polling loop → GroupQueue → Container (Claude Agent SDK) → Response
```

There are 13 source files on the host side and 2 inside the container. We'll walk through them in the order data flows through the system: configuration → database → WhatsApp channel → orchestrator → message formatting → group queue → container spawning → agent execution → IPC → task scheduling.

```bash
find src container/agent-runner/src container/Dockerfile container/build.sh -name '*.ts' -o -name 'Dockerfile' -o -name 'build.sh' | sort
```

```output
container/Dockerfile
container/agent-runner/src/index.ts
container/agent-runner/src/ipc-mcp-stdio.ts
container/build.sh
src/channels/whatsapp.test.ts
src/channels/whatsapp.ts
src/config.ts
src/container-runner.test.ts
src/container-runner.ts
src/db.test.ts
src/db.ts
src/env.ts
src/formatting.test.ts
src/group-queue.test.ts
src/group-queue.ts
src/index.ts
src/ipc-auth.test.ts
src/ipc.ts
src/logger.ts
src/mount-security.ts
src/router.ts
src/routing.test.ts
src/task-scheduler.ts
src/types.ts
src/whatsapp-auth.ts
```

## 1. Configuration and Environment

Configuration starts in two files: `src/env.ts` reads the `.env` file, and `src/config.ts` exports every constant the system uses. A key design decision: **secrets are never loaded into `process.env`**. They stay on disk and are read only where needed (in `container-runner.ts`) to avoid leaking to child processes.

`src/env.ts` — A minimal .env parser that only returns values for explicitly requested keys. It never mutates `process.env`:

```bash
cat -n src/env.ts
```

```output
     1	import fs from 'fs';
     2	import path from 'path';
     3	
     4	/**
     5	 * Parse the .env file and return values for the requested keys.
     6	 * Does NOT load anything into process.env — callers decide what to
     7	 * do with the values. This keeps secrets out of the process environment
     8	 * so they don't leak to child processes.
     9	 */
    10	export function readEnvFile(keys: string[]): Record<string, string> {
    11	  const envFile = path.join(process.cwd(), '.env');
    12	  let content: string;
    13	  try {
    14	    content = fs.readFileSync(envFile, 'utf-8');
    15	  } catch {
    16	    return {};
    17	  }
    18	
    19	  const result: Record<string, string> = {};
    20	  const wanted = new Set(keys);
    21	
    22	  for (const line of content.split('\n')) {
    23	    const trimmed = line.trim();
    24	    if (!trimmed || trimmed.startsWith('#')) continue;
    25	    const eqIdx = trimmed.indexOf('=');
    26	    if (eqIdx === -1) continue;
    27	    const key = trimmed.slice(0, eqIdx).trim();
    28	    if (!wanted.has(key)) continue;
    29	    let value = trimmed.slice(eqIdx + 1).trim();
    30	    if (
    31	      (value.startsWith('"') && value.endsWith('"')) ||
    32	      (value.startsWith("'") && value.endsWith("'"))
    33	    ) {
    34	      value = value.slice(1, -1);
    35	    }
    36	    if (value) result[key] = value;
    37	  }
    38	
    39	  return result;
    40	}
```

`src/config.ts` — Exports every tunable constant. Note how it only reads non-secret keys (`ASSISTANT_NAME`, `ASSISTANT_HAS_OWN_NUMBER`) from the env file. The trigger pattern is built dynamically from the assistant name:

```bash
sed -n '1,16p' src/config.ts
```

```output
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

```

The rest of `config.ts` defines absolute paths for mounts and container settings. The trigger pattern is a regex built from the assistant name — if ASSISTANT_NAME is "Andy", messages must start with `@Andy` to wake the agent in non-main groups:

```bash
sed -n '28,66p' src/config.ts
```

```output
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
```

`src/logger.ts` — A thin wrapper around Pino. It also installs global handlers for uncaught exceptions and unhandled rejections so they get timestamps in stderr:

```bash
cat -n src/logger.ts
```

```output
     1	import pino from 'pino';
     2	
     3	export const logger = pino({
     4	  level: process.env.LOG_LEVEL || 'info',
     5	  transport: { target: 'pino-pretty', options: { colorize: true } },
     6	});
     7	
     8	// Route uncaught errors through pino so they get timestamps in stderr
     9	process.on('uncaughtException', (err) => {
    10	  logger.fatal({ err }, 'Uncaught exception');
    11	  process.exit(1);
    12	});
    13	
    14	process.on('unhandledRejection', (reason) => {
    15	  logger.error({ err: reason }, 'Unhandled rejection');
    16	});
```

## 2. Type Definitions and Database Layer

`src/types.ts` defines every interface the system uses. The two most important are `RegisteredGroup` (a WhatsApp group the agent listens in) and `NewMessage` (an inbound message). There's also a `Channel` interface — an abstraction that would let you swap WhatsApp for Telegram or anything else:

```bash
sed -n '35,53p' src/types.ts
```

```output
export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}
```

`src/db.ts` — All persistence runs through a single SQLite database (`store/messages.db`). The schema creates 7 tables and includes inline migrations for adding columns to existing installations. Here's the schema:

```bash
sed -n '10,77p' src/db.ts
```

```output
function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

```

The two key query functions are `getNewMessages` (used by the polling loop to find messages since a cursor) and `getMessagesSince` (used to build full context for the agent). Both filter out bot messages using a dual strategy — the `is_bot_message` column AND a content prefix check as a backstop for messages written before the migration:

```bash
sed -n '251,298p' src/db.ts
```

```output
export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}
```

## 3. WhatsApp Channel

`src/channels/whatsapp.ts` implements the `Channel` interface using the Baileys library (an unofficial WhatsApp Web client). It handles connection, reconnection, QR code auth, message reception, and sending. Messages are queued when disconnected and flushed on reconnect.

The constructor takes three callbacks — the orchestrator passes these in so the channel never needs to know about the database or group system directly:

```bash
sed -n '24,44p' src/channels/whatsapp.ts
```

```output
export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }
```

The `messages.upsert` handler is where inbound messages enter the system. It translates LID JIDs to phone JIDs (a WhatsApp multi-device quirk), notifies about chat metadata for group discovery, and only delivers full message content for registered groups. Bot messages are detected via the `is_from_me` flag or the assistant name prefix:

```bash
sed -n '147,196p' src/channels/whatsapp.ts
```

```output
    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Always notify about chat metadata for group discovery
        this.opts.onChatMetadata(chatJid, timestamp);

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          const content =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';
          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          const fromMe = msg.key.fromMe || false;
          // Detect bot messages: with own number, fromMe is reliable
          // since only the bot sends from that number.
          // With shared number, bot messages carry the assistant name prefix
          // (even in DMs/self-chat) so we check for that.
          const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
            ? fromMe
            : content.startsWith(`${ASSISTANT_NAME}:`);

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
          });
        }
      }
    });
```

Outbound messages are prefixed with the assistant name (e.g. `Andy: ...`) when the bot shares a phone number with the user. This prefix is what the inbound bot-detection logic checks for. When disconnected, messages queue up and flush on reconnect:

```bash
sed -n '199,221p' src/channels/whatsapp.ts
```

```output
  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info({ jid, length: prefixed.length, queueSize: this.outgoingQueue.length }, 'WA disconnected, message queued');
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send, message queued');
    }
  }
```

## 4. Message Formatting

`src/router.ts` converts messages into an XML format that gets sent to the agent as its prompt. Each message becomes a `<message>` tag with the sender name and timestamp. The agent's responses pass through `formatOutbound` which strips `<internal>...</internal>` tags — a mechanism for the agent to think aloud without the user seeing it:

```bash
cat -n src/router.ts
```

```output
     1	import { Channel, NewMessage } from './types.js';
     2	
     3	export function escapeXml(s: string): string {
     4	  if (!s) return '';
     5	  return s
     6	    .replace(/&/g, '&amp;')
     7	    .replace(/</g, '&lt;')
     8	    .replace(/>/g, '&gt;')
     9	    .replace(/"/g, '&quot;');
    10	}
    11	
    12	export function formatMessages(messages: NewMessage[]): string {
    13	  const lines = messages.map((m) =>
    14	    `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
    15	  );
    16	  return `<messages>\n${lines.join('\n')}\n</messages>`;
    17	}
    18	
    19	export function stripInternalTags(text: string): string {
    20	  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
    21	}
    22	
    23	export function formatOutbound(rawText: string): string {
    24	  const text = stripInternalTags(rawText);
    25	  if (!text) return '';
    26	  return text;
    27	}
    28	
    29	export function routeOutbound(
    30	  channels: Channel[],
    31	  jid: string,
    32	  text: string,
    33	): Promise<void> {
    34	  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
    35	  if (!channel) throw new Error(`No channel for JID: ${jid}`);
    36	  return channel.sendMessage(jid, text);
    37	}
    38	
    39	export function findChannel(
    40	  channels: Channel[],
    41	  jid: string,
    42	): Channel | undefined {
    43	  return channels.find((c) => c.ownsJid(jid));
    44	}
```

## 5. The Orchestrator — `src/index.ts`

This is the heart of NanoClaw. The `main()` function boots the entire system in sequence: ensure container runtime → init database → load persisted state → connect WhatsApp → start subsystems → start polling. Let's trace the startup:

```bash
sed -n '450,498p' src/index.ts
```

```output
async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    await whatsapp.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Create WhatsApp channel
  whatsapp = new WhatsAppChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
    registeredGroups: () => registeredGroups,
  });

  // Connect — resolves when first connected
  await whatsapp.connect();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await whatsapp.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => whatsapp.sendMessage(jid, text),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp.syncGroupMetadata(force),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}
```

Notice the dependency injection pattern: each subsystem receives closures rather than importing state directly. The `queue.setProcessMessagesFn(processGroupMessages)` line is how the GroupQueue calls back to actually process messages — we'll see that next.

The `ensureContainerSystemRunning()` function also cleans up orphaned containers from previous runs (containers whose names start with `nanoclaw-`):

```bash
sed -n '427,448p' src/index.ts
```

```output
  // Kill and clean up orphaned NanoClaw containers from previous runs
  try {
    const output = execSync('container ls --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] = JSON.parse(output || '[]');
    const orphans = containers
      .filter((c) => c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'))
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(`container stop ${name}`, { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
```

### The Message Loop

The polling loop runs every 2 seconds. It fetches new messages from all registered groups since the last cursor, deduplicates by group, and either pipes them into an already-running container or enqueues them in the GroupQueue for a new container.

The key insight is the **two-cursor system**: `lastTimestamp` tracks the global "seen" cursor (advanced immediately), while `lastAgentTimestamp[chatJid]` tracks the per-group "processed by agent" cursor (advanced only after the agent succeeds). This separation allows non-trigger messages to accumulate as context between triggers:

```bash
sed -n '287,368p' src/index.ts
```

```output
async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            whatsapp.setTyping(chatJid, true);
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}
```

### Processing Group Messages

When the GroupQueue triggers message processing for a group, `processGroupMessages` runs. It re-fetches messages since the per-group cursor, checks for triggers, formats them, runs the agent, and manages the cursor with rollback-on-error semantics. The idle timer closes stdin if the agent produces no output for 30 minutes:

```bash
sed -n '120,206p' src/index.ts
```

```output
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await whatsapp.setTyping(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await whatsapp.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await whatsapp.setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}
```

## 6. Group Queue and Concurrency Control

`src/group-queue.ts` manages how many containers run simultaneously and queues work when at capacity. It also handles piping messages into active containers and graceful shutdown. The default concurrency limit is 5 containers.

Each group gets its own state tracking active/pending status, and there's a global waiting list for groups that couldn't start because the limit was reached:

```bash
sed -n '8,53p' src/group-queue.ts
```

```output
interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
```

The `sendMessage` method is how the polling loop pipes follow-up messages into an already-running container. It writes a JSON file to the IPC input directory. If no container is active, it returns false and the caller falls back to `enqueueMessageCheck` which spawns a new one:

```bash
sed -n '122,158p' src/group-queue.ts
```

```output
  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return false;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }
```

After a container finishes, `drainGroup` checks for remaining work: first pending tasks (since they won't be rediscovered from SQLite), then pending messages, then other waiting groups. This creates a fair scheduling system — no group starves:

```bash
sed -n '243,282p' src/group-queue.ts
```

```output
  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task);
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain');
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task);
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain');
      }
      // If neither pending, skip this group
    }
  }
```

## 7. Container Runner

`src/container-runner.ts` is where the host spawns actual Linux containers. It builds the volume mount list, constructs the `container run` command, passes secrets via stdin, and parses streaming output using sentinel markers.

### Volume Mounts

The mount strategy enforces isolation: the main group gets the full project root mounted, while other groups only see their own folder. Every group gets an isolated `.claude/` directory (for session persistence) and an isolated IPC namespace:

```bash
sed -n '60,101p' src/container-runner.ts
```

```output
function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Apple Container only supports directory mounts, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

```

### Secrets Handling

Secrets (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) are read from `.env` only at container spawn time, passed via stdin JSON, and immediately deleted from the input object so they never appear in logs. Inside the container, a PreToolUse hook strips them from Bash subprocesses:

```bash
sed -n '184,210p' src/container-runner.ts
```

```output
/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}

function buildContainerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Apple Container: --mount for readonly, -v for read-write
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      );
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}
```

### Streaming Output Protocol

The container runner parses stdout in real-time looking for sentinel marker pairs (`---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---`). Each pair wraps a JSON object with status, result text, and optionally a new session ID. This allows the agent's responses to stream to WhatsApp as they're produced, rather than waiting for the container to finish:

```bash
sed -n '273,328p' src/container-runner.ts
```

```output
    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });
```

### Mount Security

`src/mount-security.ts` validates any additional directory mounts against an allowlist stored at `~/.config/nanoclaw/mount-allowlist.json` — critically, **outside** the project root so container agents can't tamper with it. It blocks sensitive paths like `.ssh`, `.aws`, `.gnupg`, `.env`, `credentials`, etc:

```bash
sed -n '28,46p' src/mount-security.ts
```

```output
const DEFAULT_BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  'credentials',
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'private_key',
  '.secret',
];
```

## 8. Inside the Container — Agent Runner

Now we cross the container boundary. `container/agent-runner/src/index.ts` is what runs inside the Linux VM. It reads the JSON input from stdin, invokes the Claude Agent SDK, and writes results back to stdout using the sentinel markers.

### The MessageStream

The agent runner uses an AsyncIterable called `MessageStream` to feed messages to the SDK. This is key because it keeps `isSingleUserTurn=false`, which enables agent teams (subagent orchestration). IPC messages from the host get pushed into the stream during the query:

```bash
sed -n '64,95p' container/agent-runner/src/index.ts
```

```output
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}
```

```bash
sed -n '64,95p' container/agent-runner/src/index.ts
```

```output
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}
```

### The Query Loop

The agent runner has an outer loop: run a query → wait for the next IPC message → run another query with the same session. This is how follow-up messages work — the container stays alive between messages, maintaining context. The `_close` sentinel file signals time to exit:

```bash
sed -n '537,584p' container/agent-runner/src/index.ts
```

```output
  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
```

### SDK Configuration

The `runQuery` function configures the Claude Agent SDK with full tool access (Bash, file ops, web, agent teams), a custom MCP server for NanoClaw-specific tools, and hooks for security. The `permissionMode: 'bypassPermissions'` is safe because the code runs inside an isolated container:

```bash
sed -n '416,456p' container/agent-runner/src/index.ts
```

```output
  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook()] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
      },
    }
  })) {
```

### The Bash Sanitization Hook

A critical security measure: the `createSanitizeBashHook` prepends `unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN` to every Bash command the agent runs. This prevents the agent from accessing API keys through environment variables — they're only available to the SDK itself:

```bash
sed -n '187,209p' container/agent-runner/src/index.ts
```

```output
// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}
```

## 9. IPC — The Bridge Between Host and Container

Communication between the host process and containers happens through the filesystem. There are two sides:

**Inside the container** — `container/agent-runner/src/ipc-mcp-stdio.ts` is an MCP server that gives the agent tools like `send_message`, `schedule_task`, `register_group`, etc. These tools write JSON files to the IPC directories.

**On the host** — `src/ipc.ts` polls those directories every second, reads the files, authorizes the action, and executes it.

Here are the MCP tools the agent has access to:

```bash
grep -n 'server.tool(' container/agent-runner/src/ipc-mcp-stdio.ts | head -20
```

```output
42:server.tool(
65:server.tool(
146:server.tool(
184:server.tool(
203:server.tool(
222:server.tool(
241:server.tool(
```

```bash
grep -A2 'server.tool(' container/agent-runner/src/ipc-mcp-stdio.ts
```

```output
server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
--
server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.
--
server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
--
server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
--
server.tool(
  'resume_task',
  'Resume a paused task.',
--
server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
--
server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.
```

The IPC writes use atomic file operations (write to .tmp, then rename) to prevent partial reads. The MCP server gets its identity from environment variables set by the agent runner:

On the host side, `src/ipc.ts` processes these files with authorization checks. The key principle: **identity comes from the directory path, not from the file contents**. The agent writes to `/workspace/ipc/` which maps to `data/ipc/{groupFolder}/` on the host. The host uses the directory name as the verified identity:

```bash
sed -n '43,107p' src/ipc.ts
```

```output
  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
```

## 10. Task Scheduler

`src/task-scheduler.ts` runs a loop every 60 seconds checking for tasks whose `next_run` time has passed. Tasks support three schedule types: `cron` (recurring at specific times), `interval` (every N milliseconds), and `once` (run once at a specific time). After running, it calculates the next run time and updates the database:

Tasks have a `context_mode` that determines session handling. In `group` mode the task resumes the group's existing session (with conversation history). In `isolated` mode it starts fresh:

```bash
sed -n '182,218p' src/task-scheduler.ts
```

```output
export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          () => runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
```

```bash
sed -n '86,92p' src/task-scheduler.ts
```

```output

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // Idle timer: writes _close sentinel after IDLE_TIMEOUT of no output,
```

## 11. The Container Image

`container/Dockerfile` builds the agent container on `node:22-slim`. It installs Chromium (for the `agent-browser` skill), Git, and the Claude Agent SDK globally. The entrypoint script recompiles the agent-runner TypeScript on every start to bypass Docker's build cache for code changes:

```bash
cat -n container/Dockerfile
```

```output
     1	# NanoClaw Agent Container
     2	# Runs Claude Agent SDK in isolated Linux VM with browser automation
     3	
     4	FROM node:22-slim
     5	
     6	# Install system dependencies for Chromium
     7	RUN apt-get update && apt-get install -y \
     8	    chromium \
     9	    fonts-liberation \
    10	    fonts-noto-color-emoji \
    11	    libgbm1 \
    12	    libnss3 \
    13	    libatk-bridge2.0-0 \
    14	    libgtk-3-0 \
    15	    libx11-xcb1 \
    16	    libxcomposite1 \
    17	    libxdamage1 \
    18	    libxrandr2 \
    19	    libasound2 \
    20	    libpangocairo-1.0-0 \
    21	    libcups2 \
    22	    libdrm2 \
    23	    libxshmfence1 \
    24	    curl \
    25	    git \
    26	    && rm -rf /var/lib/apt/lists/*
    27	
    28	# Set Chromium path for agent-browser
    29	ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
    30	ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
    31	
    32	# Install agent-browser and claude-code globally
    33	RUN npm install -g agent-browser @anthropic-ai/claude-code
    34	
    35	# Create app directory
    36	WORKDIR /app
    37	
    38	# Copy package files first for better caching
    39	COPY agent-runner/package*.json ./
    40	
    41	# Install dependencies
    42	RUN npm install
    43	
    44	# Copy source code
    45	COPY agent-runner/ ./
    46	
    47	# Build TypeScript
    48	RUN npm run build
    49	
    50	# Create workspace directories
    51	RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input
    52	
    53	# Create entrypoint script
    54	# Secrets are passed via stdin JSON — temp file is deleted immediately after Node reads it
    55	# Follow-up messages arrive via IPC files in /workspace/ipc/input/
    56	RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh
    57	
    58	# Set ownership to node user (non-root) for writable directories
    59	RUN chown -R node:node /workspace
    60	
    61	# Switch to non-root user (required for --dangerously-skip-permissions)
    62	USER node
    63	
    64	# Set working directory to group workspace
    65	WORKDIR /workspace/group
    66	
    67	# Entry point reads JSON from stdin, outputs JSON to stdout
    68	ENTRYPOINT ["/app/entrypoint.sh"]
```

The entrypoint script does something clever on line 56: it recompiles the agent-runner TypeScript to `/tmp/dist` on every container start, then makes the output read-only. Since the host mounts `container/agent-runner/src/` into the container at `/app/src` (read-only), code changes take effect without rebuilding the image. The compiled output goes to `/tmp/dist` so the original `/app` directory stays intact.

## 12. Security Model Summary

NanoClaw's security is layered:

**Container isolation** — Agents run inside Linux VMs (Apple Container or Docker). They can only see explicitly mounted directories. Bash commands execute inside the container, not on the host.

**Per-group IPC namespaces** — Each group's container writes to its own `data/ipc/{groupFolder}/` directory. The host verifies identity from the directory path, not from file contents. Non-main groups can only send messages to their own group and manage their own tasks.

**Secret management** — API keys are never in `process.env`, never written to disk as files, never mounted into containers. They flow: `.env` file → `readEnvFile()` → stdin JSON → `sdkEnv` object → `unset` in every Bash subprocess.

**Mount allowlist** — Additional mounts are validated against `~/.config/nanoclaw/mount-allowlist.json`, stored outside the project root so agents can't modify it. Sensitive paths (.ssh, .aws, .env, etc.) are always blocked.

**Main vs. non-main groups** — The main group (your self-chat) has full admin access: it sees all tasks, can register new groups, gets the project root mounted. Other groups are sandboxed to their own folder and can only interact with their own data.

## 13. End-to-End: A Message's Journey

To tie it all together, here's what happens when someone sends `@Andy what's the weather?` in a WhatsApp group:

1. **Baileys** receives the WebSocket message → `whatsapp.ts` `messages.upsert` handler fires
2. The handler calls `onMessage(chatJid, msg)` → `storeMessage(msg)` writes it to SQLite
3. **Polling loop** (`index.ts` `startMessageLoop`) runs every 2s → `getNewMessages()` finds the new message
4. The message starts with `@Andy` so `TRIGGER_PATTERN` matches → it passes the trigger check
5. All messages since `lastAgentTimestamp[chatJid]` are fetched for context → `formatMessages()` wraps them in XML
6. No active container → `queue.enqueueMessageCheck(chatJid)` is called
7. **GroupQueue** has capacity → calls `processGroupMessages(chatJid)`
8. The cursor is advanced, the idle timer starts, typing indicator goes on
9. `runAgent()` builds task/group snapshots → `runContainerAgent()` builds mounts → `container run` spawns the VM
10. **Inside the container**: entrypoint recompiles TypeScript → agent-runner reads JSON from stdin → calls `query()` from Claude Agent SDK
11. The SDK uses the agent's tools (Bash, Read, WebSearch, etc.) plus the NanoClaw MCP server (`send_message`, `schedule_task`, etc.)
12. When the agent produces a result, `writeOutput()` wraps it in sentinel markers → stdout
13. **Back on the host**: `container.stdout.on('data')` parses the markers → `onOutput` callback fires → `whatsapp.sendMessage(chatJid, text)` sends the reply
14. The container stays alive waiting for the next IPC message or the idle timeout
15. After 30 minutes of no activity, `_close` sentinel is written → container exits → GroupQueue runs `drainGroup()`

```bash
wc -l src/*.ts src/channels/*.ts container/agent-runner/src/*.ts | tail -1
```

```output
  7253 total
```

```bash
wc -l src/*.ts src/channels/*.ts container/agent-runner/src/*.ts | grep -v test | grep -v total
```

```output
    65 src/config.ts
   643 src/container-runner.ts
   605 src/db.ts
    40 src/env.ts
   302 src/group-queue.ts
   510 src/index.ts
   379 src/ipc.ts
    16 src/logger.ts
   418 src/mount-security.ts
    44 src/router.ts
   218 src/task-scheduler.ts
    98 src/types.ts
   157 src/whatsapp-auth.ts
   324 src/channels/whatsapp.ts
   587 container/agent-runner/src/index.ts
   279 container/agent-runner/src/ipc-mcp-stdio.ts
```

That's 4,685 lines of production TypeScript (excluding tests). The entire system — from WhatsApp connection to container isolation to agent execution to task scheduling — in under 5,000 lines.
