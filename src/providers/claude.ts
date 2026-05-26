/**
 * Claude provider container config.
 *
 * Preferred path: direct local credentials are passed via a per-session Docker
 * env-file so installs without a working OneCLI gateway can still run.
 *
 * OneCLI path: when only ANTHROPIC_BASE_URL is configured, keep the placeholder
 * auth token so the gateway can rewrite the Authorization header.
 */
import { pickEnv, readHostEnv, writeProviderEnvFile } from './env-file.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const CLAUDE_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
];
const CLAUDE_SECRET_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

registerProviderContainerConfig('claude', (ctx) => {
  const values = readHostEnv(CLAUDE_ENV_KEYS, ctx.hostEnv);
  const secrets = pickEnv(values, CLAUDE_SECRET_KEYS);
  const env: Record<string, string> = {};
  if (values.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = values.ANTHROPIC_BASE_URL;
  }
  if (values.ANTHROPIC_BASE_URL && Object.keys(secrets).length === 0) {
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }

  const envFile = writeProviderEnvFile(ctx.sessionDir, 'claude', secrets);
  return { env, envFiles: envFile ? [envFile] : undefined };
});
