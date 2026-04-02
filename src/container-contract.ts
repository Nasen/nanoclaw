export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export type ContainerLifecycle = 'query_started' | 'idle_waiting';

export type ExternalMcpCapability =
  | 'gmail'
  | 'jira'
  | 'testit'
  | 'figma'
  | 'gitlab'
  | 'm365';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  personalMode?: boolean;
  adminRole?: string;
  canSpeakAsOwner?: boolean;
  allowedExternalMcpCapabilities?: ExternalMcpCapability[];
  allowedNanoclawTools?: string[];
  allowedPeerGroups?: string[];
  disableCurrentChatSendTool?: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  lifecycle?: ContainerLifecycle;
  keptAlive?: boolean;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}
