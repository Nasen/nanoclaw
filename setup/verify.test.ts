import fs from 'fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.fn();

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

describe('detectContainerGitTools', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.restoreAllMocks();
  });

  it('returns ready when the image has both git and ssh', async () => {
    execSyncMock.mockReturnValue(undefined);

    const { detectContainerGitTools } = await import('./verify.js');

    expect(detectContainerGitTools('/tmp/project', 'docker')).toBe('ready');
  });

  it('falls back to Dockerfile detection when runtime verification fails', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('image unavailable');
    });
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      'RUN apt-get install -y git openssh-client',
    );

    const { detectContainerGitTools } = await import('./verify.js');

    expect(detectContainerGitTools('/tmp/project', 'docker')).toBe(
      'configured_but_not_verified',
    );
  });

  it('returns missing when neither runtime nor Dockerfile confirms support', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('image unavailable');
    });
    vi.spyOn(fs, 'readFileSync').mockReturnValue('RUN apt-get install -y git');

    const { detectContainerGitTools } = await import('./verify.js');

    expect(detectContainerGitTools('/tmp/project', 'docker')).toBe('missing');
  });
});
