import fs from 'fs';
import path from 'path';

import { GIT_AUTH_DIR } from './config.js';

export const CONTAINER_GIT_AUTH_DIR = '/home/node/.config/nanoclaw/git-auth';
export const CONTAINER_GIT_CONFIG_PATH = path.join(
  CONTAINER_GIT_AUTH_DIR,
  'gitconfig',
);
export const CONTAINER_GIT_CREDENTIALS_PATH = path.join(
  CONTAINER_GIT_AUTH_DIR,
  'credentials',
);
export const CONTAINER_GIT_SSH_CONFIG_PATH = path.join(
  CONTAINER_GIT_AUTH_DIR,
  'ssh_config',
);
export const CONTAINER_GIT_KNOWN_HOSTS_PATH = path.join(
  CONTAINER_GIT_AUTH_DIR,
  'known_hosts',
);

export interface GitAuthPaths {
  hostDir: string;
  hostGitConfig: string;
  hostCredentials: string;
  hostSshConfig: string;
  hostKnownHosts: string;
  containerDir: string;
  containerGitConfig: string;
  containerCredentials: string;
  containerSshConfig: string;
  containerKnownHosts: string;
}

export function getGitAuthPaths(baseDir = GIT_AUTH_DIR): GitAuthPaths {
  return {
    hostDir: baseDir,
    hostGitConfig: path.join(baseDir, 'gitconfig'),
    hostCredentials: path.join(baseDir, 'credentials'),
    hostSshConfig: path.join(baseDir, 'ssh_config'),
    hostKnownHosts: path.join(baseDir, 'known_hosts'),
    containerDir: CONTAINER_GIT_AUTH_DIR,
    containerGitConfig: CONTAINER_GIT_CONFIG_PATH,
    containerCredentials: CONTAINER_GIT_CREDENTIALS_PATH,
    containerSshConfig: CONTAINER_GIT_SSH_CONFIG_PATH,
    containerKnownHosts: CONTAINER_GIT_KNOWN_HOSTS_PATH,
  };
}

export function hasGitAuthDir(baseDir = GIT_AUTH_DIR): boolean {
  try {
    return fs.statSync(baseDir).isDirectory();
  } catch {
    return false;
  }
}

export function getContainerGitAuthEnv(): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: CONTAINER_GIT_CONFIG_PATH,
    GIT_SSH_COMMAND: `ssh -F ${CONTAINER_GIT_SSH_CONFIG_PATH}`,
  };
}
