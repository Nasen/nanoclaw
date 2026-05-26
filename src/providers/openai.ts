import { pickEnv, readHostEnv, writeProviderEnvFile } from './env-file.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const OPENAI_ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'AGENT_MODEL'];
const OPENAI_SECRET_KEYS = ['OPENAI_API_KEY'];

registerProviderContainerConfig('openai', (ctx) => {
  const values = readHostEnv(OPENAI_ENV_KEYS, ctx.hostEnv);
  const secrets = pickEnv(values, OPENAI_SECRET_KEYS);
  const env = pickEnv(values, ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'AGENT_MODEL']);
  const envFile = writeProviderEnvFile(ctx.sessionDir, 'openai', secrets);
  return { env, envFiles: envFile ? [envFile] : undefined };
});
