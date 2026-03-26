import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const GITLAB_PERSONAL_ACCESS_TOKEN =
  process.env.GITLAB_PERSONAL_ACCESS_TOKEN?.trim() || '';
const GITLAB_API_URL = (
  process.env.GITLAB_API_URL?.trim() || 'https://git.ringcentral.com/api/v4'
).replace(/\/$/, '');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const server = new McpServer({
  name: 'nanoclaw-gitlab',
  version: '1.0.0',
});

function ensureGitLabToken(): void {
  if (!GITLAB_PERSONAL_ACCESS_TOKEN) {
    throw new Error(
      'GITLAB_PERSONAL_ACCESS_TOKEN environment variable is not set',
    );
  }
}

function buildApiUrl(
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(`${GITLAB_API_URL}${pathname}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function gitlabRequest(
  pathname: string,
  query?: Record<string, string | number | undefined>,
): Promise<unknown> {
  ensureGitLabToken();
  const response = await fetch(buildApiUrl(pathname, query), {
    headers: {
      Authorization: `Bearer ${GITLAB_PERSONAL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `GitLab API error ${response.status}: ${body.trim() || response.statusText}`,
    );
  }

  return (await response.json()) as unknown;
}

function formatResult(data: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function formatError(err: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: 'text',
        text: err instanceof Error ? err.message : String(err),
      },
    ],
    isError: true,
  };
}

server.registerTool(
  'search_projects',
  {
    description:
      'Search GitLab projects by name or namespace and return matching project metadata.',
    inputSchema: {
      search: z.string().describe('Project search query.'),
      page: z.number().int().min(1).default(1).describe('Result page number.'),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_SIZE)
        .default(DEFAULT_PAGE_SIZE)
        .describe('Maximum projects to return.'),
    },
  },
  async (args) => {
    try {
      const data = await gitlabRequest('/projects', {
        search: args.search,
        page: args.page,
        per_page: args.per_page,
        simple: 'true',
      });
      return formatResult(data);
    } catch (err) {
      return formatError(err);
    }
  },
);

server.registerTool(
  'get_project',
  {
    description:
      'Get a GitLab project by numeric ID or URL-encoded path like group/project.',
    inputSchema: {
      project_id: z
        .string()
        .describe('Numeric project ID or URL-encoded project path.'),
    },
  },
  async (args) => {
    try {
      const data = await gitlabRequest(
        `/projects/${encodeURIComponent(args.project_id)}`,
      );
      return formatResult(data);
    } catch (err) {
      return formatError(err);
    }
  },
);

server.registerTool(
  'list_project_pipelines',
  {
    description:
      'List pipelines for a GitLab project, optionally filtered by branch ref or status.',
    inputSchema: {
      project_id: z
        .string()
        .describe('Numeric project ID or URL-encoded project path.'),
      ref: z
        .string()
        .optional()
        .describe('Optional branch or tag name to filter pipelines.'),
      status: z
        .enum([
          'created',
          'waiting_for_resource',
          'preparing',
          'pending',
          'running',
          'success',
          'failed',
          'canceled',
          'skipped',
          'manual',
          'scheduled',
        ])
        .optional()
        .describe('Optional pipeline status filter.'),
      page: z.number().int().min(1).default(1).describe('Result page number.'),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_SIZE)
        .default(DEFAULT_PAGE_SIZE)
        .describe('Maximum pipelines to return.'),
    },
  },
  async (args) => {
    try {
      const data = await gitlabRequest(
        `/projects/${encodeURIComponent(args.project_id)}/pipelines`,
        {
          ref: args.ref,
          status: args.status,
          page: args.page,
          per_page: args.per_page,
        },
      );
      return formatResult(data);
    } catch (err) {
      return formatError(err);
    }
  },
);

server.registerTool(
  'list_merge_requests',
  {
    description:
      'List merge requests for a GitLab project, with optional state and branch filters.',
    inputSchema: {
      project_id: z
        .string()
        .describe('Numeric project ID or URL-encoded project path.'),
      state: z
        .enum(['opened', 'closed', 'locked', 'merged', 'all'])
        .optional()
        .describe('Merge request state filter.'),
      source_branch: z
        .string()
        .optional()
        .describe('Optional source branch filter.'),
      target_branch: z
        .string()
        .optional()
        .describe('Optional target branch filter.'),
      search: z
        .string()
        .optional()
        .describe(
          'Optional text search across merge request title and description.',
        ),
      page: z.number().int().min(1).default(1).describe('Result page number.'),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_SIZE)
        .default(DEFAULT_PAGE_SIZE)
        .describe('Maximum merge requests to return.'),
    },
  },
  async (args) => {
    try {
      const data = await gitlabRequest(
        `/projects/${encodeURIComponent(args.project_id)}/merge_requests`,
        {
          state: args.state,
          source_branch: args.source_branch,
          target_branch: args.target_branch,
          search: args.search,
          page: args.page,
          per_page: args.per_page,
        },
      );
      return formatResult(data);
    } catch (err) {
      return formatError(err);
    }
  },
);

server.registerTool(
  'get_merge_request',
  {
    description: 'Get a single merge request by project and merge request IID.',
    inputSchema: {
      project_id: z
        .string()
        .describe('Numeric project ID or URL-encoded project path.'),
      merge_request_iid: z
        .number()
        .int()
        .positive()
        .describe('Merge request IID, for example 123 from !123.'),
    },
  },
  async (args) => {
    try {
      const data = await gitlabRequest(
        `/projects/${encodeURIComponent(args.project_id)}/merge_requests/${args.merge_request_iid}`,
      );
      return formatResult(data);
    } catch (err) {
      return formatError(err);
    }
  },
);

async function main(): Promise<void> {
  ensureGitLabToken();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('NanoClaw GitLab MCP server running on stdio');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
