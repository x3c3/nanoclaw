/**
 * Chat SDK bridge — wraps a Chat SDK adapter + Chat instance
 * to conform to the NanoClaw ChannelAdapter interface.
 *
 * Used by Discord, Slack, and other Chat SDK-supported platforms.
 */
import http from 'http';

import { Chat, Card, CardText, Actions, Button, type Adapter, type ConcurrencyStrategy, type Message as ChatMessage } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';

import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, ConversationConfig, InboundMessage } from './adapter.js';

/** Adapter with optional gateway support (e.g., Discord). */
interface GatewayAdapter extends Adapter {
  startGatewayListener?(
    options: { waitUntil?: (task: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<Response>;
}

export interface ChatSdkBridgeConfig {
  adapter: GatewayAdapter;
  concurrency?: ConcurrencyStrategy;
  /** Bot token for authenticating forwarded Gateway events (required for interaction handling). */
  botToken?: string;
}

export function createChatSdkBridge(config: ChatSdkBridgeConfig): ChannelAdapter {
  const { adapter } = config;
  let chat: Chat;
  let state: ReturnType<typeof createMemoryState>;
  let setupConfig: ChannelSetup;
  let conversations: Map<string, ConversationConfig>;
  let gatewayAbort: AbortController | null = null;

  function buildConversationMap(configs: ConversationConfig[]): Map<string, ConversationConfig> {
    const map = new Map<string, ConversationConfig>();
    for (const conv of configs) {
      map.set(conv.platformId, conv);
    }
    return map;
  }

  function messageToInbound(message: ChatMessage): InboundMessage {
    return {
      id: message.id,
      kind: 'chat-sdk',
      content: message.toJSON(),
      timestamp: message.metadata.dateSent.toISOString(),
    };
  }

  return {
    name: adapter.name,
    channelType: adapter.name,

    async setup(hostConfig: ChannelSetup) {
      setupConfig = hostConfig;
      conversations = buildConversationMap(hostConfig.conversations);

      state = createMemoryState();

      chat = new Chat({
        adapters: { [adapter.name]: adapter },
        userName: adapter.userName || 'NanoClaw',
        concurrency: config.concurrency ?? 'concurrent',
        state,
        logger: 'silent',
      });

      // Subscribed threads — forward all messages
      chat.onSubscribedMessage(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        setupConfig.onInbound(channelId, thread.id, messageToInbound(message));
      });

      // @mention in unsubscribed thread — forward + subscribe
      chat.onNewMention(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        setupConfig.onInbound(channelId, thread.id, messageToInbound(message));
        await thread.subscribe();
      });

      // DMs — always forward + subscribe
      chat.onDirectMessage(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        setupConfig.onInbound(channelId, null, messageToInbound(message));
        await thread.subscribe();
      });

      // Handle button clicks (ask_user_question responses)
      chat.onAction(async (event) => {
        if (!event.actionId.startsWith('ncq:')) return;
        const parts = event.actionId.split(':');
        if (parts.length < 3) return;
        const questionId = parts[1];
        const selectedOption = event.value || '';
        const userId = event.user?.userId || '';
        setupConfig.onAction(questionId, selectedOption, userId);
      });

      await chat.initialize();

      // Subscribe registered conversations (after initialize connects state)
      for (const conv of hostConfig.conversations) {
        if (conv.agentGroupId) {
          const threadId = adapter.encodeThreadId({ guildId: '', channelId: conv.platformId } as never);
          await state.subscribe(threadId);
        }
      }

      // Start Gateway listener for adapters that support it (e.g., Discord)
      if (adapter.startGatewayListener) {
        gatewayAbort = new AbortController();

        // Start local HTTP server to receive forwarded Gateway events (including interactions)
        const webhookUrl = await startLocalWebhookServer(adapter, setupConfig, config.botToken);

        const startGateway = () => {
          if (gatewayAbort?.signal.aborted) return;
          // Capture the long-running listener promise via waitUntil
          let listenerPromise: Promise<unknown> | undefined;
          adapter.startGatewayListener!(
            {
              waitUntil: (p: Promise<unknown>) => {
                listenerPromise = p;
              },
            },
            24 * 60 * 60 * 1000,
            gatewayAbort!.signal,
            webhookUrl,
          ).then(() => {
            // startGatewayListener resolves immediately with a Response;
            // the actual work is in the listenerPromise passed to waitUntil
            if (listenerPromise) {
              listenerPromise
                .then(() => {
                  if (!gatewayAbort?.signal.aborted) {
                    log.info('Gateway listener expired, restarting', { adapter: adapter.name });
                    startGateway();
                  }
                })
                .catch((err) => {
                  if (!gatewayAbort?.signal.aborted) {
                    log.error('Gateway listener error, restarting in 5s', { adapter: adapter.name, err });
                    setTimeout(startGateway, 5000);
                  }
                });
            }
          });
        };
        startGateway();
        log.info('Gateway listener started', { adapter: adapter.name });
      }

      log.info('Chat SDK bridge initialized', { adapter: adapter.name });
    },

    async deliver(platformId: string, threadId: string | null, message) {
      const tid = threadId ?? adapter.encodeThreadId({ guildId: '', channelId: platformId } as never);
      const content = message.content as Record<string, unknown>;

      if (content.operation === 'edit' && content.messageId) {
        await adapter.editMessage(tid, content.messageId as string, {
          markdown: (content.text as string) || (content.markdown as string) || '',
        });
        return;
      }

      if (content.operation === 'reaction' && content.messageId && content.emoji) {
        await adapter.addReaction(tid, content.messageId as string, content.emoji as string);
        return;
      }

      // Ask question card — render as Card with buttons
      if (content.type === 'ask_question' && content.questionId && content.options) {
        const questionId = content.questionId as string;
        const options = content.options as string[];
        const card = Card({
          title: '❓ Question',
          children: [
            CardText(content.question as string),
            Actions(
              options.map((opt) =>
                Button({ id: `ncq:${questionId}:${opt}`, label: opt, value: opt }),
              ),
            ),
          ],
        });
        await adapter.postMessage(tid, { card, fallbackText: `${content.question}\nOptions: ${options.join(', ')}` });
        return;
      }

      // Normal message
      const text = (content.markdown as string) || (content.text as string);
      if (text) {
        // Attach files if present (FileUpload format: { data, filename })
        const fileUploads = message.files?.map((f) => ({ data: f.data, filename: f.filename }));
        if (fileUploads && fileUploads.length > 0) {
          await adapter.postMessage(tid, { markdown: text, files: fileUploads });
        } else {
          await adapter.postMessage(tid, { markdown: text });
        }
      } else if (message.files && message.files.length > 0) {
        // Files only, no text
        const fileUploads = message.files.map((f) => ({ data: f.data, filename: f.filename }));
        await adapter.postMessage(tid, { markdown: '', files: fileUploads });
      }
    },

    async setTyping(platformId: string, threadId: string | null) {
      const tid = threadId ?? adapter.encodeThreadId({ guildId: '', channelId: platformId } as never);
      await adapter.startTyping(tid);
    },

    async teardown() {
      gatewayAbort?.abort();
      await chat.shutdown();
      log.info('Chat SDK bridge shut down', { adapter: adapter.name });
    },

    isConnected() {
      return true;
    },

    updateConversations(configs: ConversationConfig[]) {
      conversations = buildConversationMap(configs);
      // Subscribe new conversations
      for (const conv of configs) {
        if (conv.agentGroupId) {
          const threadId = adapter.encodeThreadId({ guildId: '', channelId: conv.platformId } as never);
          state.subscribe(threadId).catch(() => {});
        }
      }
    },
  };
}

/**
 * Start a local HTTP server to receive forwarded Gateway events.
 * This is needed because the Gateway listener in webhook-forwarding mode
 * sends ALL raw events (including INTERACTION_CREATE for button clicks)
 * to the webhookUrl, which we handle here.
 */
function startLocalWebhookServer(adapter: GatewayAdapter, setupConfig: ChannelSetup, botToken?: string): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        handleForwardedEvent(body, adapter, setupConfig, botToken)
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          })
          .catch((err) => {
            log.error('Webhook server error', { err });
            res.writeHead(500);
            res.end('{"error":"internal"}');
          });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/webhook`;
      log.info('Local webhook server started', { port: addr.port });
      resolve(url);
    });
  });
}

async function handleForwardedEvent(body: string, adapter: GatewayAdapter, setupConfig: ChannelSetup, botToken?: string): Promise<void> {
  let event: { type: string; data: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return;
  }

  // Handle interaction events (button clicks) — not handled by adapter's handleForwardedGatewayEvent
  if (event.type === 'GATEWAY_INTERACTION_CREATE' && event.data) {
    const interaction = event.data;
    // type 3 = MessageComponent (button/select)
    if (interaction.type === 3) {
      const customId = (interaction.data as Record<string, unknown>)?.custom_id as string;
      const user = (interaction.member as Record<string, unknown>)?.user as Record<string, string> | undefined;
      const interactionId = interaction.id as string;
      const interactionToken = interaction.token as string;

      // Parse the selected option from custom_id
      let questionId: string | undefined;
      let selectedOption: string | undefined;
      if (customId?.startsWith('ncq:')) {
        const colonIdx = customId.indexOf(':', 4); // after "ncq:"
        if (colonIdx !== -1) {
          questionId = customId.slice(4, colonIdx);
          selectedOption = customId.slice(colonIdx + 1);
        }
      }

      // Update the card to show the selected answer and remove buttons
      const originalEmbeds = ((interaction.message as Record<string, unknown>)?.embeds as Array<Record<string, unknown>>) || [];
      const originalDescription = (originalEmbeds[0]?.description as string) || '';
      try {
        await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 7, // UPDATE_MESSAGE — acknowledge + update in one call
            data: {
              embeds: [
                {
                  title: '❓ Question',
                  description: `${originalDescription}\n\n✅ **${selectedOption || customId}**`,
                },
              ],
              components: [], // remove buttons
            },
          }),
        });
      } catch (err) {
        log.error('Failed to update interaction', { err });
      }

      // Dispatch to host
      if (questionId && selectedOption) {
        setupConfig.onAction(questionId, selectedOption, user?.id || '');
      }
      return;
    }
  }

  // Forward other events to the adapter's webhook handler for normal processing
  const fakeRequest = new Request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-discord-gateway-token': botToken || '',
    },
    body,
  });
  await adapter.handleWebhook(fakeRequest, {});
}
