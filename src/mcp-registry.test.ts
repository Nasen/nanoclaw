import { describe, expect, it } from 'vitest';

function buildTestItContext(
  agentEnv: Record<string, string | undefined> = {},
  prompt = 'Fetch the latest TestIt test case details for this test case.',
): Record<string, unknown> {
  return {
    prompt,
    sessionId: undefined,
    resumeAt: undefined,
    mcpServerPath: '/tmp/nanoclaw-mcp.js',
    containerInput: {
      prompt,
      groupFolder: 'rc-grp-nanoclaw-test-design',
      chatJid: 'rc:158812815366',
      isMain: true,
      personalMode: true,
      allowedExternalMcpCapabilities: ['testit'],
      allowedNanoclawTools: [],
      allowedPeerGroups: [],
    },
    agentEnv,
    emitOutput: () => {},
    log: () => {},
    drainIpcInput: () => [],
    shouldClose: () => false,
    waitForIpcMessage: async () => null,
  };
}

describe('TestIt MCP exposure', () => {
  it('limits unauthenticated TestIt sessions to fetch_test_case', async () => {
    const {
      getClaudeAllowedToolPatternsForContext,
      getOpenAiMcpServerConfigs,
    } = await import(getMcpRegistryModulePath());
    const context = buildTestItContext();
    const testItConfig = getOpenAiMcpServerConfigs(context).find(
      (config: { serverName: string }) => config.serverName === 'testit',
    );

    expect(testItConfig?.allowedToolNames).toEqual(['fetch_test_case']);
    expect(getClaudeAllowedToolPatternsForContext(context)).toEqual([
      'mcp__nanoclaw__*',
      'mcp__testit__fetch_test_case',
    ]);
  });

  it('exposes the full TestIt tool surface when an access token exists', async () => {
    const {
      getClaudeAllowedToolPatternsForContext,
      getOpenAiMcpServerConfigs,
    } = await import(getMcpRegistryModulePath());
    const context = buildTestItContext({
      TESTIT_ACCESS_TOKEN: 'testit-token',
    });
    const testItConfig = getOpenAiMcpServerConfigs(context).find(
      (config: { serverName: string }) => config.serverName === 'testit',
    );

    expect(testItConfig?.allowedToolNames).toBeUndefined();
    expect(getClaudeAllowedToolPatternsForContext(context)).toEqual([
      'mcp__nanoclaw__*',
      'mcp__testit__*',
    ]);
  });

  it('prefers direct TestIt case tools for exact external IDs when a token exists', async () => {
    const {
      getClaudeAllowedToolPatternsForContext,
      getOpenAiMcpServerConfigs,
    } = await import(getMcpRegistryModulePath());
    const context = buildTestItContext(
      {
        TESTIT_ACCESS_TOKEN: 'testit-token',
      },
      'Review TestIT case NRCV-15763 and summarize the automation scope.',
    );
    const testItConfig = getOpenAiMcpServerConfigs(context).find(
      (config: { serverName: string }) => config.serverName === 'testit',
    );

    expect(testItConfig?.allowedToolNames).toEqual([
      'fetch_test_case',
      'get_case_folder_path',
      'compare_test_case_versions',
    ]);
    expect(getClaudeAllowedToolPatternsForContext(context)).toEqual([
      'mcp__nanoclaw__*',
      'mcp__testit__fetch_test_case',
      'mcp__testit__get_case_folder_path',
      'mcp__testit__compare_test_case_versions',
    ]);
  });

  it('keeps search tools available for explicit TestIt search intent', async () => {
    const {
      getClaudeAllowedToolPatternsForContext,
      getOpenAiMcpServerConfigs,
    } = await import(getMcpRegistryModulePath());
    const context = buildTestItContext(
      {
        TESTIT_ACCESS_TOKEN: 'testit-token',
      },
      'Search TestIT for all matching cases related to NRCV-15763.',
    );
    const testItConfig = getOpenAiMcpServerConfigs(context).find(
      (config: { serverName: string }) => config.serverName === 'testit',
    );

    expect(testItConfig?.allowedToolNames).toBeUndefined();
    expect(getClaudeAllowedToolPatternsForContext(context)).toEqual([
      'mcp__nanoclaw__*',
      'mcp__testit__*',
    ]);
  });
});

describe('Claude MCP server selection', () => {
  it('keeps plain supervisor RC summary turns on nanoclaw only', async () => {
    const { getClaudeAllowedToolPatternsForContext, getClaudeMcpServers } =
      await import(getMcpRegistryModulePath());
    const prompt = "Please summarize ![:Team](158961041414) today's message";
    const context = buildTestItContext(
      {
        JIRA_TOKEN: 'jira-token',
        CONFLUENCE_READ_TOKEN: 'confluence-token',
        TESTIT_ACCESS_TOKEN: 'testit-token',
        GITLAB_PERSONAL_ACCESS_TOKEN: 'gitlab-token',
      },
      prompt,
    );
    const typedContext = context as {
      containerInput: Record<string, unknown>;
    };
    typedContext.containerInput = {
      ...typedContext.containerInput,
      groupFolder: 'rc-personal',
      chatJid: 'rcb:157530931206',
      allowedExternalMcpCapabilities: [
        'gmail',
        'jira',
        'testit',
        'figma',
        'gitlab',
        'm365',
      ],
    };

    expect(getClaudeAllowedToolPatternsForContext(context)).toEqual([
      'mcp__nanoclaw__*',
    ]);
    expect(Object.keys(getClaudeMcpServers(context))).toEqual(['nanoclaw']);
  });
});

function getMcpRegistryModulePath(): string {
  return '../container/agent-runner/src/providers/mcp-registry.js';
}
