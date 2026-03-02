# NanoClaw Code Walkthrough

*2026-03-02T23:01:50Z by Showboat 0.6.1*
<!-- showboat-id: ea174576-0c3b-4b71-a846-4fa808d4f801 -->

NanoClaw is a personal Claude assistant that connects to WhatsApp and routes messages to Claude Agent SDK running inside isolated Linux containers. The entire system is a single Node.js process — no microservices, no message queues, no abstraction layers. Each WhatsApp group gets its own container with an isolated filesystem and memory, so groups can't see each other's data.

This walkthrough traces the code linearly: from startup, through receiving a WhatsApp message, all the way to the agent running in a container and sending a reply back. By the end you'll understand every moving part.

## Architecture at a Glance

The data flows through the system like this:

```
WhatsApp (Baileys) ──► SQLite DB ──► Polling Loop ──► Container (Claude Agent SDK) ──► Response
                         ▲                                    │
                         │                                    ▼
                     Messages                          IPC (filesystem)
                     Groups                            ──► send_message
                     Sessions                          ──► schedule_task
                     Tasks                             ──► register_group
```

Key files and what they do:

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: startup, state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection via Baileys, send/receive |
| `src/db.ts` | SQLite: messages, groups, sessions, tasks, state |
| `src/router.ts` | Format messages into XML for the agent, strip internal tags on output |
| `src/group-queue.ts` | Per-group queue with global concurrency limit |
| `src/container-runner.ts` | Spawn Apple Container / Docker with proper mounts |
| `src/ipc.ts` | File-based IPC: containers write JSON files, host polls and processes |
| `src/task-scheduler.ts` | Poll for due tasks, run them in containers |
| `src/mount-security.ts` | Validate additional mounts against external allowlist |
| `container/agent-runner/src/index.ts` | Runs inside the container: receives prompt, calls Claude SDK |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP server: tools the agent uses (send_message, schedule_task, etc.) |

## 1. Startup: `src/index.ts` — `main()`

Everything begins in `main()`. It runs four setup steps in sequence, then kicks off three concurrent subsystems. Let's see the function:

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

Here's what each step does:

1. **`ensureContainerSystemRunning()`** — Checks that Apple Container (or Docker) is running. Kills any orphaned `nanoclaw-*` containers left over from previous crashes.

2. **`initDatabase()`** — Opens (or creates) the SQLite database at `store/messages.db`, runs schema migrations.

3. **`loadState()`** — Loads persisted cursors (`lastTimestamp`, `lastAgentTimestamp`), session IDs, and registered groups from the database into memory.

4. **WhatsApp connect** — Creates a `WhatsAppChannel` with three callbacks: one to store messages, one to store chat metadata (for group discovery), and one that returns the current registered groups. Waits for the first successful connection before continuing.

5. **Start subsystems** — Three independent loops begin running concurrently:
   - **Scheduler loop** — Polls every 60s for due scheduled tasks
   - **IPC watcher** — Polls every 1s for JSON files written by containers
   - **Message loop** — Polls every 2s for new WhatsApp messages to process

The `GroupQueue` ties everything together: `queue.setProcessMessagesFn(processGroupMessages)` tells it what function to call when a group needs processing.

## 2. Configuration: `src/config.ts`

All configuration lives in one file. No YAML, no JSON config — just constants and environment variable overrides.

```bash
cat src/config.ts
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

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
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

The important things to notice:

- **`ASSISTANT_NAME`** defaults to `"Andy"` — this is the trigger word. Messages starting with `@Andy` wake up the bot.
- **`TRIGGER_PATTERN`** is built dynamically as `/^@Andy\b/i` — case-insensitive, word-boundary match.
- **Secrets stay on disk.** The comment at line 5 is key: `readEnvFile()` reads `.env` but does NOT load values into `process.env`. Secrets like API keys are only read at the moment they're needed (in `container-runner.ts`), passed via stdin to the container, then discarded.
- **`POLL_INTERVAL = 2000`** — the message loop checks for new messages every 2 seconds.
- **`IDLE_TIMEOUT = 1800000`** (30 minutes) — how long a container stays alive after its last output, waiting for follow-up messages.
- **`MAX_CONCURRENT_CONTAINERS = 5`** — at most 5 containers running simultaneously.
- **`MAIN_GROUP_FOLDER = 'main'`** — the privileged group. It can see all other groups, schedule tasks anywhere, and register new groups.

## 3. WhatsApp Channel: `src/channels/whatsapp.ts`

This is the I/O layer. It uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web API client. The `WhatsAppChannel` class implements the `Channel` interface, making it swappable with Telegram or other channels.

### Connection and Authentication

```bash
sed -n '52,66p' src/channels/whatsapp.ts
```

```output
  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });
```

Auth state is stored in `store/auth/`. If the user hasn't authenticated, Baileys generates a QR code — but NanoClaw doesn't handle it inline. Instead it fires a macOS notification telling the user to run `/setup`:

```bash
sed -n '71,79p' src/channels/whatsapp.ts
```

```output
      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }
```

### Receiving Messages

When WhatsApp delivers a message, the `messages.upsert` event fires. Here's where inbound messages get processed:

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

Two important things happen here:

1. **`onChatMetadata` is called for ALL messages** — even from unregistered groups. This is how NanoClaw discovers groups you're in, so the main channel can later register them.

2. **`onMessage` is only called for registered groups** — messages from unregistered groups are ignored (their metadata is still stored for discovery).

The bot-message detection logic handles two scenarios: if the bot has its own WhatsApp number, `fromMe` is reliable. If it shares a number with the user, it checks whether the message starts with `"Andy:"` (the prefix it adds to outgoing messages).

### Sending Messages

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

Notice the outgoing queue: if WhatsApp is disconnected, messages are buffered and flushed on reconnect. This prevents message loss during network interruptions.

## 4. Database Layer: `src/db.ts`

All persistent state lives in a single SQLite database (`store/messages.db`). Here's the schema:

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

Seven tables, each with a clear purpose:

- **`chats`** — Every WhatsApp group/chat NanoClaw has seen (even unregistered ones). Used for group discovery.
- **`messages`** — Full message history for registered groups. The `is_bot_message` flag prevents the bot from responding to its own messages.
- **`scheduled_tasks`** — Task definitions: what to do, when to do it, which group owns it.
- **`task_run_logs`** — Execution history for debugging: when it ran, how long, what happened.
- **`router_state`** — Key-value store for cursors: `last_timestamp` (global) and `last_agent_timestamp` (per-group JSON).
- **`sessions`** — Maps group folders to Claude Agent SDK session IDs for conversation continuity.
- **`registered_groups`** — Which groups are active. The `folder` column maps to the filesystem (`groups/{folder}/`).

### Message Queries

The two critical query functions are `getNewMessages` (used by the polling loop) and `getMessagesSince` (used when processing a group):

```bash
sed -n '251,279p' src/db.ts
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
```

Notice the double filter for bot messages: `is_bot_message = 0 AND content NOT LIKE ?`. The `LIKE` clause catches messages written before the `is_bot_message` column was added (backward-compatible migration).

## 5. The Message Loop: `src/index.ts` — `startMessageLoop()`

This is the heart of the system. Every 2 seconds, it polls the database for new messages across all registered groups:

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

This is dense but elegant. Here's the flow:

1. **Poll** — `getNewMessages()` fetches all messages since `lastTimestamp` across all registered groups.

2. **Advance cursor immediately** — `lastTimestamp` is bumped right away, so even if processing fails, these messages won't be re-fetched on the next poll. (The per-group cursor `lastAgentTimestamp` provides the safety net for retries.)

3. **Group deduplication** — Messages are bucketed by `chat_jid`. Each group is processed independently.

4. **Trigger check** — The main group always processes. Other groups require `@Andy` at the start of a message (unless `requiresTrigger` is `false`). Non-trigger messages silently accumulate in the DB — they become context when a trigger eventually arrives.

5. **Context accumulation** — When a trigger fires, `getMessagesSince(lastAgentTimestamp)` pulls ALL messages since the last agent response, not just the triggering batch. This means the agent sees the full conversation it missed.

6. **Hot path: pipe to running container** — If a container is already running for this group (`queue.sendMessage()`), the formatted messages are written as an IPC file. The agent picks them up without spawning a new container. This is the "follow-up message" flow.

7. **Cold path: enqueue new container** — If no container is running, `queue.enqueueMessageCheck()` queues the group for processing.

## 6. Message Formatting: `src/router.ts`

Messages are formatted as XML for the agent:

```bash
cat src/router.ts
```

```output
import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) =>
    `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
```

The agent receives messages wrapped in XML like:

```xml
<messages>
<message sender="Alice" time="2026-03-02T10:00:00Z">@Andy what's the weather?</message>
<message sender="Bob" time="2026-03-02T10:01:00Z">Yeah I'm curious too</message>
</messages>
```

On the outbound side, `stripInternalTags` removes `<internal>...</internal>` blocks. The agent uses these for private reasoning that shouldn't be sent to users.

## 7. Group Queue: `src/group-queue.ts`

The `GroupQueue` manages container concurrency. At most `MAX_CONCURRENT_CONTAINERS` (default 5) can run simultaneously. Each group gets its own slot — one container per group at a time.

```bash
sed -n '8,25p' src/group-queue.ts
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
```

Each group tracks: whether a container is `active`, whether there are `pendingMessages` or `pendingTasks`, the running `process`, and a `retryCount` for exponential backoff.

The key methods form a queue discipline:

- **`enqueueMessageCheck(groupJid)`** — If the group is active or the global limit is hit, mark as pending. Otherwise, spawn a container immediately.
- **`enqueueTask(groupJid, taskId, fn)`** — Same logic, but for scheduled tasks. Tasks get priority over messages during draining.
- **`sendMessage(groupJid, text)`** — Write a follow-up message to the active container's IPC directory (for piping messages into a running agent).
- **`closeStdin(groupJid)`** — Write a `_close` sentinel file to tell the container to shut down gracefully.

After a container finishes, `drainGroup` handles the aftermath:

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

The drain order is:
1. Pending tasks for this group (can't be re-discovered from DB)
2. Pending messages for this group (can be re-fetched)
3. Other groups waiting for a container slot

On failure, the retry logic uses exponential backoff: 5s, 10s, 20s, 40s, 80s — up to 5 retries before giving up:

```bash
sed -n '220,241p' src/group-queue.ts
```

```output
  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }
```

## 8. Processing Messages: `src/index.ts` — `processGroupMessages()`

When the queue decides it's time to process a group, it calls `processGroupMessages`. This is where the cursor management, trigger checking, error recovery, and container invocation all converge:

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

This function has careful error recovery:

- **Cursor advance + rollback** — The per-group cursor is advanced *before* calling the agent. If the agent fails AND no output was sent to the user, the cursor rolls back so the messages will be retried. But if output was already sent, the cursor stays advanced to prevent duplicate messages.

- **Idle timeout** — After each agent result, a 30-minute idle timer starts. If no more output arrives, the container's stdin is closed via a `_close` sentinel file, causing it to shut down gracefully. This means containers stay alive between messages (for fast follow-ups) but don't linger forever.

- **Typing indicator** — `whatsapp.setTyping()` shows "typing..." in the chat while the agent works. Cleared when done.

- **Streaming output** — Results arrive via a callback as the agent works. Each result is immediately sent to the user without waiting for the full container to finish.

## 9. Container Runner: `src/container-runner.ts`

This is the most complex file. It builds the volume mounts, spawns the container, streams output, and handles timeouts.

### Volume Mounts

The mount architecture enforces isolation:

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

The mount rules enforce a strict privilege model:

| Mount | Main Group | Other Groups |
|-------|-----------|--------------|
| `/workspace/project` | Entire NanoClaw project (read-write) | Not mounted |
| `/workspace/group` | `groups/main/` | `groups/{name}/` only |
| `/workspace/global` | Via project mount | `groups/global/` (read-only) |
| `/home/node/.claude` | Per-group sessions dir | Per-group sessions dir |
| `/workspace/ipc` | Per-group IPC namespace | Per-group IPC namespace |
| `/app/src` | Agent-runner source (read-only) | Agent-runner source (read-only) |

Non-main groups can't see other groups' files, the project source, or each other's IPC directories. The global `CLAUDE.md` is the only shared context, and it's read-only.

### Spawning and Streaming

```bash
sed -n '253,328p' src/container-runner.ts
```

```output

  return new Promise((resolve) => {
    const container = spawn('container', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

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

The streaming protocol uses sentinel markers:

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"Here's the weather...","newSessionId":"abc123"}
---NANOCLAW_OUTPUT_END---
```

As stdout chunks arrive, the parser buffers them and scans for complete marker pairs. Each parsed result triggers the `onOutput` callback immediately — so the user sees the response in WhatsApp as soon as the agent produces it, without waiting for the container to exit.

The `outputChain` (a Promise chain) ensures callbacks execute in order even though stdout arrives asynchronously.

### Secret Handling

Secrets deserve special attention:

```bash
sed -n '185,190p' src/container-runner.ts
```

```output
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}
```

The secret flow is:
1. `.env` is read from disk (never loaded into `process.env`)
2. Secrets are included in the JSON written to the container's stdin
3. The stdin JSON object is immediately wiped: `delete input.secrets`
4. Inside the container, secrets are passed to the SDK's `env` option but NOT to `process.env`
5. A `PreToolUse` hook on Bash commands prepends `unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN` to every shell command

This means: secrets exist in the SDK process memory but can't leak via Bash commands, environment inspection, or mounted files.

## 10. Inside the Container: `container/Dockerfile`

The container image is built from `node:22-slim` with Chromium for browser automation:

```bash
cat container/Dockerfile
```

```output
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Secrets are passed via stdin JSON — temp file is deleted immediately after Node reads it
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
```

The entrypoint script does something clever: it recompiles the agent-runner TypeScript on every container start (`npx tsc --outDir /tmp/dist`). Since `/app/src` is mounted read-only from the host, this means you can edit the agent-runner code and have it take effect immediately without rebuilding the container image. The compiled output goes to `/tmp/dist` (ephemeral) and is made read-only to prevent the agent from modifying its own runner.

The container runs as the `node` user (non-root), which is required by the Claude Agent SDK's `--dangerously-skip-permissions` flag.

## 11. Agent Runner: `container/agent-runner/src/index.ts`

This is the code that runs INSIDE the container. It reads input from stdin, calls the Claude Agent SDK, and streams results back:

```bash
sed -n '492,584p' container/agent-runner/src/index.ts
```

```output
async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

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

The agent runner has a **query loop**:

1. Read initial input from stdin (prompt + secrets + session ID)
2. Call `runQuery()` which invokes the Claude Agent SDK
3. When the query finishes, wait for the next IPC message (follow-up from the user)
4. If a new message arrives, start a new query with `resume` to continue the same session
5. If a `_close` sentinel is found, exit gracefully

This loop is what makes containers persistent between messages. The agent doesn't exit after one response — it waits for more input. The 30-minute idle timeout on the host side eventually writes the `_close` file.

### The SDK Call

```bash
sed -n '416,455p' container/agent-runner/src/index.ts
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
```

The SDK call configures:

- **`cwd: '/workspace/group'`** — The agent works in the group's filesystem.
- **`prompt: stream`** — A `MessageStream` (async iterable) that keeps the connection open for piped follow-up messages.
- **`resume: sessionId`** — Continues the previous conversation for this group.
- **`allowedTools`** — The full Claude Code toolset, plus `mcp__nanoclaw__*` (the custom MCP server tools).
- **`permissionMode: 'bypassPermissions'`** — No permission prompts (the container IS the sandbox).
- **`mcpServers.nanoclaw`** — Launches the IPC MCP server as a child process, passing group identity via env vars.
- **Two hooks:**
  - `PreCompact` — Archives the conversation transcript before context compaction.
  - `PreToolUse` on `Bash` — Prepends `unset` commands to strip secrets from Bash subprocesses.

### The MessageStream

```bash
sed -n '65,95p' container/agent-runner/src/index.ts
```

```output
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

`MessageStream` is a push-based async iterable. It keeps the SDK's `for await` loop alive between messages. When a follow-up IPC message arrives, `push()` adds it to the queue and wakes the iterator. When `end()` is called (on `_close` sentinel), the iterator finishes and the query completes.

During a query, the IPC input directory is also polled. If a user sends another message while the agent is still processing, it's piped directly into the running query via the stream — no new container needed.

## 12. MCP Tools: `container/agent-runner/src/ipc-mcp-stdio.ts`

The agent has access to custom tools via a Model Context Protocol (MCP) server. This server runs as a child process inside the container:

```bash
grep -n 'server.tool(' container/agent-runner/src/ipc-mcp-stdio.ts | head -10
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
grep -A1 'server.tool(' container/agent-runner/src/ipc-mcp-stdio.ts
```

```output
server.tool(
  'send_message',
--
server.tool(
  'schedule_task',
--
server.tool(
  'list_tasks',
--
server.tool(
  'pause_task',
--
server.tool(
  'resume_task',
--
server.tool(
  'cancel_task',
--
server.tool(
  'register_group',
```

Seven MCP tools are registered:

| Tool | Purpose | Auth |
|------|---------|------|
| `send_message` | Send a message to the user/group immediately | Any group (own chat only) |
| `schedule_task` | Create recurring or one-time tasks | Non-main: own group only |
| `list_tasks` | View scheduled tasks | Main sees all; others see own |
| `pause_task` | Pause a task | Main or task owner |
| `resume_task` | Resume a paused task | Main or task owner |
| `cancel_task` | Delete a task | Main or task owner |
| `register_group` | Add a new group | Main only |

All tools work by writing JSON files to the IPC directory. The host's IPC watcher picks them up. Let's look at how `send_message` works as an example:

```bash
sed -n '42,63p' container/agent-runner/src/ipc-mcp-stdio.ts
```

```output
server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);
```

The tool writes a JSON file to `/workspace/ipc/messages/` with an atomic write pattern (write to `.tmp`, then `rename`). The `chatJid` and `groupFolder` come from environment variables set by the agent runner, so the container can't forge its identity.

## 13. IPC Watcher: `src/ipc.ts`

On the host side, the IPC watcher polls every second for JSON files that containers have written. It's the counterpart to the MCP server:

```bash
sed -n '33,52p' src/ipc.ts
```

```output
export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

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
```

The watcher scans `data/ipc/` for group-named subdirectories. Each group's identity is determined by which directory its files are in — this is enforced by the container mount (each group can only write to its own IPC directory).

### Authorization

The authorization model is simple but effective:

```bash
sed -n '73,92p' src/ipc.ts
```

```output
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
```

The rule: main group can send to any chat. Other groups can only send to their own chat (verified by matching `targetGroup.folder === sourceGroup`). If a group tries to send to another group's chat, it's logged and blocked.

Failed IPC files are moved to `data/ipc/errors/` instead of being deleted, preserving evidence for debugging.

## 14. Task Scheduler: `src/task-scheduler.ts`

The scheduler runs independently of the message loop. Every 60 seconds it queries the database for due tasks:

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

Tasks support three schedule types:

- **`cron`** — Standard cron expressions (e.g., `"0 9 * * *"` for daily at 9am local time)
- **`interval`** — Milliseconds between runs (e.g., `"3600000"` for hourly)
- **`once`** — Run once at a specific time

Each task also has a **context mode**:
- **`group`** — Reuses the group's conversation session (has access to chat history)
- **`isolated`** — Fresh session with no history (all context must be in the prompt)

After a task runs, its `next_run` is calculated from the schedule and stored back in the DB. One-time tasks get `status: 'completed'` after execution.

## 15. Mount Security: `src/mount-security.ts`

Groups can have additional filesystem mounts (e.g., a git repo or documents folder). These are validated against an allowlist stored OUTSIDE the project directory at `~/.config/nanoclaw/mount-allowlist.json`:

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

The allowlist is tamper-proof: it lives at `~/.config/nanoclaw/mount-allowlist.json`, which is never mounted into any container. Even if an agent compromises its container, it can't modify the security policy.

Validation checks:
1. Path must exist (no ghost mounts)
2. Symlinks are resolved to real paths (no symlink escapes)
3. Path must not match any blocked pattern (SSH keys, credentials, etc.)
4. Path must be under an explicitly allowed root from the allowlist
5. Non-main groups can be forced to read-only via `nonMainReadOnly`
6. Container paths are validated against traversal attacks (no `..`)

## 16. Supporting Files

### Types: `src/types.ts`

All shared interfaces in one file. The key ones:

```bash
sed -n '30,98p' src/types.ts
```

```output
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

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

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (WhatsApp syncGroupMetadata) omit it.
export type OnChatMetadata = (chatJid: string, timestamp: string, name?: string) => void;
```

The `Channel` interface is the abstraction that makes it possible to swap WhatsApp for Telegram or other messaging platforms. Skills like `/add-telegram` implement this interface.

### Logger: `src/logger.ts`

```bash
cat src/logger.ts
```

```output
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
```

Pino with pretty-printing. Uncaught exceptions and unhandled rejections get routed through the logger so they have timestamps.

### Environment: `src/env.ts`

```bash
cat src/env.ts
```

```output
import fs from 'fs';
import path from 'path';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch {
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
```

This is a deliberate alternative to `dotenv`. Standard `dotenv` loads everything into `process.env`, which means any child process (including those spawned by the container) would inherit the secrets. `readEnvFile` only returns the specific keys you ask for, and the caller decides what to do with them.

## 17. Putting It All Together

Here's the complete lifecycle of a message, end-to-end:

```
1. Alice sends "@Andy what's the weather?" in a WhatsApp group
2. Baileys fires messages.upsert
3. WhatsAppChannel.onMessage() stores the message in SQLite
4. Message loop (every 2s) finds the new message via getNewMessages()
5. Trigger check passes: message starts with @Andy
6. All messages since last agent run are fetched (context accumulation)
7. Messages are formatted as XML: <messages><message sender="Alice">...</message></messages>
8. GroupQueue.enqueueMessageCheck() → no active container → spawn new one
9. container-runner.ts builds volume mounts (group folder, IPC dir, sessions)
10. Container spawns: `container run -i --rm --name nanoclaw-family-chat-...`
11. Input JSON (prompt + secrets + session ID) written to container stdin
12. agent-runner reads stdin, calls Claude Agent SDK via query()
13. Claude sees the message, decides to search the web
14. Claude uses WebSearch tool → gets weather data
15. Claude returns a result
16. agent-runner writes: ---NANOCLAW_OUTPUT_START---{"status":"success","result":"It's 72°F and sunny..."}---NANOCLAW_OUTPUT_END---
17. container-runner.ts parses the marker, calls onOutput callback
18. processGroupMessages sends the result to WhatsApp via sendMessage()
19. WhatsApp shows "Andy: It's 72°F and sunny in SF today!"
20. Idle timer starts (30 min). Container waits for follow-up messages.
21. No follow-up arrives → _close sentinel written → container exits cleanly
```

### Code size

```bash
echo '--- Host-side source ---' && wc -l src/index.ts src/channels/whatsapp.ts src/db.ts src/container-runner.ts src/group-queue.ts src/ipc.ts src/task-scheduler.ts src/router.ts src/config.ts src/types.ts src/mount-security.ts src/logger.ts src/env.ts && echo '' && echo '--- Container-side source ---' && wc -l container/agent-runner/src/index.ts container/agent-runner/src/ipc-mcp-stdio.ts container/Dockerfile
```

```output
--- Host-side source ---
   510 src/index.ts
   324 src/channels/whatsapp.ts
   605 src/db.ts
   643 src/container-runner.ts
   302 src/group-queue.ts
   379 src/ipc.ts
   218 src/task-scheduler.ts
    44 src/router.ts
    65 src/config.ts
    98 src/types.ts
   418 src/mount-security.ts
    16 src/logger.ts
    40 src/env.ts
  3662 total

--- Container-side source ---
  587 container/agent-runner/src/index.ts
  279 container/agent-runner/src/ipc-mcp-stdio.ts
   68 container/Dockerfile
  934 total
```

~4,600 lines total. Small enough to understand in one sitting. Every file has a single clear responsibility. No abstraction layers, no frameworks, no configuration management. Just a straightforward pipeline from WhatsApp message to container agent to WhatsApp response.
