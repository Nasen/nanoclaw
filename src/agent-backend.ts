import { readEnvFile } from './env.js';
import {
  AgentBackend,
  AgentBackendConfig,
  CredentialAuthMode,
  getAgentBackendDefinition,
} from './agent-backends.js';

export type { AgentBackend, AgentBackendConfig, CredentialAuthMode };
export {
  getAgentBackendDefinition,
  getSupportedAgentBackendNames,
  listSupportedAgentBackends,
} from './agent-backends.js';

export function getAgentBackendConfig(): AgentBackendConfig {
  const env = readEnvFile([
    'AGENT_BACKEND',
    'AGENT_MODEL',
    'OPENAI_MODEL',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ]);

  const requestedBackend = (
    process.env.AGENT_BACKEND ||
    env.AGENT_BACKEND ||
    'claude'
  ).toLowerCase();
  const definition = getAgentBackendDefinition(requestedBackend);

  return {
    backend: definition.name,
    ...definition.resolveConfig(env),
  };
}
