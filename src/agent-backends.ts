export type AgentBackend = 'claude' | 'openai';
export type CredentialAuthMode = 'api-key' | 'oauth';

export interface AgentBackendConfig {
  backend: AgentBackend;
  model?: string;
  upstreamBaseUrl: string;
  containerBaseUrlEnvVar: 'ANTHROPIC_BASE_URL' | 'OPENAI_BASE_URL';
  containerCredentialEnvVar:
    | 'ANTHROPIC_API_KEY'
    | 'CLAUDE_CODE_OAUTH_TOKEN'
    | 'OPENAI_API_KEY';
  authMode: CredentialAuthMode;
}

export interface AgentBackendEnv {
  AGENT_MODEL?: string;
  OPENAI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  OPENAI_BASE_URL?: string;
}

export interface AgentBackendDefinition {
  name: AgentBackend;
  description: string;
  defaultUpstreamBaseUrl: string;
  containerBaseUrlEnvVar: AgentBackendConfig['containerBaseUrlEnvVar'];
  resolveConfig(env: AgentBackendEnv): Omit<AgentBackendConfig, 'backend'>;
}

const AGENT_BACKEND_DEFINITIONS: Record<AgentBackend, AgentBackendDefinition> =
  {
    claude: {
      name: 'claude',
      description: 'Claude Agent SDK running behind NanoClaw credential proxy',
      defaultUpstreamBaseUrl: 'https://api.anthropic.com',
      containerBaseUrlEnvVar: 'ANTHROPIC_BASE_URL',
      resolveConfig: (env) => ({
        upstreamBaseUrl:
          process.env.ANTHROPIC_BASE_URL ||
          env.ANTHROPIC_BASE_URL ||
          'https://api.anthropic.com',
        containerBaseUrlEnvVar: 'ANTHROPIC_BASE_URL',
        containerCredentialEnvVar:
          process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY
            ? 'ANTHROPIC_API_KEY'
            : 'CLAUDE_CODE_OAUTH_TOKEN',
        authMode:
          process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY
            ? 'api-key'
            : 'oauth',
      }),
    },
    openai: {
      name: 'openai',
      description: 'OpenAI Responses API compatible backend',
      defaultUpstreamBaseUrl: 'https://api.openai.com/v1',
      containerBaseUrlEnvVar: 'OPENAI_BASE_URL',
      resolveConfig: (env) => ({
        model: process.env.AGENT_MODEL || env.AGENT_MODEL || env.OPENAI_MODEL,
        upstreamBaseUrl:
          process.env.OPENAI_BASE_URL ||
          env.OPENAI_BASE_URL ||
          'https://api.openai.com/v1',
        containerBaseUrlEnvVar: 'OPENAI_BASE_URL',
        containerCredentialEnvVar: 'OPENAI_API_KEY',
        authMode: 'api-key',
      }),
    },
  };

export function listSupportedAgentBackends(): AgentBackendDefinition[] {
  return Object.values(AGENT_BACKEND_DEFINITIONS);
}

export function getSupportedAgentBackendNames(): AgentBackend[] {
  return listSupportedAgentBackends().map((definition) => definition.name);
}

export function getAgentBackendDefinition(
  name: string | undefined,
): AgentBackendDefinition {
  const normalizedName = (name || 'claude').toLowerCase();
  if (normalizedName === 'claude' || normalizedName === 'openai') {
    return AGENT_BACKEND_DEFINITIONS[normalizedName];
  }

  throw new Error(
    `Unsupported AGENT_BACKEND "${normalizedName}". Expected one of: ${getSupportedAgentBackendNames().join(', ')}.`,
  );
}
