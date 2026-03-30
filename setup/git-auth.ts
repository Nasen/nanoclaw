import fs from 'fs';

import { logger } from '../src/logger.js';
import { CONTAINER_GIT_AUTH_DIR, getGitAuthPaths } from '../src/git-auth.js';
import { emitStatus } from './status.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const GIT_CONFIG_TEMPLATE = `[credential]
\thelper = store --file ${CONTAINER_GIT_AUTH_DIR}/credentials
[core]
\tsshCommand = ssh -F ${CONTAINER_GIT_AUTH_DIR}/ssh_config
`;

const SSH_CONFIG_TEMPLATE = `Host *
  UserKnownHostsFile ${CONTAINER_GIT_AUTH_DIR}/known_hosts

# Example:
# Host github.com
#   HostName github.com
#   User git
#   IdentityFile ${CONTAINER_GIT_AUTH_DIR}/id_ed25519
`;

function ensureSecureDirectory(dirPath: string): void {
  if (fs.existsSync(dirPath) && !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Git auth path exists but is not a directory: ${dirPath}`);
  }

  fs.mkdirSync(dirPath, { recursive: true });
  fs.chmodSync(dirPath, DIR_MODE);
}

function ensureSecureFile(
  filePath: string,
  initialContent: string,
  createdFiles: string[],
): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, initialContent);
    createdFiles.push(filePath);
  }

  fs.chmodSync(filePath, FILE_MODE);
}

export async function run(_args: string[]): Promise<void> {
  const paths = getGitAuthPaths();
  const createdFiles: string[] = [];

  ensureSecureDirectory(paths.hostDir);
  ensureSecureFile(paths.hostGitConfig, GIT_CONFIG_TEMPLATE, createdFiles);
  ensureSecureFile(paths.hostCredentials, '', createdFiles);
  ensureSecureFile(paths.hostSshConfig, SSH_CONFIG_TEMPLATE, createdFiles);
  ensureSecureFile(paths.hostKnownHosts, '', createdFiles);

  logger.info(
    {
      path: paths.hostDir,
      createdFiles: createdFiles.length,
    },
    'Git auth directory configured',
  );

  emitStatus('CONFIGURE_GIT_AUTH', {
    PATH: paths.hostDir,
    CREATED_FILES: createdFiles.length,
    FILES: createdFiles.length > 0 ? createdFiles.join(',') : 'none',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
