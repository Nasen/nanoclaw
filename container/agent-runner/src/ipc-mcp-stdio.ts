/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

async function waitForResponse(
  requestId: string,
  timeoutMs = 20000,
): Promise<Record<string, unknown>> {
  const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(responsePath)) {
      const raw = fs.readFileSync(responsePath, 'utf-8');
      fs.unlinkSync(responsePath);
      return JSON.parse(raw) as Record<string, unknown>;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for IPC response ${requestId}`);
}

async function requestTask(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs = 20000,
): Promise<Record<string, unknown>> {
  const requestId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeIpcFile(TASKS_DIR, {
    type,
    requestId,
    ...payload,
  });
  return waitForResponse(requestId, timeoutMs);
}

const notebookLmSourceSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string().describe('Raw text content to add to the notebook.'),
    title: z
      .string()
      .optional()
      .describe('Optional display name for this text source.'),
  }),
  z.object({
    type: z.literal('web'),
    url: z.string().url().describe('Web URL to add as a source.'),
    title: z
      .string()
      .optional()
      .describe('Optional display name for this web source.'),
  }),
  z.object({
    type: z.literal('file'),
    path: z
      .string()
      .describe(
        'Host file path to upload. Relative paths resolve from the current group folder.',
      ),
    title: z
      .string()
      .optional()
      .describe('Optional display name for this uploaded file source.'),
    contentType: z
      .string()
      .optional()
      .describe(
        'Optional MIME type override when the file extension is uncommon.',
      ),
  }),
]);

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.registerTool(
  'list_notebooklm_notebooks',
  {
    description:
      'List recently viewed NotebookLM Enterprise notebooks for the configured Google Cloud project.',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Maximum notebooks to return.'),
    },
  },
  async (args) => {
    try {
      const response = await requestTask(
        'notebooklm_list_notebooks',
        { pageSize: args.limit },
        30000,
      );
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: String(
                response.error || 'Failed to list NotebookLM notebooks.',
              ),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(response.notebooks ?? [], null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'create_notebooklm_notebook',
  {
    description:
      'Create a NotebookLM Enterprise notebook in the configured Google Cloud project.',
    inputSchema: {
      title: z.string().describe('Notebook title.'),
    },
  },
  async (args) => {
    try {
      const response = await requestTask(
        'notebooklm_create_notebook',
        { title: args.title },
        30000,
      );
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: String(
                response.error || 'Failed to create NotebookLM notebook.',
              ),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(response.notebook ?? {}, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'get_notebooklm_notebook',
  {
    description:
      'Retrieve a NotebookLM Enterprise notebook, including any sources returned by the API.',
    inputSchema: {
      notebook_id: z.string().describe('NotebookLM notebook ID.'),
    },
  },
  async (args) => {
    try {
      const response = await requestTask(
        'notebooklm_get_notebook',
        { notebookId: args.notebook_id },
        30000,
      );
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: String(
                response.error || 'Failed to retrieve NotebookLM notebook.',
              ),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(response.notebook ?? {}, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'add_notebooklm_sources',
  {
    description:
      'Add raw text, web URLs, or local files as sources to a NotebookLM Enterprise notebook. This is explicit-only and does not sync chat history automatically.',
    inputSchema: {
      notebook_id: z.string().describe('NotebookLM notebook ID.'),
      sources: z
        .array(notebookLmSourceSchema)
        .min(1)
        .describe('One or more NotebookLM sources to add.'),
    },
  },
  async (args) => {
    try {
      const response = await requestTask(
        'notebooklm_add_sources',
        {
          notebookId: args.notebook_id,
          sources: args.sources,
        },
        120000,
      );
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: String(
                response.error || 'Failed to add NotebookLM sources.',
              ),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(response.result ?? {}, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'send_message',
  {
    description:
      "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. In personal-mode chats, this sends through the user's connected integration on their behalf in the current chat. You can call this multiple times.",
    inputSchema: {
      text: z.string().describe('The message text to send'),
      sender: z
        .string()
        .optional()
        .describe(
          'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
        ),
      delivery_mode: z
        .enum(['auto', 'personal', 'bot'])
        .optional()
        .describe(
          'Routing preference for the current chat. For RingCentral, "personal" uses Nasen\'s personal RC app/credentials, "bot" uses the RC bot app, and "auto" keeps the default route.',
        ),
    },
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      deliveryMode: args.delivery_mode || 'auto',
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.registerTool(
  'schedule_task',
  {
    description: `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
    inputSchema: {
      prompt: z
        .string()
        .describe(
          'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
        ),
      schedule_type: z
        .enum(['cron', 'interval', 'once'])
        .describe(
          'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
        ),
      schedule_value: z
        .string()
        .describe(
          'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
        ),
      context_mode: z
        .enum(['group', 'isolated'])
        .default('group')
        .describe(
          'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
        ),
      target_group_jid: z
        .string()
        .optional()
        .describe(
          '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
        ),
    },
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.registerTool(
  'list_tasks',
  {
    description:
      "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
    inputSchema: {},
  },
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.registerTool(
  'list_rc_chats',
  {
    description:
      'List RingCentral team or DM chats accessible through the integrated RC SDK. Use mode="personal" for Nasen personal credentials and mode="bot" for the RC bot app.',
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('Optional text filter for chat name or chat ID.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Maximum chats to return.'),
      mode: z
        .enum(['auto', 'personal', 'bot'])
        .default('auto')
        .describe('Which RC identity to use.'),
    },
  },
  async (args) => {
    try {
      const response = await requestTask('rc_list_chats', {
        query: args.query,
        limit: args.limit,
        mode: args.mode,
      });
      if (!response.ok) {
        return {
          content: [{ type: 'text' as const, text: String(response.error || 'Failed to list RC chats.') }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response.chats ?? [], null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'read_rc_messages',
  {
    description:
      'Read recent messages from a RingCentral team or DM chat using the integrated RC SDK.',
    inputSchema: {
      chat_id: z
        .string()
        .describe('RingCentral chat ID or full JID like rc:123 or rcb:123.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Maximum messages to return.'),
      mode: z
        .enum(['auto', 'personal', 'bot'])
        .default('auto')
        .describe('Which RC identity to use.'),
    },
  },
  async (args) => {
    try {
      const response = await requestTask('rc_read_messages', {
        chatId: args.chat_id,
        limit: args.limit,
        mode: args.mode,
      });
      if (!response.ok) {
        return {
          content: [{ type: 'text' as const, text: String(response.error || 'Failed to read RC messages.') }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response.transcript ?? {}, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'send_rc_message',
  {
    description:
      'Send a RingCentral team or DM message through the integrated RC SDK.',
    inputSchema: {
      chat_id: z
        .string()
        .describe('RingCentral chat ID or full JID like rc:123 or rcb:123.'),
      text: z.string().describe('Message text to send.'),
      mode: z
        .enum(['auto', 'personal', 'bot'])
        .default('auto')
        .describe('Which RC identity to use.'),
    },
  },
  async (args) => {
    try {
      const response = await requestTask('rc_send_message', {
        chatId: args.chat_id,
        text: args.text,
        mode: args.mode,
      });
      if (!response.ok) {
        return {
          content: [{ type: 'text' as const, text: String(response.error || 'Failed to send RC message.') }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response.result ?? {}, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'pause_task',
  {
    description: 'Pause a scheduled task. It will not run until resumed.',
    inputSchema: {
      task_id: z.string().describe('The task ID to pause'),
    },
  },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.registerTool(
  'resume_task',
  {
    description: 'Resume a paused task.',
    inputSchema: {
      task_id: z.string().describe('The task ID to resume'),
    },
  },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.registerTool(
  'cancel_task',
  {
    description: 'Cancel and delete a scheduled task.',
    inputSchema: {
      task_id: z.string().describe('The task ID to cancel'),
    },
  },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.registerTool(
  'update_task',
  {
    description:
      'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
    inputSchema: {
      task_id: z.string().describe('The task ID to update'),
      prompt: z.string().optional().describe('New prompt for the task'),
      schedule_type: z
        .enum(['cron', 'interval', 'once'])
        .optional()
        .describe('New schedule type'),
      schedule_value: z
        .string()
        .optional()
        .describe('New schedule value (see schedule_task for format)'),
    },
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.registerTool(
  'register_group',
  {
    description: `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
    inputSchema: {
      jid: z
        .string()
        .describe(
          'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
        ),
      name: z.string().describe('Display name for the group'),
      folder: z
        .string()
        .describe(
          'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
        ),
      trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    },
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
