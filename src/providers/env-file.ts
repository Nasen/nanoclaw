import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';

export function readHostEnv(keys: string[], hostEnv: NodeJS.ProcessEnv): Record<string, string> {
  const dotenv = readEnvFile(keys);
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = hostEnv[key] || dotenv[key];
    if (value) values[key] = value;
  }
  return values;
}

export function pickEnv(values: Record<string, string>, keys: string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of keys) {
    if (values[key]) picked[key] = values[key];
  }
  return picked;
}

export function writeProviderEnvFile(
  sessionDir: string,
  providerName: string,
  env: Record<string, string>,
): string | undefined {
  const entries = Object.entries(env).filter(([, value]) => value);
  if (entries.length === 0) return undefined;

  const dir = path.join(sessionDir, '.provider-env');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  const body = entries
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid provider env key: ${key}`);
      }
      if (/[\r\n]/.test(value)) {
        throw new Error(`Provider env value contains a newline: ${key}`);
      }
      return `${key}=${value}`;
    })
    .join('\n');

  const file = path.join(dir, `${providerName}.env`);
  fs.writeFileSync(file, `${body}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
