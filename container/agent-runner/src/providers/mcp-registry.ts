import fs from 'fs';
import { fileURLToPath } from 'url';

import { AgentTurnContext } from '../types.js';

export interface OpenAiMcpServerConfig {
  serverName: string;
  transport: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  requestInit?: RequestInit;
  startupTimeoutMs?: number;
}

export type ClaudeMcpServerConfig =
  | {
      type?: 'stdio';
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
    };

interface McpCapabilityDefinition {
  capability: 'gmail' | 'jira' | 'testit' | 'figma' | 'gitlab' | 'm365';
  promptMatchers: RegExp[];
  claudeToolPatterns: string[];
  isAvailable?: (context: AgentTurnContext) => boolean;
  getClaudeServers: (
    context: AgentTurnContext,
    env: Record<string, string>,
  ) => Record<string, ClaudeMcpServerConfig>;
  getOpenAiServers: (
    context: AgentTurnContext,
    env: Record<string, string>,
  ) => OpenAiMcpServerConfig[];
}

export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 15_000;
export const SLOW_MCP_STARTUP_TIMEOUT_MS = 180_000;
const LOCAL_GITLAB_MCP_SERVER_PATH = fileURLToPath(
  new URL('./gitlab-mcp-server.js', import.meta.url),
);

function hasM365McpBinary(): boolean {
  return (
    fs.existsSync('/usr/local/bin/m365-mcp') ||
    fs.existsSync('/usr/bin/m365-mcp')
  );
}

function hasFigmaMcp(): boolean {
  return fs.existsSync('/workspace/figma-mcp/index.js');
}

function collectAgentEnv(context: AgentTurnContext): Record<string, string> {
  return Object.fromEntries(
    Object.entries(context.agentEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function buildNanoclawEnv(
  context: AgentTurnContext,
  env: Record<string, string>,
): Record<string, string> {
  return {
    ...env,
    NANOCLAW_CHAT_JID: context.containerInput.chatJid,
    NANOCLAW_GROUP_FOLDER: context.containerInput.groupFolder,
    NANOCLAW_IS_MAIN: context.containerInput.isMain ? '1' : '0',
  };
}

const MCP_CAPABILITIES: McpCapabilityDefinition[] = [
  {
    capability: 'gmail',
    promptMatchers: [/\b(gmail|email|inbox|mail)\b/i],
    claudeToolPatterns: ['mcp__gmail__*'],
    getClaudeServers: () => ({
      gmail: {
        command: 'npx',
        args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
      },
    }),
    getOpenAiServers: (_context, env) => [
      {
        serverName: 'gmail',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
        env,
        startupTimeoutMs: SLOW_MCP_STARTUP_TIMEOUT_MS,
      },
    ],
  },
  {
    capability: 'jira',
    promptMatchers: [/\b(jira|ticket|issue)\b/i, /\b[A-Z][A-Z0-9]+-\d+\b/],
    claudeToolPatterns: ['mcp__jira__*', 'mcp__atlassian__*'],
    getClaudeServers: (context) => ({
      jira: {
        command: 'npx',
        args: [
          '-y',
          '--registry=http://nexus3-xmn02.int.rclabenv.com/repository/npm-group/',
          '@ringcentral/mcp-jira',
        ],
        env: { JIRA_TOKEN: context.agentEnv.JIRA_TOKEN ?? '' },
      },
      atlassian: {
        type: 'http',
        url: 'https://mcp-atlassian.int.rclabenv.com/mcp/',
        headers: {
          'confluence-read-token': context.agentEnv.CONFLUENCE_READ_TOKEN ?? '',
          'jira-read-token': context.agentEnv.JIRA_TOKEN ?? '',
        },
      },
    }),
    getOpenAiServers: (context) => [
      {
        serverName: 'atlassian',
        transport: 'streamable-http',
        url: 'https://mcp-atlassian.int.rclabenv.com/mcp/',
        requestInit: {
          headers: {
            'confluence-read-token':
              context.agentEnv.CONFLUENCE_READ_TOKEN ?? '',
            'jira-read-token': context.agentEnv.JIRA_TOKEN ?? '',
          },
        },
        startupTimeoutMs: SLOW_MCP_STARTUP_TIMEOUT_MS,
      },
    ],
  },
  {
    capability: 'testit',
    promptMatchers: [/\b(testit|test case|test plan)\b/i],
    claudeToolPatterns: ['mcp__testit__*'],
    getClaudeServers: () => ({
      testit: {
        command: 'npx',
        args: [
          '-y',
          '--registry',
          'https://nexus-xmn02.int.rclabenv.com/nexus/content/groups/npm-all/',
          '@ringcentral/mcp-testit-fetcher',
        ],
      },
    }),
    getOpenAiServers: (_context, env) => [
      {
        serverName: 'testit',
        transport: 'stdio',
        command: 'npx',
        args: [
          '-y',
          '--registry',
          'https://nexus-xmn02.int.rclabenv.com/nexus/content/groups/npm-all/',
          '@ringcentral/mcp-testit-fetcher',
        ],
        env,
        startupTimeoutMs: SLOW_MCP_STARTUP_TIMEOUT_MS,
      },
    ],
  },
  {
    capability: 'figma',
    promptMatchers: [/\b(figma|design file)\b/i],
    claudeToolPatterns: ['mcp__figma__*'],
    isAvailable: () => hasFigmaMcp(),
    getClaudeServers: () => ({
      figma: {
        command: 'node',
        args: ['/workspace/figma-mcp/index.js'],
      },
    }),
    getOpenAiServers: (_context, env) => [
      {
        serverName: 'figma',
        transport: 'stdio',
        command: 'node',
        args: ['/workspace/figma-mcp/index.js'],
        env,
        startupTimeoutMs: DEFAULT_MCP_STARTUP_TIMEOUT_MS,
      },
    ],
  },
  {
    capability: 'gitlab',
    promptMatchers: [/\b(gitlab|merge request|mr\b|pipeline|commit)\b/i],
    claudeToolPatterns: ['mcp__gitlab__*'],
    getClaudeServers: (context, env) => ({
      gitlab: {
        command: 'node',
        args: [LOCAL_GITLAB_MCP_SERVER_PATH],
        env: {
          ...env,
          GITLAB_PERSONAL_ACCESS_TOKEN:
            context.agentEnv.GITLAB_PERSONAL_ACCESS_TOKEN ?? '',
          GITLAB_API_URL: 'https://git.ringcentral.com/api/v4',
        },
      },
    }),
    getOpenAiServers: (_context, env) => [
      {
        serverName: 'gitlab',
        transport: 'stdio',
        command: 'node',
        args: [LOCAL_GITLAB_MCP_SERVER_PATH],
        env: {
          ...env,
          GITLAB_PERSONAL_ACCESS_TOKEN: env.GITLAB_PERSONAL_ACCESS_TOKEN ?? '',
          GITLAB_API_URL: 'https://git.ringcentral.com/api/v4',
        },
        startupTimeoutMs: SLOW_MCP_STARTUP_TIMEOUT_MS,
      },
    ],
  },
  {
    capability: 'm365',
    promptMatchers: [/\b(outlook|m365|teams|calendar)\b/i],
    claudeToolPatterns: ['mcp__m365__*'],
    isAvailable: () => hasM365McpBinary(),
    getClaudeServers: (context) => ({
      m365: {
        command: 'm365-mcp',
        args: [],
        env: {
          MS_CLIENT_ID: context.agentEnv.OUTLOOK_CLIENT_ID ?? '',
          MS_CLIENT_SECRET: context.agentEnv.OUTLOOK_CLIENT_SECRET ?? '',
          MS_TENANT_ID: context.agentEnv.MS_TENANT_ID ?? '',
          USE_TEST_MODE: 'false',
        },
      },
    }),
    getOpenAiServers: (_context, env) => [
      {
        serverName: 'm365',
        transport: 'stdio',
        command: 'm365-mcp',
        args: [],
        env: {
          ...env,
          MS_CLIENT_ID: env.OUTLOOK_CLIENT_ID ?? '',
          MS_CLIENT_SECRET: env.OUTLOOK_CLIENT_SECRET ?? '',
          MS_TENANT_ID: env.MS_TENANT_ID ?? '',
          USE_TEST_MODE: 'false',
        },
        startupTimeoutMs: DEFAULT_MCP_STARTUP_TIMEOUT_MS,
      },
    ],
  },
];

function isCapabilityAvailable(
  capability: McpCapabilityDefinition,
  context: AgentTurnContext,
): boolean {
  return capability.isAvailable ? capability.isAvailable(context) : true;
}

function requestedCapabilities(prompt: string): McpCapabilityDefinition[] {
  return MCP_CAPABILITIES.filter((capability) =>
    capability.promptMatchers.some((matcher) => matcher.test(prompt)),
  );
}

export function getClaudeAllowedToolPatterns(personalMode: boolean): string[] {
  if (!personalMode) return ['mcp__nanoclaw__*'];

  return [
    'mcp__nanoclaw__*',
    ...MCP_CAPABILITIES.flatMap((capability) => capability.claudeToolPatterns),
  ];
}

export function getClaudeMcpServers(
  context: AgentTurnContext,
): Record<string, ClaudeMcpServerConfig> {
  const env = collectAgentEnv(context);
  const servers: Record<string, ClaudeMcpServerConfig> = {
    nanoclaw: {
      command: 'node',
      args: [context.mcpServerPath],
      env: buildNanoclawEnv(context, env),
    },
  };

  if (!context.containerInput.personalMode) return servers;

  for (const capability of MCP_CAPABILITIES) {
    if (!isCapabilityAvailable(capability, context)) continue;
    Object.assign(servers, capability.getClaudeServers(context, env));
  }

  return servers;
}

export function getOpenAiMcpServerConfigs(
  context: AgentTurnContext,
): OpenAiMcpServerConfig[] {
  const env = collectAgentEnv(context);
  const configs: OpenAiMcpServerConfig[] = [
    {
      serverName: 'nanoclaw',
      transport: 'stdio',
      command: 'node',
      args: [context.mcpServerPath],
      cwd: '/workspace/group',
      env: buildNanoclawEnv(context, env),
      startupTimeoutMs: DEFAULT_MCP_STARTUP_TIMEOUT_MS,
    },
  ];

  if (!context.containerInput.personalMode) return configs;

  for (const capability of requestedCapabilities(context.prompt)) {
    if (!isCapabilityAvailable(capability, context)) continue;
    configs.push(...capability.getOpenAiServers(context, env));
  }

  return configs;
}
