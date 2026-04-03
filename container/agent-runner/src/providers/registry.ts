import { AgentProvider } from '../types.js';
import { claudeProvider } from './claude.js';
import { openaiProvider } from './openai.js';

export interface AgentProviderRegistration {
  name: string;
  description: string;
  provider: AgentProvider;
}

const PROVIDERS: AgentProviderRegistration[] = [
  {
    name: 'claude',
    description: 'Claude Agent SDK provider',
    provider: claudeProvider,
  },
  {
    name: 'openai',
    description: 'OpenAI Responses API provider',
    provider: openaiProvider,
  },
];

const providerRegistry = new Map(
  PROVIDERS.map((registration) => [registration.name, registration]),
);

export function listAgentProviders(): AgentProviderRegistration[] {
  return [...PROVIDERS];
}

export function getAgentProvider(name: string | undefined): AgentProvider {
  const normalizedName = (name || 'claude').toLowerCase();
  const registration = providerRegistry.get(normalizedName);
  if (!registration) {
    throw new Error(
      `Unsupported NANOCLAW_AGENT_BACKEND "${name}". Expected one of: ${listAgentProviders()
        .map((provider) => provider.name)
        .join(', ')}.`,
    );
  }

  return registration.provider;
}
