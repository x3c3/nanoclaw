/**
 * v2 Channel Adapter interface.
 *
 * Channel adapters bridge NanoClaw with messaging platforms (Discord, Slack, etc.).
 * Two patterns: native adapters (implement directly) or Chat SDK bridge (wrap a Chat SDK adapter).
 */

/** Configuration for a registered conversation (messaging group + agent wiring). */
export interface ConversationConfig {
  platformId: string;
  agentGroupId: string;
  triggerPattern?: string; // regex string (for native channels)
  requiresTrigger: boolean;
  sessionMode: 'shared' | 'per-thread';
}

/** Passed to the adapter at setup time. */
export interface ChannelSetup {
  /** Known conversations from central DB. */
  conversations: ConversationConfig[];

  /** Called when an inbound message arrives from the platform. */
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void;

  /** Called when the adapter discovers metadata about a conversation. */
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;

  /** Called when a user clicks a button/action in a card (e.g., ask_user_question response). */
  onAction(questionId: string, selectedOption: string, userId: string): void;
}

/** Inbound message from adapter to host. */
export interface InboundMessage {
  id: string;
  kind: 'chat' | 'chat-sdk';
  content: unknown; // JS object — host will JSON.stringify before writing to session DB
  timestamp: string;
}

/** A file attachment to deliver alongside a message. */
export interface OutboundFile {
  filename: string;
  data: Buffer;
}

/** Outbound message from host to adapter. */
export interface OutboundMessage {
  kind: string;
  content: unknown; // parsed JSON from messages_out
  files?: OutboundFile[]; // file attachments from the session outbox
}

/** Discovered conversation info (from syncConversations). */
export interface ConversationInfo {
  platformId: string;
  name: string;
  isGroup: boolean;
}

/** The v2 channel adapter contract. */
export interface ChannelAdapter {
  name: string;
  channelType: string;

  // Lifecycle
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;

  // Outbound delivery
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<void>;

  // Optional
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  updateConversations?(conversations: ConversationConfig[]): void;
}

/** Factory function that creates a channel adapter (returns null if credentials missing). */
export type ChannelAdapterFactory = () => ChannelAdapter | null;

/** Registration entry for a channel adapter. */
export interface ChannelRegistration {
  factory: ChannelAdapterFactory;
  containerConfig?: {
    mounts?: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
    env?: Record<string, string>;
  };
}
