import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEmitStatus, gitAuthState } = vi.hoisted(() => ({
  mockEmitStatus: vi.fn(),
  gitAuthState: {
    hostDir: '/tmp/nanoclaw-test-git-auth',
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
  },
}));

vi.mock('../src/git-auth.js', () => ({
  CONTAINER_GIT_AUTH_DIR: '/home/node/.config/nanoclaw/git-auth',
  getGitAuthPaths: () => ({
    hostDir: gitAuthState.hostDir,
    hostGitConfig: path.join(gitAuthState.hostDir, 'gitconfig'),
    hostCredentials: path.join(gitAuthState.hostDir, 'credentials'),
    hostSshConfig: path.join(gitAuthState.hostDir, 'ssh_config'),
    hostKnownHosts: path.join(gitAuthState.hostDir, 'known_hosts'),
    containerDir: '/home/node/.config/nanoclaw/git-auth',
    containerGitConfig: '/home/node/.config/nanoclaw/git-auth/gitconfig',
    containerCredentials: '/home/node/.config/nanoclaw/git-auth/credentials',
    containerSshConfig: '/home/node/.config/nanoclaw/git-auth/ssh_config',
    containerKnownHosts: '/home/node/.config/nanoclaw/git-auth/known_hosts',
  }),
}));

vi.mock('./status.js', () => ({
  emitStatus: mockEmitStatus,
}));

describe('git-auth setup step', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-git-auth-'));
    gitAuthState.hostDir = path.join(tempRoot, 'git-auth');
    mockEmitStatus.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates the git auth scaffold with secure permissions', async () => {
    const { run } = await import('./git-auth.js');

    await run([]);

    expect(fs.statSync(gitAuthState.hostDir).mode & 0o777).toBe(0o700);
    expect(
      fs.statSync(path.join(gitAuthState.hostDir, 'gitconfig')).mode & 0o777,
    ).toBe(0o600);
    expect(
      fs.statSync(path.join(gitAuthState.hostDir, 'credentials')).mode & 0o777,
    ).toBe(0o600);
    expect(
      fs.statSync(path.join(gitAuthState.hostDir, 'ssh_config')).mode & 0o777,
    ).toBe(0o600);
    expect(
      fs.statSync(path.join(gitAuthState.hostDir, 'known_hosts')).mode & 0o777,
    ).toBe(0o600);

    expect(
      fs.readFileSync(path.join(gitAuthState.hostDir, 'gitconfig'), 'utf-8'),
    ).toContain('/home/node/.config/nanoclaw/git-auth/credentials');
    expect(
      fs.readFileSync(path.join(gitAuthState.hostDir, 'ssh_config'), 'utf-8'),
    ).toContain('/home/node/.config/nanoclaw/git-auth/known_hosts');
  });

  it('is idempotent and preserves existing credential content', async () => {
    const { run } = await import('./git-auth.js');

    await run([]);
    fs.writeFileSync(
      path.join(gitAuthState.hostDir, 'credentials'),
      'https://token@example.com\n',
    );

    await run([]);

    expect(
      fs.readFileSync(path.join(gitAuthState.hostDir, 'credentials'), 'utf-8'),
    ).toBe('https://token@example.com\n');
  });
});
