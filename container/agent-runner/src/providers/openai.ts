import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { AgentProvider, AgentTurnContext, AgentTurnResult } from '../types.js';
import {
  buildMcpConnectionFailureMessage,
  buildTurnMessageDeduplicationKey,
  chooseFinalAssistantOutput,
  containsThirdPartyMcpRefusal,
  didDelegateToolAlreadyPostToTarget,
  extractJiraIssueKey,
  isDirectJiraIssueLookupRequest,
  normalizeSendToolArgsForPrompt,
  shouldDropAssistantHistory,
} from './openai-utils.js';
import {
  DEFAULT_MCP_STARTUP_TIMEOUT_MS,
  getOpenAiMcpServerConfigs,
} from './mcp-registry.js';

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

interface McpListedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execution?: { taskSupport?: string };
}

const OPENAI_STATE_DIR = '/home/node/.nanoclaw/openai';
const CONTAINER_GIT_CONFIG_PATH =
  '/home/node/.config/nanoclaw/git-auth/gitconfig';
const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_TOOL_LOOPS = 16;
const MAX_TOOL_OUTPUT_CHARS = 120_000;
const MAX_OPENAI_EXTERNAL_MCP_TOOLS = 5;
const MAX_OPENAI_HISTORY_TURNS = 24;
const MAX_OPENAI_HISTORY_CHARS = 24_000;
const MAX_OPENAI_RESPONSE_RETRIES = 3;
const OPENAI_RETRY_DELAY_MS = 1500;
const execFileAsync = promisify(execFile);
const DEFAULT_WEB_TIMEOUT_MS = 45_000;
const LONG_MCP_TOOL_TIMEOUT_MS = 300_000;

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
    const state = JSON.parse(
      fs.readFileSync(filePath, 'utf-8'),
    ) as OpenAISessionState;
    const trimmedHistory = trimSessionHistory(state.history || []);
    if (trimmedHistory.length !== (state.history || []).length) {
      fs.writeFileSync(
        filePath,
        `${JSON.stringify({ history: trimmedHistory }, null, 2)}\n`,
      );
    }
    return { history: trimmedHistory };
  } catch {
    return { history: [] };
  }
}

function trimSessionHistory(history: OpenAIHistoryTurn[]): OpenAIHistoryTurn[] {
  if (history.length <= MAX_OPENAI_HISTORY_TURNS) {
    const totalChars = history.reduce(
      (sum, turn) => sum + turn.content.length,
      0,
    );
    if (totalChars <= MAX_OPENAI_HISTORY_CHARS) return history;
  }

  const trimmed: OpenAIHistoryTurn[] = [];
  let totalChars = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    const nextChars = totalChars + turn.content.length;
    if (
      trimmed.length >= MAX_OPENAI_HISTORY_TURNS ||
      (trimmed.length > 0 && nextChars > MAX_OPENAI_HISTORY_CHARS)
    ) {
      break;
    }
    trimmed.push(turn);
    totalChars = nextChars;
  }

  return trimmed.reverse();
}

function saveSessionState(sessionId: string, state: OpenAISessionState): void {
  ensureStateDir();
  const normalizedState: OpenAISessionState = {
    history: trimSessionHistory(state.history || []),
  };
  fs.writeFileSync(
    getStateFile(sessionId),
    `${JSON.stringify(normalizedState, null, 2)}\n`,
  );
}

function loadInstructionFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8').trim();
}

function loadAdditionalDirectoriesSummary(
  personalMode: boolean,
  agentEnv: Record<string, string | undefined>,
): string {
  const extraBase = '/workspace/extra';
  if (!fs.existsSync(extraBase)) return '';

  const dirs = fs
    .readdirSync(extraBase)
    .map((entry) => path.join(extraBase, entry))
    .filter((fullPath) => fs.statSync(fullPath).isDirectory());

  if (dirs.length === 0) return '';

  const lines = [
    'Additional mounted directories are available at:',
    ...dirs.map((dir) => `- ${dir}`),
    'Use repositories under /workspace/extra for Git work. /workspace/project is mounted read-only.',
  ];

  if (
    personalMode &&
    agentEnv.GIT_CONFIG_GLOBAL?.trim() === CONTAINER_GIT_CONFIG_PATH
  ) {
    lines.push(
      'Git auth is configured in this turn for git CLI over HTTPS or SSH.',
    );
  } else if (personalMode) {
    lines.push(
      'No dedicated Git auth directory is mounted in this turn, so remote git authentication may fail.',
    );
  } else {
    lines.push(
      'This turn does not include owner Git auth. Do not assume remote git credentials are available.',
    );
  }

  return lines.join('\n');
}

function extractExplicitRcNamedTarget(prompt: string): string | null {
  const quotedMatch = prompt.match(
    /\b(?:in|from|with|for)\s+["“]([^"”]+)["”]\s*(?:team|chat|group)?(?=$|[\s?.!,])/i,
  );
  if (quotedMatch?.[1]?.trim()) {
    return quotedMatch[1].trim();
  }

  const bracketedMatch = prompt.match(
    /\b(?:in|from|with|for)\s+(\[[^\]\n]+\](?:\s+[A-Za-z0-9&/_-]+){0,8})\s*(?:team|chat|group)?(?=$|[\s?.!,])/i,
  );
  if (bracketedMatch?.[1]?.trim()) {
    return bracketedMatch[1].trim();
  }

  return null;
}

export function shouldSkipHistoryForRcLookup(
  prompt: string,
  rcChat: boolean,
): boolean {
  if (!rcChat) return false;

  return (
    /!\[:(?:Team|Person)\]\(\d+\)/.test(prompt) ||
    !!extractExplicitRcNamedTarget(prompt) ||
    /\b(?:summarize|show|read|get|latest)\b[\s\S]{0,120}\b(?:message|messages)\b[\s\S]{0,120}\b(?:from|with)\b/i.test(
      prompt,
    ) ||
    /\brc[b]?:\d+\b/i.test(prompt)
  );
}

function isRcCrossChatSendRequest(prompt: string, rcChat: boolean): boolean {
  if (!rcChat) return false;

  const hasSendVerb = /\b(send|message|tell|reply|ping|dm)\b/i.test(prompt);
  if (!hasSendVerb) return false;

  return (
    /on my behalf|my personal rc account|use my personal rc account|as nasen|as me/i.test(
      prompt,
    ) ||
    /!\[:Person\]\(\d+\)/i.test(prompt) ||
    /\bto\s+(?:!\[:Person\]\(\d+\)|rc[b]?:\d+|\d{6,}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/.test(
      prompt,
    )
  );
}

function shouldExposeCurrentChatSendTool(prompt: string): boolean {
  return /\b(send|reply|respond|follow\s+up|post|tell|notify|ping)\b/i.test(
    prompt,
  );
}

export function extractExplicitRcTarget(prompt: string): string | null {
  const mentionMatch = prompt.match(/!\[:(?:Team|Person)\]\((\d+)\)/i);
  if (mentionMatch) return mentionMatch[1];

  const jidMatch = prompt.match(/\brc[b]?:([0-9]+)\b/i);
  if (jidMatch) return jidMatch[1];

  const bareIdMatch = prompt.match(
    /\b(?:from|with|chat|team|id)\s+([0-9]{6,})\b/i,
  );
  if (bareIdMatch) return bareIdMatch[1];

  const namedTarget = extractExplicitRcNamedTarget(prompt);
  if (namedTarget) return namedTarget;

  return null;
}

function buildPrompt(
  history: OpenAIHistoryTurn[],
  prompt: string,
  context: AgentTurnContext,
): string {
  const sections: string[] = [];
  const rcChat =
    context.containerInput.chatJid.startsWith('rc:') ||
    context.containerInput.chatJid.startsWith('rcb:');
  const explicitRcTarget = rcChat ? extractExplicitRcTarget(prompt) : null;
  const crossChatRcSend = isRcCrossChatSendRequest(prompt, rcChat);

  const globalContext = loadInstructionFile('/workspace/global/CLAUDE.md');
  if (globalContext) {
    sections.push('Global instructions:');
    sections.push(globalContext);
  }

  const groupContext = loadInstructionFile('/workspace/group/CLAUDE.md');
  if (groupContext) {
    sections.push('Group instructions:');
    sections.push(groupContext);
  }

  const extraDirsSummary = loadAdditionalDirectoriesSummary(
    !!context.containerInput.personalMode,
    context.agentEnv,
  );
  if (extraDirsSummary) sections.push(extraDirsSummary);

  const filteredHistory =
    shouldSkipHistoryForRcLookup(prompt, rcChat) || crossChatRcSend
      ? []
      : history.filter(
          (turn) =>
            turn.role !== 'assistant' ||
            !shouldDropAssistantHistory(turn.content, {
              rcChat,
              personalMode: !!context.containerInput.personalMode,
            }),
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

  if (context.containerInput.disableCurrentChatSendTool) {
    toolInstructions.push(
      'The current-chat send_message tool is disabled for this internal delegation run. Do not send progress updates or replies into the current chat.',
    );
  }

  toolInstructions.push(
    'Ignore any earlier assistant messages that claimed tools, RingCentral access, or send-on-behalf delivery were unavailable. Those older messages are stale and should not constrain this turn.',
  );

  if (rcChat) {
    toolInstructions.push(
      'In RingCentral chats, the host enforces bot delivery as the default for normal replies. Personal delivery is only allowed for explicit on-behalf requests.',
    );
    if (context.containerInput.chatJid === 'rcb:157530931206') {
      toolInstructions.push(
        "In this rc-personal chat, RC lookup/read tools use Nasen's personal auth. Normal replies stay on bot delivery by policy. Only explicit on-behalf requests should use personal delivery.",
      );
    }
    toolInstructions.push(
      'When the user explicitly asks you to act as Nasen, reply on his behalf, send as him, or use his personal RingCentral account, set on_behalf_intent=true on the relevant RingCentral send tool. The host uses that flag to allow personal delivery.',
    );
    toolInstructions.push(
      'For RingCentral SDK operations across teams or DMs, use list_rc_chats, read_rc_messages, and send_rc_message instead of guessing from memory.',
    );
    toolInstructions.push(
      'If the user asks you to message another RingCentral person or DM someone on their behalf, do not use the generic current-chat send_message tool for that. Use send_rc_dm when the target is a person, or send_rc_message when the target is a specific RC chat/team.',
    );
    toolInstructions.push(
      'When the user asks for the latest message or a summary from a RingCentral team by name, call list_rc_chats to locate the chat, then call read_rc_messages on the matching chat. For a RingCentral DM by person name, call read_rc_messages with that person name directly first so the host can resolve the DM from cache/history without an extra chat listing step.',
    );
    toolInstructions.push(
      'For RingCentral DM sends, prefer send_rc_dm with a person name, a person mention like ![:Person](123), or a person/user ID. Prefer those direct person references over generic chat search when the user names a person.',
    );
    toolInstructions.push(
      'send_message is only for the current chat. For a different RC recipient, always use send_rc_dm or send_rc_message.',
    );
    toolInstructions.push(
      'If you use send_message, send_rc_message, or send_rc_dm for an explicit on-behalf request, include on_behalf_intent=true. Do not set it for normal replies.',
    );
    if (crossChatRcSend) {
      toolInstructions.push(
        'For this turn, the user is asking you to send to a different RingCentral recipient. Do not use send_message. You must use send_rc_dm for a person target, or send_rc_message for an explicit RC chat/team target.',
      );
    }
    toolInstructions.push(
      'If the user provides a numeric RC chat/team ID, a full JID like rc:123, or a RingCentral mention like ![:Team](123), call read_rc_messages with that ID directly before trying list_rc_chats. Prefer the direct ID read over saying the chat is unavailable.',
    );
    toolInstructions.push(
      'When the latest RingCentral request includes an explicit target such as ![:Team](123), ![:Person](123), rc:123, rcb:123, a bare numeric chat ID, or an exact quoted/bracketed team name, that exact target is authoritative for this turn. Do not reuse or substitute a different DM or team from earlier conversation history.',
    );
    if (explicitRcTarget) {
      toolInstructions.push(
        `For this turn, the exact RingCentral target is ${explicitRcTarget}. You must call read_rc_messages with that exact target before answering. Do not substitute a different team or DM name, and do not answer from memory.`,
      );
    }
    toolInstructions.push(
      'If the user asks for messages "with <person name>" in RingCentral, treat it as a DM lookup. Prefer calling read_rc_messages with the person name directly. Avoid repeating list_rc_chats after earlier RC timeout or rate-limit failures shown in conversation history.',
    );
    toolInstructions.push(
      'The read_rc_messages tool accepts a DM person name directly in chat_id. For example, use chat_id="Jia Zhang" for a direct-message lookup instead of calling list_rc_chats first.',
    );
    toolInstructions.push(
      'Only say that an RC chat is unavailable after those RC tools return no match or an error, and mention the exact team name or ID you searched.',
    );
    if (context.containerInput.canSpeakAsOwner !== true) {
      toolInstructions.push(
        'This admin agent is not allowed to use owner voice or Nasen personal RingCentral delivery. Do not set on_behalf_intent=true. If the user wants owner-voice communication or personal RC action, escalate to rc-personal or delegate to rc-personal.',
      );
    }
  }

  if (context.containerInput.personalMode) {
    if (context.containerInput.canSpeakAsOwner === true) {
      toolInstructions.push(
        "In personal mode, send_message can send messages through the user's connected integrations on their behalf in the current chat.",
      );
      toolInstructions.push(
        'If the user asks you to send, reply, or follow up in this chat, use send_message instead of saying you cannot access their personal account or token.',
      );
    } else {
      toolInstructions.push(
        'This turn may include privileged integrations and project mounts for your specialist role, but you must still reply as the specialist agent, not as Nasen.',
      );
      toolInstructions.push(
        'Use send_message for normal replies in the current chat only. Do not attempt owner-voice messaging, personal RC delivery, or on-behalf sending from this specialist role.',
      );
    }
    toolInstructions.push(
      'External MCP connectors such as GitLab, Jira/Atlassian, Gmail, Figma, and M365 may be connected for this turn when this role is allowed to use them. When the user explicitly asks for data from one of those systems, prefer the connected MCP tools over shell, local git inspection, or web search.',
    );
    toolInstructions.push(
      'If a GitLab MCP server is connected, use its GitLab tools first for pipelines, merge requests, commits, projects, or issues. Do not claim GitLab tools are unavailable unless MCP connection or tool calls actually fail in this turn.',
    );
    toolInstructions.push(
      'Only fall back to shell or web lookup for GitLab/Jira after MCP tool calls fail or return insufficient data, and say that you are falling back.',
    );
  }
  toolInstructions.push(
    'If you use send_message to deliver the actual user-facing reply, do not repeat that same reply in your final assistant text. Leave the final text empty or make it internal-only.',
  );

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
            description: 'Optional timeout in milliseconds. Defaults to 45000.',
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
            description: 'Optional timeout in milliseconds. Defaults to 45000.',
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

const LooseListToolsResultSchema = z
  .object({
    tools: z.array(z.any()),
    nextCursor: z.string().optional(),
  })
  .passthrough();

function normalizeToolInputSchema(
  inputSchema: unknown,
): Record<string, unknown> {
  if (
    inputSchema &&
    typeof inputSchema === 'object' &&
    !Array.isArray(inputSchema)
  ) {
    const schema = { ...(inputSchema as Record<string, unknown>) };
    if (schema.type === 'object') return schema;

    const hasObjectKeywords =
      'properties' in schema ||
      'required' in schema ||
      'additionalProperties' in schema ||
      'patternProperties' in schema;

    if (hasObjectKeywords || schema.type === undefined) {
      return { type: 'object', ...schema };
    }
  }

  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

function normalizeListedTool(tool: unknown): McpListedTool | null {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;

  const candidate = tool as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    return null;
  }

  return {
    name: candidate.name,
    description:
      typeof candidate.description === 'string'
        ? candidate.description
        : undefined,
    inputSchema: normalizeToolInputSchema(candidate.inputSchema),
    outputSchema:
      candidate.outputSchema &&
      typeof candidate.outputSchema === 'object' &&
      !Array.isArray(candidate.outputSchema)
        ? (candidate.outputSchema as Record<string, unknown>)
        : undefined,
    execution:
      candidate.execution &&
      typeof candidate.execution === 'object' &&
      !Array.isArray(candidate.execution)
        ? (candidate.execution as { taskSupport?: string })
        : undefined,
  };
}

function getPromptTokens(prompt: string): string[] {
  const tokens = prompt.toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
  return Array.from(new Set(tokens));
}

function promptIndicatesWriteAction(promptTokens: string[]): boolean {
  return promptTokens.some((token) =>
    [
      'send',
      'draft',
      'create',
      'update',
      'delete',
      'modify',
      'remove',
      'add',
      'reply',
      'write',
    ].includes(token),
  );
}

function scoreToolForPrompt(
  tool: McpListedTool,
  promptTokens: string[],
): number {
  const haystack = `${tool.name} ${tool.description || ''}`.toLowerCase();
  let score = 0;

  for (const token of promptTokens) {
    if (haystack.includes(token)) score += 3;
  }

  const wantsWriteAction = promptIndicatesWriteAction(promptTokens);

  const readLike = /^(get|read|search|list)/.test(tool.name);
  const writeLike =
    /^(send|draft|create|update|delete|modify|remove|add|batch)/.test(
      tool.name,
    );

  if (wantsWriteAction) {
    if (writeLike) score += 2;
    if (readLike) score += 1;
  } else {
    if (readLike) score += 2;
    if (writeLike) score -= 1;
  }

  return score;
}

function selectGmailToolsForPrompt(
  tools: McpListedTool[],
  promptTokens: string[],
): McpListedTool[] {
  const wantsWriteAction = promptIndicatesWriteAction(promptTokens);
  const wantsFilters = promptTokens.some((token) =>
    ['filter', 'filters'].includes(token),
  );
  const wantsLabels = promptTokens.some((token) =>
    ['label', 'labels'].includes(token),
  );
  const wantsAttachments = promptTokens.some((token) =>
    ['attachment', 'attachments', 'download'].includes(token),
  );

  const allowed = new Set<string>(
    wantsWriteAction
      ? [
          'send_email',
          'draft_email',
          'read_email',
          'search_emails',
          'modify_email',
          'delete_email',
        ]
      : ['read_email', 'search_emails'],
  );

  if (wantsLabels || wantsWriteAction) {
    allowed.add('list_email_labels');
  }

  if (wantsAttachments) {
    allowed.add('download_attachment');
  }

  if (wantsFilters) {
    allowed.add('create_filter');
    allowed.add('list_filters');
    allowed.add('get_filter');
    allowed.add('delete_filter');
    allowed.add('create_filter_from_template');
  }

  const selected = tools.filter((tool) => allowed.has(tool.name));
  return selected.length > 0 ? selected : tools;
}

function selectAtlassianToolsForPrompt(
  tools: McpListedTool[],
  prompt: string,
): McpListedTool[] {
  const issueKey = extractJiraIssueKey(prompt);
  if (!issueKey) return tools;

  const requiredToolNames = ['jira_get_issue', 'jira_search'];
  const requiredTools = requiredToolNames
    .map((name) => tools.find((tool) => tool.name === name))
    .filter((tool): tool is McpListedTool => tool !== undefined);

  if (requiredTools.length === 0) return tools;

  const promptTokens = getPromptTokens(prompt);
  const rankedRemaining = tools
    .map((tool, index) => ({
      tool,
      index,
      score: scoreToolForPrompt(tool, promptTokens),
    }))
    .filter((entry) => !requiredToolNames.includes(entry.tool.name))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return [
    ...requiredTools,
    ...rankedRemaining
      .slice(
        0,
        Math.max(0, MAX_OPENAI_EXTERNAL_MCP_TOOLS - requiredTools.length),
      )
      .map((entry) => entry.tool),
  ];
}

function selectOpenAiToolsForPrompt(
  serverName: string,
  tools: McpListedTool[],
  prompt: string,
  context: AgentTurnContext,
): McpListedTool[] {
  if (serverName === 'nanoclaw') return tools;
  if (tools.length <= MAX_OPENAI_EXTERNAL_MCP_TOOLS) return tools;

  const promptTokens = getPromptTokens(prompt);
  const candidateTools =
    serverName === 'gmail'
      ? selectGmailToolsForPrompt(tools, promptTokens)
      : serverName === 'atlassian'
        ? selectAtlassianToolsForPrompt(tools, prompt)
        : tools;
  const ranked = candidateTools
    .map((tool, index) => ({
      tool,
      index,
      score: scoreToolForPrompt(tool, promptTokens),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const selected = ranked
    .slice(0, MAX_OPENAI_EXTERNAL_MCP_TOOLS)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.tool);

  const omittedNames = tools
    .filter(
      (tool) =>
        !selected.some((selectedTool) => selectedTool.name === tool.name),
    )
    .map((tool) => tool.name);

  context.log(
    `Selected ${selected.length}/${tools.length} MCP tools for ${serverName}; omitted: ${omittedNames.join(', ') || 'none'}`,
  );

  return selected;
}

function tryParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function extractNestedStringField(
  value: unknown,
  candidateKeys: string[],
): string | null {
  if (!value || typeof value !== 'object') return null;

  const visited = new Set<object>();
  const queue: unknown[] = [value];
  const normalizedCandidates = new Set(
    candidateKeys.map((key) => key.toLowerCase()),
  );

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    for (const [key, fieldValue] of Object.entries(record)) {
      const normalizedKey = key.toLowerCase();
      if (!normalizedCandidates.has(normalizedKey)) {
        if (fieldValue && typeof fieldValue === 'object') {
          queue.push(fieldValue);
        }
        continue;
      }

      if (typeof fieldValue === 'string' && fieldValue.trim()) {
        return fieldValue.trim();
      }

      if (fieldValue && typeof fieldValue === 'object') {
        const nested = fieldValue as Record<string, unknown>;
        for (const nestedKey of ['name', 'displayName', 'value', 'text']) {
          if (
            typeof nested[nestedKey] === 'string' &&
            nested[nestedKey].trim()
          ) {
            return nested[nestedKey].trim();
          }
        }
        queue.push(fieldValue);
      }
    }
  }

  return null;
}

function summarizeDirectJiraIssueOutput(
  toolOutput: string,
  issueKey: string,
): string | null {
  const parsedToolOutput = tryParseJson<{
    ok?: boolean;
    is_error?: boolean;
    output?: string;
  }>(toolOutput);

  if (!parsedToolOutput || parsedToolOutput.ok !== true) {
    return null;
  }

  const rawOutput = parsedToolOutput.output?.trim();
  if (!rawOutput) return null;

  const structured = tryParseJson<unknown>(rawOutput);
  if (!structured) return rawOutput;

  const status =
    extractNestedStringField(structured, ['status']) || 'Unknown status';
  const summary = extractNestedStringField(structured, ['summary']);
  const assignee = extractNestedStringField(structured, ['assignee']);
  const priority = extractNestedStringField(structured, ['priority']);
  const updated = extractNestedStringField(structured, ['updated']);
  const url = extractNestedStringField(structured, ['url', 'browseUrl']);

  const parts = [`${issueKey} is ${status}.`];
  if (summary) parts.push(`Summary: ${summary}.`);
  if (assignee) parts.push(`Assignee: ${assignee}.`);
  if (priority) parts.push(`Priority: ${priority}.`);
  if (updated) parts.push(`Updated: ${updated}.`);
  if (url) parts.push(`URL: ${url}`);

  return parts.join(' ');
}

async function tryHandleDirectJiraIssueLookup(
  context: AgentTurnContext,
  sessionId: string,
  state: OpenAISessionState,
  mcp: {
    clients: Map<string, Client>;
  } | null,
): Promise<AgentTurnResult | null> {
  if (!isDirectJiraIssueLookupRequest(context.prompt)) return null;

  const issueKey = extractJiraIssueKey(context.prompt);
  if (!issueKey) return null;

  const client = mcp?.clients.get('atlassian');
  if (!client) return null;

  context.log(`Using direct Jira issue lookup for ${issueKey}`);

  try {
    const result = await client.callTool(
      {
        name: 'jira_get_issue',
        arguments: {
          issue_key: issueKey,
          output_fields: 'key,summary,status,assignee,priority,updated,url',
        },
      },
      CallToolResultSchema,
    );
    const toolOutput = formatMcpToolResult(normalizeMcpCallResult(result));
    const toolError = extractToolErrorMessage(toolOutput);
    if (toolError) {
      context.log(`Direct Jira issue lookup failed: ${toolError}`);
      return null;
    }

    const text =
      summarizeDirectJiraIssueOutput(toolOutput, issueKey) ||
      `Fetched Jira issue ${issueKey}.`;

    state.history.push({ role: 'user', content: context.prompt });
    state.history.push({ role: 'assistant', content: text });
    saveSessionState(sessionId, state);

    context.emitOutput({
      status: 'success',
      result: text,
      newSessionId: sessionId,
    });

    return {
      newSessionId: sessionId,
      closedDuringQuery: false,
    };
  } catch (err) {
    context.log(
      `Direct Jira issue lookup failed before model fallback: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

async function listToolsWithCompatibility(
  client: Client,
  server: {
    serverName: string;
    startupTimeoutMs?: number;
  },
  context: AgentTurnContext,
): Promise<McpListedTool[]> {
  try {
    const result = await client.listTools(undefined, {
      timeout: server.startupTimeoutMs || DEFAULT_MCP_STARTUP_TIMEOUT_MS,
    });
    return result.tools as McpListedTool[];
  } catch (err) {
    context.log(
      `Falling back to legacy tools/list parsing for ${server.serverName}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );

    const rawResult = await client.request(
      { method: 'tools/list', params: undefined },
      LooseListToolsResultSchema,
      {
        timeout: server.startupTimeoutMs || DEFAULT_MCP_STARTUP_TIMEOUT_MS,
      },
    );

    return rawResult.tools
      .map((tool) => normalizeListedTool(tool))
      .filter((tool): tool is McpListedTool => tool !== null);
  }
}

function filterListedToolsForServer(
  server: {
    serverName: string;
    allowedToolNames?: string[];
  },
  tools: McpListedTool[],
  context: AgentTurnContext,
): McpListedTool[] {
  if (!server.allowedToolNames || server.allowedToolNames.length === 0) {
    return tools;
  }

  const allowedToolNames = new Set(server.allowedToolNames);
  const filtered = tools.filter((tool) => allowedToolNames.has(tool.name));
  const omittedNames = tools
    .filter((tool) => !allowedToolNames.has(tool.name))
    .map((tool) => tool.name);

  context.log(
    `Applied MCP tool allowlist for ${server.serverName}: kept ${filtered.length}/${tools.length}; omitted: ${omittedNames.join(', ') || 'none'}`,
  );

  return filtered;
}

async function connectMcpServers(context: AgentTurnContext): Promise<{
  clients: Map<string, Client>;
  transports: Array<StdioClientTransport | StreamableHTTPClientTransport>;
  toolDefinitions: OpenAIToolDefinition[];
  bindings: Map<string, McpToolBinding>;
  connectionErrors: Map<string, string>;
} | null> {
  const bindings = new Map<string, McpToolBinding>();
  const toolDefinitions: OpenAIToolDefinition[] = [];
  const clients = new Map<string, Client>();
  const connectionErrors = new Map<string, string>();
  const transports: Array<
    StdioClientTransport | StreamableHTTPClientTransport
  > = [];

  for (const server of getOpenAiMcpServerConfigs(context)) {
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
      const listedTools = await listToolsWithCompatibility(
        client,
        server,
        context,
      );
      const allowedTools = filterListedToolsForServer(
        server,
        listedTools,
        context,
      );
      const tools = selectOpenAiToolsForPrompt(
        server.serverName,
        allowedTools,
        context.prompt,
        context,
      );
      clients.set(server.serverName, client);
      transports.push(transport);

      for (const tool of tools) {
        const openAiName =
          server.serverName === 'nanoclaw'
            ? sanitizeToolName(tool.name)
            : sanitizeToolName(`mcp_${server.serverName}__${tool.name}`);
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
      const errorMessage = err instanceof Error ? err.message : String(err);
      connectionErrors.set(server.serverName, errorMessage);
      context.log(
        `Failed to connect MCP server ${server.serverName}: ${errorMessage}`,
      );
      try {
        await transport.close();
      } catch {
        // Ignore close failures after a failed init.
      }
    }
  }

  return { clients, transports, toolDefinitions, bindings, connectionErrors };
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
      } else if (
        item.type === 'resource_link' &&
        typeof item.name === 'string'
      ) {
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

  const combinedOutput = truncateOutput(parts.join('\n\n').trim());
  const normalizedOutput = combinedOutput.toLowerCase();
  const inferredAuthError =
    normalizedOutput === 'error: invalid_grant' ||
    normalizedOutput.includes('invalid_grant')
      ? 'invalid_grant'
      : normalizedOutput.includes('invalid credentials')
        ? 'invalid_credentials'
        : normalizedOutput.includes('unauthorized') ||
            normalizedOutput.includes('authentication failed')
          ? 'auth_failed'
          : null;
  const isError = !!result.isError || inferredAuthError !== null;

  return JSON.stringify({
    ok: !isError,
    is_error: isError,
    auth_error: inferredAuthError || undefined,
    output: combinedOutput,
  });
}

function extractToolErrorMessage(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as {
      ok?: unknown;
      is_error?: unknown;
      error?: unknown;
      output?: unknown;
      auth_error?: unknown;
    };
    if (!(parsed.ok === false || parsed.is_error === true)) {
      return null;
    }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (typeof parsed.output === 'string' && parsed.output.trim()) {
      return parsed.output.trim();
    }
    if (typeof parsed.auth_error === 'string' && parsed.auth_error.trim()) {
      return `authentication failed: ${parsed.auth_error.trim()}`;
    }
    return 'a required tool failed';
  } catch {
    return output.trim() || null;
  }
}

function buildEmptyFinalFallback(toolErrors: string[]): string {
  const uniqueErrors = Array.from(
    new Set(toolErrors.map((message) => message.trim()).filter(Boolean)),
  );
  return `I couldn't complete that because ${uniqueErrors[0] || 'a required tool failed'}.`;
}

function buildTransientOpenAiFailureMessage(error: Error): string | null {
  if (!/OpenAI request failed \((500|502|503|504)\):/i.test(error.message)) {
    return null;
  }

  return 'The OpenAI backend hit a transient server error while processing that request. Please retry in a moment.';
}

function normalizeMcpCallResult(result: { [key: string]: unknown }): {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
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
  const effectiveCommand = [
    // Some base images only ship `python3`; provide a turn-local shim so
    // model-authored `python - <<'PY'` fallbacks still run.
    'if ! command -v python >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then python(){ python3 "$@"; }; fi',
    command,
  ].join('\n');
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
    const { stdout, stderr } = await execFileAsync(
      '/bin/bash',
      ['-lc', effectiveCommand],
      {
        cwd,
        timeout,
        maxBuffer: MAX_TOOL_OUTPUT_CHARS * 2,
        env,
      },
    );

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
    String(Math.ceil((args.timeout_ms || DEFAULT_WEB_TIMEOUT_MS) / 1000)),
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
    const requestOptions =
      binding.serverName === 'nanoclaw' &&
      binding.mcpName === 'delegate_to_group'
        ? {
            timeout: LONG_MCP_TOOL_TIMEOUT_MS,
            maxTotalTimeout: LONG_MCP_TOOL_TIMEOUT_MS,
          }
        : undefined;
    const result = await client.callTool(
      { name: binding.mcpName, arguments: args },
      CallToolResultSchema,
      requestOptions,
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

async function postOpenAIResponseWithRetry(
  baseUrl: string,
  headers: Record<string, string>,
  requestBody: Record<string, unknown>,
  context: AgentTurnContext,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_OPENAI_RESPONSE_RETRIES; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        return response;
      }

      const errorBody = await response.text();
      const error = new Error(
        `OpenAI request failed (${response.status}): ${errorBody}`,
      );

      if (
        attempt < MAX_OPENAI_RESPONSE_RETRIES &&
        response.status >= 500 &&
        response.status < 600
      ) {
        context.log(
          `Retrying OpenAI request after transient ${response.status} (attempt ${attempt + 1}/${MAX_OPENAI_RESPONSE_RETRIES})`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, OPENAI_RETRY_DELAY_MS * (attempt + 1)),
        );
        lastError = error;
        continue;
      }

      throw error;
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error(String(err ?? 'Unknown error'));

      if (attempt < MAX_OPENAI_RESPONSE_RETRIES) {
        context.log(
          `Retrying OpenAI request after error: ${error.message} (attempt ${attempt + 1}/${MAX_OPENAI_RESPONSE_RETRIES})`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, OPENAI_RETRY_DELAY_MS * (attempt + 1)),
        );
        lastError = error;
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error('OpenAI request failed after retries');
}

async function runOpenAITurn(
  context: AgentTurnContext,
): Promise<AgentTurnResult> {
  const sessionId = context.sessionId || crypto.randomUUID();
  const state = loadSessionState(sessionId);
  const model = context.agentEnv.AGENT_MODEL || DEFAULT_OPENAI_MODEL;
  const baseUrl = (
    context.agentEnv.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  ).replace(/\/$/, '');
  const apiKey = context.agentEnv.OPENAI_API_KEY || '';
  const compiledPrompt = buildPrompt(state.history, context.prompt, context);
  const rcChat =
    context.containerInput.chatJid.startsWith('rc:') ||
    context.containerInput.chatJid.startsWith('rcb:');
  const explicitRcTarget = rcChat && extractExplicitRcTarget(context.prompt);
  const crossChatRcSend = isRcCrossChatSendRequest(context.prompt, rcChat);
  const allowCurrentChatSendTool =
    !context.containerInput.disableCurrentChatSendTool &&
    shouldExposeCurrentChatSendTool(context.prompt);

  context.log(
    `Running OpenAI turn (session: ${sessionId}, model: ${model}, history: ${state.history.length})`,
  );

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
  const mcp = await connectMcpServers(context);
  try {
    try {
      const directJiraLookup = await tryHandleDirectJiraIssueLookup(
        context,
        sessionId,
        state,
        mcp,
      );
      if (directJiraLookup) {
        return directJiraLookup;
      }

      const tools = [
        ...getBuiltinToolDefinitions(),
        ...(mcp?.toolDefinitions || []),
      ].filter(
        (tool) =>
          !(crossChatRcSend && tool.name === 'send_message') &&
          (allowCurrentChatSendTool || tool.name !== 'send_message'),
      );
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
        ...(explicitRcTarget || crossChatRcSend
          ? { tool_choice: 'required' }
          : {}),
      };
      let payload: unknown;
      const sentMessages: string[] = [];
      const sentMessageKeys = new Set<string>();
      const toolErrors: string[] = [];
      let delegatedTargetAlreadyPosted = false;

      for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
        const response = await postOpenAIResponseWithRetry(
          baseUrl,
          headers,
          requestBody,
          context,
        );

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
              let parsedArgs: Record<string, unknown> | null = null;
              if (binding) {
                try {
                  parsedArgs = JSON.parse(call.arguments) as Record<
                    string,
                    unknown
                  >;
                  parsedArgs = normalizeSendToolArgsForPrompt(
                    binding.mcpName,
                    parsedArgs,
                    context.prompt,
                  );
                } catch {
                  // Ignore malformed tool args; downstream handling will surface the error.
                }
              }

              const dedupeKey =
                binding && parsedArgs
                  ? buildTurnMessageDeduplicationKey(
                      binding.mcpName,
                      parsedArgs,
                    )
                  : null;
              if (dedupeKey && sentMessageKeys.has(dedupeKey)) {
                context.log(
                  `Skipping duplicate ${binding?.mcpName} call in the same turn`,
                );
                output = JSON.stringify({
                  ok: true,
                  is_error: false,
                  output: `Duplicate ${binding?.mcpName} suppressed for this turn.`,
                });
                break;
              }

              const effectiveArgs =
                binding && parsedArgs
                  ? JSON.stringify(parsedArgs)
                  : call.arguments;

              if (
                binding &&
                delegatedTargetAlreadyPosted &&
                (binding.mcpName === 'send_rc_message' ||
                  binding.mcpName === 'send_rc_dm')
              ) {
                context.log(
                  `Suppressing ${binding.mcpName} because delegated target delivery already completed in this turn`,
                );
                output = JSON.stringify({
                  ok: true,
                  is_error: false,
                  output:
                    'Cross-chat RingCentral send suppressed because delegate_to_group already posted the result to the target team in this turn.',
                });
              } else {
                output =
                  binding && mcp
                    ? await runMcpTool(effectiveArgs, binding, mcp.clients)
                    : JSON.stringify({
                        ok: false,
                        error: `Unsupported tool: ${call.name}`,
                      });
              }

              if (
                binding?.mcpName === 'delegate_to_group' &&
                didDelegateToolAlreadyPostToTarget(output)
              ) {
                delegatedTargetAlreadyPosted = true;
                context.log(
                  'delegate_to_group already delivered the result to the target team; future cross-chat RC sends will be suppressed for this turn',
                );
              }

              if (
                binding &&
                parsedArgs &&
                (binding.mcpName === 'send_message' ||
                  binding.mcpName === 'send_rc_message' ||
                  binding.mcpName === 'send_rc_dm')
              ) {
                try {
                  const parsedOutput = JSON.parse(output) as { ok?: unknown };
                  if (parsedOutput.ok === true && dedupeKey) {
                    sentMessageKeys.add(dedupeKey);
                  }
                  if (
                    binding.mcpName === 'send_message' &&
                    parsedOutput.ok === true &&
                    typeof parsedArgs.text === 'string' &&
                    parsedArgs.text.trim()
                  ) {
                    sentMessages.push(parsedArgs.text.trim());
                  }
                } catch {
                  // Ignore malformed tool output; suppression is best-effort.
                }
              }
            }
          }

          const toolError = extractToolErrorMessage(output);
          if (toolError) {
            const binding = mcp?.bindings.get(call.name);
            if (binding) {
              context.log(
                `MCP tool error server=${binding.serverName} tool=${binding.mcpName} error=${toolError}`,
              );
            } else {
              context.log(`Tool error name=${call.name} error=${toolError}`);
            }
            toolErrors.push(toolError);
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
          ...(explicitRcTarget ? { tool_choice: 'required' } : {}),
        };
      }

      if (!payload) {
        throw new Error('OpenAI response payload missing');
      }

      const text = extractTextFromResponse(payload);
      const finalOutput = chooseFinalAssistantOutput(text, sentMessages);
      const connectorFallback = buildMcpConnectionFailureMessage(
        Array.from(mcp?.connectionErrors.entries() || []).map(
          ([serverName, error]) => ({
            serverName,
            error,
          }),
        ),
      );
      const shouldReplaceConnectorRefusal =
        !!connectorFallback &&
        containsThirdPartyMcpRefusal(finalOutput.outputText);
      const outputText =
        (shouldReplaceConnectorRefusal ? connectorFallback : null) ||
        finalOutput.outputText ||
        (toolErrors.length > 0 ? buildEmptyFinalFallback(toolErrors) : '') ||
        connectorFallback ||
        '';
      const historyText = outputText || finalOutput.historyText;

      state.history.push({ role: 'user', content: context.prompt });
      state.history.push({
        role: 'assistant',
        content: historyText,
      });
      saveSessionState(sessionId, state);

      context.emitOutput({
        status: 'success',
        result: outputText || null,
        newSessionId: sessionId,
      });

      return {
        newSessionId: sessionId,
        closedDuringQuery: false,
      };
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error(String(err ?? 'Unknown error'));
      const transientMessage = buildTransientOpenAiFailureMessage(error);
      if (!transientMessage) throw error;

      context.log(`Treating transient OpenAI failure as user-visible fallback`);
      state.history.push({ role: 'user', content: context.prompt });
      state.history.push({
        role: 'assistant',
        content: transientMessage,
      });
      saveSessionState(sessionId, state);
      context.emitOutput({
        status: 'success',
        result: transientMessage,
        newSessionId: sessionId,
      });

      return {
        newSessionId: sessionId,
        closedDuringQuery: false,
      };
    }
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
