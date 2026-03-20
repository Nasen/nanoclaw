import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  AgentProvider,
  AgentTurnContext,
  AgentTurnResult,
} from '../types.js';

interface OpenAIHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface OpenAISessionState {
  history: OpenAIHistoryTurn[];
}

interface ResponsesFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface OpenAIToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface McpToolBinding {
  openAiName: string;
  serverName: string;
  mcpName: string;
}

interface McpServerConfig {
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

const OPENAI_STATE_DIR = '/home/node/.nanoclaw/openai';
const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_TOOL_LOOPS = 16;
const MAX_TOOL_OUTPUT_CHARS = 120_000;
const execFileAsync = promisify(execFile);
const DEFAULT_WEB_TIMEOUT_MS = 45_000;
const LEGACY_TOOL_REFUSAL_PATTERNS = [
  /does not support NanoClaw tool execution yet/i,
  /tools? are unavailable/i,
];
const HAS_M365_MCP =
  fs.existsSync('/usr/local/bin/m365-mcp') || fs.existsSync('/usr/bin/m365-mcp');
const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 15_000;
const SLOW_MCP_STARTUP_TIMEOUT_MS = 180_000;

function ensureStateDir(): void {
  fs.mkdirSync(OPENAI_STATE_DIR, { recursive: true });
}

function getStateFile(sessionId: string): string {
  return path.join(OPENAI_STATE_DIR, `${sessionId}.json`);
}

function loadSessionState(sessionId: string): OpenAISessionState {
  ensureStateDir();
  const filePath = getStateFile(sessionId);
  if (!fs.existsSync(filePath)) return { history: [] };

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as OpenAISessionState;
  } catch {
    return { history: [] };
  }
}

function saveSessionState(sessionId: string, state: OpenAISessionState): void {
  ensureStateDir();
  fs.writeFileSync(getStateFile(sessionId), `${JSON.stringify(state, null, 2)}\n`);
}

function loadGlobalContext(isMain: boolean): string {
  if (isMain) return '';

  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (!fs.existsSync(globalClaudeMdPath)) return '';

  return fs.readFileSync(globalClaudeMdPath, 'utf-8').trim();
}

function loadAdditionalDirectoriesSummary(): string {
  const extraBase = '/workspace/extra';
  if (!fs.existsSync(extraBase)) return '';

  const dirs = fs
    .readdirSync(extraBase)
    .map((entry) => path.join(extraBase, entry))
    .filter((fullPath) => fs.statSync(fullPath).isDirectory());

  if (dirs.length === 0) return '';
  return `Additional mounted directories are available at:\n${dirs
    .map((dir) => `- ${dir}`)
    .join('\n')}`;
}

function containsLegacyToolRefusal(text: string): boolean {
  return LEGACY_TOOL_REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}

function buildPrompt(
  history: OpenAIHistoryTurn[],
  prompt: string,
  context: AgentTurnContext,
): string {
  const sections: string[] = [];

  const globalContext = loadGlobalContext(context.containerInput.isMain);
  if (globalContext) {
    sections.push('Global instructions:');
    sections.push(globalContext);
  }

  const extraDirsSummary = loadAdditionalDirectoriesSummary();
  if (extraDirsSummary) sections.push(extraDirsSummary);

  const filteredHistory = history.filter(
    (turn) =>
      turn.role !== 'assistant' || !containsLegacyToolRefusal(turn.content),
  );

  if (filteredHistory.length > 0) {
    sections.push('Conversation so far:');
    for (const turn of filteredHistory) {
      sections.push(
        `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`,
      );
    }
  }

  sections.push('Latest user message:');
  sections.push(prompt);
  const toolInstructions = [
    'Respond as the NanoClaw agent.',
    'You have working tools.',
    'Use shell for local file/command tasks, web_fetch for known URLs, and web_search when you need current web information.',
    'The nanoclaw MCP send_message tool is available and works.',
    'Do not claim tools are unavailable.',
  ];

  if (
    context.containerInput.chatJid.startsWith('rc:') ||
    context.containerInput.chatJid.startsWith('rcb:')
  ) {
    toolInstructions.push(
      'In RingCentral chats, send_message supports delivery_mode="personal" to send through Nasen\'s personal RC app/credentials, delivery_mode="bot" to send through the bot app, and delivery_mode="auto" for the default route.',
    );
    toolInstructions.push(
      'When the user asks you to act as Nasen, reply on his behalf, send as him, or use his personal RingCentral account, prefer delivery_mode="personal".',
    );
    toolInstructions.push(
      'For RingCentral SDK operations across teams or DMs, use list_rc_chats, read_rc_messages, and send_rc_message instead of guessing from memory.',
    );
  }

  if (context.containerInput.personalMode) {
    toolInstructions.push(
      'In personal mode, send_message can send messages through the user\'s connected integrations on their behalf in the current chat.',
    );
    toolInstructions.push(
      'If the user asks you to send, reply, or follow up in this chat, use send_message instead of saying you cannot access their personal account or token.',
    );
  }

  sections.push(toolInstructions.join(' '));

  return sections.join('\n\n');
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...<truncated>`;
}

function getBuiltinToolDefinitions(): OpenAIToolDefinition[] {
  return [
    {
      type: 'function',
      name: 'shell',
      description:
        'Execute a shell command inside the container workspace. Use this for file inspection, search, edits, git commands, and local operations. This tool can also use curl for direct web requests if needed.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'The shell command to run. Multi-line bash is allowed.',
          },
          working_directory: {
            type: 'string',
            description:
              'Optional working directory. Defaults to /workspace/group.',
          },
          timeout_ms: {
            type: 'integer',
            description:
              'Optional timeout in milliseconds. Defaults to 120000.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'web_fetch',
      description:
        'Fetch a URL from the web and return the response body. Use this for known pages or APIs.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to fetch.',
          },
          timeout_ms: {
            type: 'integer',
            description:
              'Optional timeout in milliseconds. Defaults to 45000.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'web_search',
      description:
        'Search the web for current information and return the result page HTML. Use this when you do not yet know the target URL.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The web search query.',
          },
          timeout_ms: {
            type: 'integer',
            description:
              'Optional timeout in milliseconds. Defaults to 45000.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
}

function requestedExternalMcpServers(prompt: string): Set<string> {
  const text = prompt.toLowerCase();
  const requested = new Set<string>();

  if (/\b(jira|ticket|issue)\b/.test(text) || /\b[A-Z][A-Z0-9]+-\d+\b/.test(prompt)) {
    requested.add('jira');
  }
  if (/\b(gitlab|merge request|mr\b|pipeline|commit)\b/.test(text)) {
    requested.add('gitlab');
  }
  if (/\b(gmail|email|inbox|mail)\b/.test(text)) {
    requested.add('gmail');
  }
  if (/\b(testit|test case|test plan)\b/.test(text)) {
    requested.add('testit');
  }
  if (/\b(figma|design file)\b/.test(text)) {
    requested.add('figma');
  }
  if (/\b(outlook|m365|teams|calendar)\b/.test(text)) {
    requested.add('m365');
  }

  return requested;
}

function getMcpServerConfigs(context: AgentTurnContext): McpServerConfig[] {
  const env = Object.fromEntries(
    Object.entries(context.agentEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );

  const configs: McpServerConfig[] = [
    {
      serverName: 'nanoclaw',
      transport: 'stdio',
      command: 'node',
      args: [context.mcpServerPath],
      cwd: '/workspace/group',
      env: {
        ...env,
        NANOCLAW_CHAT_JID: context.containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: context.containerInput.groupFolder,
        NANOCLAW_IS_MAIN: context.containerInput.isMain ? '1' : '0',
      },
      startupTimeoutMs: DEFAULT_MCP_STARTUP_TIMEOUT_MS,
    },
  ];

  if (!context.containerInput.personalMode) return configs;
  const requested = requestedExternalMcpServers(context.prompt);
  if (requested.size === 0) return configs;

  if (requested.has('gmail')) {
    configs.push({
      serverName: 'gmail',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
      env,
      startupTimeoutMs: SLOW_MCP_STARTUP_TIMEOUT_MS,
    });
  }

  if (requested.has('jira')) {
    configs.push({
      serverName: 'atlassian',
      transport: 'streamable-http',
      url: 'https://mcp-atlassian.int.rclabenv.com/mcp/',
      requestInit: {
        headers: {
          'confluence-read-token': context.agentEnv.CONFLUENCE_READ_TOKEN ?? '',
          'jira-read-token': context.agentEnv.JIRA_TOKEN ?? '',
        },
      },
      startupTimeoutMs: SLOW_MCP_STARTUP_TIMEOUT_MS,
    });
  }

  if (requested.has('testit')) {
    configs.push({
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
    });
  }

  if (requested.has('gitlab')) {
    configs.push({
      serverName: 'gitlab',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-gitlab'],
      env: {
        ...env,
        GITLAB_PERSONAL_ACCESS_TOKEN:
          context.agentEnv.GITLAB_PERSONAL_ACCESS_TOKEN ?? '',
        GITLAB_API_URL: 'https://git.ringcentral.com/api/v4',
      },
      startupTimeoutMs: SLOW_MCP_STARTUP_TIMEOUT_MS,
    });
  }

  if (requested.has('figma') && fs.existsSync('/workspace/figma-mcp/index.js')) {
    configs.push({
      serverName: 'figma',
      transport: 'stdio',
      command: 'node',
      args: ['/workspace/figma-mcp/index.js'],
      env,
      startupTimeoutMs: DEFAULT_MCP_STARTUP_TIMEOUT_MS,
    });
  }

  if (requested.has('m365') && HAS_M365_MCP) {
    configs.push({
      serverName: 'm365',
      transport: 'stdio',
      command: 'm365-mcp',
      args: [],
      env: {
        ...env,
        MS_CLIENT_ID: context.agentEnv.OUTLOOK_CLIENT_ID ?? '',
        MS_CLIENT_SECRET: context.agentEnv.OUTLOOK_CLIENT_SECRET ?? '',
        MS_TENANT_ID: context.agentEnv.MS_TENANT_ID ?? '',
        USE_TEST_MODE: 'false',
      },
      startupTimeoutMs: DEFAULT_MCP_STARTUP_TIMEOUT_MS,
    });
  }

  return configs;
}

async function connectMcpServers(
  context: AgentTurnContext,
): Promise<{
  clients: Map<string, Client>;
  transports: Array<StdioClientTransport | StreamableHTTPClientTransport>;
  toolDefinitions: OpenAIToolDefinition[];
  bindings: Map<string, McpToolBinding>;
} | null> {
  const bindings = new Map<string, McpToolBinding>();
  const toolDefinitions: OpenAIToolDefinition[] = [];
  const clients = new Map<string, Client>();
  const transports: Array<StdioClientTransport | StreamableHTTPClientTransport> =
    [];

  for (const server of getMcpServerConfigs(context)) {
    const transport =
      server.transport === 'streamable-http'
        ? new StreamableHTTPClientTransport(new URL(server.url!), {
            requestInit: server.requestInit,
          })
        : new StdioClientTransport({
            command: server.command!,
            args: server.args,
            cwd: server.cwd,
            env: server.env,
            stderr: 'pipe',
          });

    if (transport instanceof StdioClientTransport) {
      const stderr = transport.stderr;
      if (stderr) {
        stderr.on('data', (chunk) => {
          const text = chunk.toString().trim();
          if (text) context.log(`[mcp:${server.serverName}] ${text}`);
        });
      }
    }

    const client = new Client(
      {
        name: `openai-mcp-bridge-${server.serverName}`,
        version: '1.0.0',
      },
      { capabilities: {} },
    );

    try {
      await client.connect(transport, {
        timeout: server.startupTimeoutMs || DEFAULT_MCP_STARTUP_TIMEOUT_MS,
      });
      const { tools } = await client.listTools(undefined, {
        timeout: server.startupTimeoutMs || DEFAULT_MCP_STARTUP_TIMEOUT_MS,
      });
      clients.set(server.serverName, client);
      transports.push(transport);

      for (const tool of tools) {
        const openAiName = sanitizeToolName(
          `mcp_${server.serverName}__${tool.name}`,
        );
        bindings.set(openAiName, {
          openAiName,
          serverName: server.serverName,
          mcpName: tool.name,
        });
        toolDefinitions.push({
          type: 'function',
          name: openAiName,
          description:
            tool.description ||
            `Call the ${server.serverName} MCP tool "${tool.name}".`,
          parameters: {
            type: 'object',
            properties: tool.inputSchema.properties || {},
            required: tool.inputSchema.required || [],
            additionalProperties: false,
          },
        });
      }

      context.log(
        `Connected MCP server ${server.serverName} with ${tools.length} tool(s)`,
      );
    } catch (err) {
      context.log(
        `Failed to connect MCP server ${server.serverName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      try {
        await transport.close();
      } catch {
        // Ignore close failures after a failed init.
      }
    }
  }

  return { clients, transports, toolDefinitions, bindings };
}

function formatMcpToolResult(result: {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}): string {
  const parts: string[] = [];

  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (item.type === 'resource_link' && typeof item.name === 'string') {
        parts.push(
          `Resource: ${item.name}${typeof item.uri === 'string' ? ` (${item.uri})` : ''}`,
        );
      } else if (item.type === 'resource' && item.resource) {
        parts.push(JSON.stringify(item.resource));
      } else {
        parts.push(JSON.stringify(item));
      }
    }
  }

  if (result.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }

  return JSON.stringify({
    ok: !result.isError,
    is_error: !!result.isError,
    output: truncateOutput(parts.join('\n\n').trim()),
  });
}

function normalizeMcpCallResult(result: {
  [key: string]: unknown;
}): { content?: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown>; isError?: boolean } {
  if ('toolResult' in result) {
    return {
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.toolResult, null, 2),
        },
      ],
    };
  }

  return result as {
    content?: Array<Record<string, unknown>>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

function extractTextFromResponse(payload: unknown): string {
  if (
    payload &&
    typeof payload === 'object' &&
    'output_text' in payload &&
    typeof (payload as { output_text?: unknown }).output_text === 'string'
  ) {
    return (payload as { output_text: string }).output_text;
  }

  const output = (payload as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(output)) return '';

  const texts: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    for (const chunk of content) {
      const text =
        (chunk as { text?: unknown; type?: unknown }).type === 'output_text'
          ? (chunk as { text?: unknown }).text
          : (chunk as { text?: unknown }).text;
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts.join('\n').trim();
}

function extractFunctionCalls(payload: unknown): ResponsesFunctionCall[] {
  const output = (payload as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(output)) return [];
  return output.filter(
    (item): item is ResponsesFunctionCall =>
      !!item &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'function_call' &&
      typeof (item as { call_id?: unknown }).call_id === 'string' &&
      typeof (item as { name?: unknown }).name === 'string' &&
      typeof (item as { arguments?: unknown }).arguments === 'string',
  );
}

function summarizeResponseOutput(payload: unknown): string {
  const output = (payload as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(output) || output.length === 0) return 'none';
  return output
    .map((item) => {
      const type =
        item && typeof item === 'object' && 'type' in item
          ? String((item as { type?: unknown }).type)
          : 'unknown';
      const status =
        item && typeof item === 'object' && 'status' in item
          ? String((item as { status?: unknown }).status)
          : 'n/a';
      return `${type}:${status}`;
    })
    .join(', ');
}

async function runShellTool(
  argsJson: string,
  context: AgentTurnContext,
): Promise<string> {
  let args: {
    command: string;
    working_directory?: string;
    timeout_ms?: number;
  };

  try {
    args = JSON.parse(argsJson) as {
      command: string;
      working_directory?: string;
      timeout_ms?: number;
    };
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: `Invalid shell arguments JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const command = args.command?.trim();
  if (!command) {
    return JSON.stringify({
      ok: false,
      error: 'shell tool requires a non-empty command',
    });
  }

  const cwd = args.working_directory || '/workspace/group';
  const timeout = args.timeout_ms || DEFAULT_SHELL_TIMEOUT_MS;
  context.log(
    `OpenAI shell tool: cwd=${cwd} timeout=${timeout} command=${command.slice(
      0,
      200,
    )}`,
  );

  try {
    const env = Object.fromEntries(
      Object.entries(context.agentEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', command], {
      cwd,
      timeout,
      maxBuffer: MAX_TOOL_OUTPUT_CHARS * 2,
      env,
    });

    return JSON.stringify({
      ok: true,
      exit_code: 0,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
    });
  } catch (err) {
    const error = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return JSON.stringify({
      ok: false,
      exit_code:
        typeof error.code === 'number' ? error.code : String(error.code || ''),
      stdout: truncateOutput(error.stdout || ''),
      stderr: truncateOutput(error.stderr || ''),
      error: error.message || 'shell command failed',
    });
  }
}

async function runWebFetchTool(
  argsJson: string,
  context: AgentTurnContext,
): Promise<string> {
  let args: { url: string; timeout_ms?: number };
  try {
    args = JSON.parse(argsJson) as { url: string; timeout_ms?: number };
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: `Invalid web_fetch arguments JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const url = args.url?.trim();
  if (!url) {
    return JSON.stringify({ ok: false, error: 'web_fetch requires a URL' });
  }

  const curlArgs = [
    '-L',
    '--silent',
    '--show-error',
    '--max-time',
    String(
      Math.ceil((args.timeout_ms || DEFAULT_WEB_TIMEOUT_MS) / 1000),
    ),
  ];
  const env = Object.fromEntries(
    Object.entries(context.agentEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const insecureTls =
    (context.agentEnv.WEB_FETCH_INSECURE_TLS || '').toLowerCase() === 'true';
  const caBundle = context.agentEnv.WEB_FETCH_CA_BUNDLE?.trim();
  if (insecureTls) {
    curlArgs.push('--insecure');
  } else if (caBundle) {
    curlArgs.push('--cacert', caBundle);
  }
  curlArgs.push(url);

  try {
    context.log(
      `OpenAI web_fetch: url=${url} insecure_tls=${insecureTls} ca_bundle=${caBundle || 'default'}`,
    );
    const { stdout, stderr } = await execFileAsync('/usr/bin/curl', curlArgs, {
      cwd: '/workspace/group',
      timeout: args.timeout_ms || DEFAULT_WEB_TIMEOUT_MS,
      maxBuffer: MAX_TOOL_OUTPUT_CHARS * 2,
      env,
    });

    return JSON.stringify({
      ok: true,
      url,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
    });
  } catch (err) {
    const error = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return JSON.stringify({
      ok: false,
      url,
      exit_code:
        typeof error.code === 'number' ? error.code : String(error.code || ''),
      stdout: truncateOutput(error.stdout || ''),
      stderr: truncateOutput(error.stderr || ''),
      error: error.message || 'web_fetch failed',
    });
  }
}

async function runWebSearchTool(
  argsJson: string,
  context: AgentTurnContext,
): Promise<string> {
  let args: { query: string; timeout_ms?: number };
  try {
    args = JSON.parse(argsJson) as { query: string; timeout_ms?: number };
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: `Invalid web_search arguments JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const query = args.query?.trim();
  if (!query) {
    return JSON.stringify({ ok: false, error: 'web_search requires a query' });
  }

  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
  return runWebFetchTool(
    JSON.stringify({
      url: searchUrl,
      timeout_ms: args.timeout_ms || DEFAULT_WEB_TIMEOUT_MS,
    }),
    context,
  );
}

async function runMcpTool(
  argsJson: string,
  binding: McpToolBinding,
  clients: Map<string, Client>,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: `Invalid ${binding.mcpName} arguments JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  try {
    const client = clients.get(binding.serverName);
    if (!client) {
      return JSON.stringify({
        ok: false,
        error: `MCP server ${binding.serverName} is not connected`,
      });
    }
    const result = await client.callTool(
      { name: binding.mcpName, arguments: args },
      CallToolResultSchema,
    );
    return formatMcpToolResult(normalizeMcpCallResult(result));
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: `MCP tool ${binding.mcpName} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

async function runOpenAITurn(
  context: AgentTurnContext,
): Promise<AgentTurnResult> {
  const sessionId = context.sessionId || crypto.randomUUID();
  const state = loadSessionState(sessionId);
  const model = context.agentEnv.AGENT_MODEL || DEFAULT_OPENAI_MODEL;
  const baseUrl = (context.agentEnv.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(
    /\/$/,
    '',
  );
  const apiKey = context.agentEnv.OPENAI_API_KEY || '';
  const compiledPrompt = buildPrompt(state.history, context.prompt, context);

  context.log(
    `Running OpenAI turn (session: ${sessionId}, model: ${model}, history: ${state.history.length})`,
  );

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
  const mcp = await connectMcpServers(context);
  try {
    const tools = [
      ...getBuiltinToolDefinitions(),
      ...(mcp?.toolDefinitions || []),
    ];
    const conversationInput: unknown[] = [
      {
        type: 'message',
        role: 'user',
        content: compiledPrompt,
      },
    ];
    let requestBody: Record<string, unknown> = {
      model,
      input: conversationInput,
      tools,
    };
    let payload: unknown;

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      const response = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `OpenAI request failed (${response.status}): ${errorBody}`,
        );
      }

      payload = (await response.json()) as unknown;
      context.log(
        `OpenAI response loop=${loop + 1} output=${summarizeResponseOutput(payload)}`,
      );
      const functionCalls = extractFunctionCalls(payload);
      if (functionCalls.length === 0) break;

      context.log(`OpenAI requested ${functionCalls.length} tool call(s)`);
      const toolOutputs: Array<{
        type: 'function_call_output';
        call_id: string;
        output: string;
      }> = [];
      for (const call of functionCalls) {
        let output: string;
        switch (call.name) {
          case 'shell':
            output = await runShellTool(call.arguments, context);
            break;
          case 'web_fetch':
            output = await runWebFetchTool(call.arguments, context);
            break;
          case 'web_search':
            output = await runWebSearchTool(call.arguments, context);
            break;
          default: {
            const binding = mcp?.bindings.get(call.name);
            output =
              binding && mcp
                ? await runMcpTool(call.arguments, binding, mcp.clients)
                : JSON.stringify({
                    ok: false,
                    error: `Unsupported tool: ${call.name}`,
                  });
          }
        }

        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output,
        });
      }

      conversationInput.push(...functionCalls, ...toolOutputs);

      requestBody = {
        model,
        input: conversationInput,
        tools,
      };
    }

    if (!payload) {
      throw new Error('OpenAI response payload missing');
    }

    const text = extractTextFromResponse(payload);

    state.history.push({ role: 'user', content: context.prompt });
    state.history.push({
      role: 'assistant',
      content: containsLegacyToolRefusal(text)
        ? 'Skipped legacy tool-refusal response.'
        : text,
    });
    saveSessionState(sessionId, state);

    context.emitOutput({
      status: 'success',
      result: text || null,
      newSessionId: sessionId,
    });

    return {
      newSessionId: sessionId,
      closedDuringQuery: false,
    };
  } finally {
    if (mcp) {
      for (const transport of mcp.transports) {
        try {
          await transport.close();
        } catch {
          // Ignore MCP shutdown errors.
        }
      }
    }
  }
}

export const openaiProvider: AgentProvider = {
  name: 'openai',
  runTurn: runOpenAITurn,
};
