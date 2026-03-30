import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  mockReadEnvFile,
  mockGetAgentBackendConfig,
  mockIsMainFolder,
  mockIsPersonalFolder,
  mockValidateAdditionalMounts,
  mockGetAllRegisteredGroups,
} = vi.hoisted(() => ({
    mockReadEnvFile: vi.fn(() => ({})),
    mockGetAgentBackendConfig: vi.fn(() => ({
      backend: 'openai' as const,
      model: 'gpt-5-mini',
      upstreamBaseUrl: 'https://api.openai.com/v1',
      containerBaseUrlEnvVar: 'OPENAI_BASE_URL' as const,
      containerCredentialEnvVar: 'OPENAI_API_KEY' as const,
      authMode: 'api-key' as const,
    })),
    mockIsMainFolder: vi.fn(() => false),
    mockIsPersonalFolder: vi.fn(() => false),
    mockValidateAdditionalMounts: vi.fn(() => []),
    mockGetAllRegisteredGroups: vi.fn(() => ({})),
  }));

vi.mock('./agent-backend.js', () => ({
  getAgentBackendConfig: mockGetAgentBackendConfig,
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: vi.fn(() => [
    '--add-host',
    'host.docker.internal:host-gateway',
  ]),
  readonlyMountArgs: vi.fn((hostPath: string, containerPath: string) => [
    '-v',
    `${hostPath}:${containerPath}:ro`,
  ]),
}));

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GIT_AUTH_DIR: '/tmp/git-auth',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  TIMEZONE: 'Asia/Shanghai',
}));

vi.mock('./env.js', () => ({
  readEnvFile: mockReadEnvFile,
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => '/tmp/group'),
  resolveGroupIpcPath: vi.fn(() => '/tmp/ipc'),
}));

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: mockValidateAdditionalMounts,
}));

vi.mock('./rc-auto-register.js', () => ({
  isMainFolder: mockIsMainFolder,
  isPersonalFolder: mockIsPersonalFolder,
}));

vi.mock('./db.js', () => ({
  getAllRegisteredGroups: mockGetAllRegisteredGroups,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      cpSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
    },
  };
});

import { buildContainerArgs } from './container-config.js';
import { buildVolumeMounts } from './container-config.js';
import {
  CONTAINER_GIT_AUTH_DIR,
  CONTAINER_GIT_CONFIG_PATH,
  CONTAINER_GIT_SSH_CONFIG_PATH,
} from './git-auth.js';
import fs from 'fs';

describe('buildContainerArgs', () => {
  beforeEach(() => {
    mockReadEnvFile.mockReset();
    mockGetAgentBackendConfig.mockClear();
    mockIsMainFolder.mockReset();
    mockIsPersonalFolder.mockReset();
    mockValidateAdditionalMounts.mockReset();
    mockGetAllRegisteredGroups.mockReset();
    mockValidateAdditionalMounts.mockReturnValue([]);
    mockGetAllRegisteredGroups.mockReturnValue({});
    mockIsMainFolder.mockReturnValue(false);
    mockIsPersonalFolder.mockReturnValue(false);
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) =>
        candidate === '/tmp/corp-ca.pem' || candidate === '/tmp/git-auth',
    );
    vi.mocked(fs.statSync).mockImplementation(
      (candidate) =>
        ({
          isDirectory: () => candidate === '/tmp/git-auth',
        }) as ReturnType<typeof fs.statSync>,
    );
  });

  it('maps insecure web fetch TLS to Node TLS for MCP processes', () => {
    mockReadEnvFile.mockReturnValue({
      WEB_FETCH_INSECURE_TLS: 'true',
    });

    const args = buildContainerArgs([], 'test-container');

    expect(args).toContain('-e');
    expect(args).toContain('WEB_FETCH_INSECURE_TLS=true');
    expect(args).toContain('NODE_TLS_REJECT_UNAUTHORIZED=0');
  });

  it('maps CA bundle env to Node TLS env for MCP processes', () => {
    mockReadEnvFile.mockReturnValue({
      WEB_FETCH_CA_BUNDLE: '/tmp/corp-ca.pem',
    });

    const args = buildContainerArgs([], 'test-container');

    expect(args).toContain(
      'WEB_FETCH_CA_BUNDLE=/workspace/tls/web-fetch-ca-bundle.pem',
    );
    expect(args).toContain(
      'NODE_EXTRA_CA_CERTS=/workspace/tls/web-fetch-ca-bundle.pem',
    );
    expect(args).toContain(
      'SSL_CERT_FILE=/workspace/tls/web-fetch-ca-bundle.pem',
    );
  });

  it('mounts the configured CA bundle into the container', () => {
    mockReadEnvFile.mockReturnValue({
      WEB_FETCH_CA_BUNDLE: '/tmp/corp-ca.pem',
    });

    const mounts = buildVolumeMounts(
      {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      false,
    );

    expect(mounts).toContainEqual({
      hostPath: '/tmp/corp-ca.pem',
      containerPath: '/workspace/tls/web-fetch-ca-bundle.pem',
      readonly: true,
    });
  });

  it('mounts git auth for owner contexts when configured', () => {
    const mounts = buildVolumeMounts(
      {
        name: 'Main Group',
        folder: 'main',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      true,
    );

    expect(mounts).toContainEqual({
      hostPath: '/tmp/git-auth',
      containerPath: CONTAINER_GIT_AUTH_DIR,
      readonly: false,
    });
  });

  it('does not mount git auth for non-owner groups', () => {
    const mounts = buildVolumeMounts(
      {
        name: 'External Group',
        folder: 'external-group',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      false,
    );

    expect(
      mounts.find((mount) => mount.containerPath === CONTAINER_GIT_AUTH_DIR),
    ).toBeUndefined();
  });

  it('mounts git auth for personal folders', () => {
    mockIsPersonalFolder.mockReturnValue(true);

    const mounts = buildVolumeMounts(
      {
        name: 'Personal RC',
        folder: 'rc-personal',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      false,
    );

    expect(mounts).toContainEqual({
      hostPath: '/tmp/git-auth',
      containerPath: CONTAINER_GIT_AUTH_DIR,
      readonly: false,
    });
  });

  it('inherits rc-personal additional mounts for main folders', () => {
    mockIsMainFolder.mockImplementation(
      ((folder: string) => folder === 'rc-grp-nanoclaw-gitops') as any,
    );
    mockGetAllRegisteredGroups.mockReturnValue({
      'rcb:157530931206': {
        name: 'NanoClaw-Personal',
        folder: 'rc-personal',
        trigger: '@Bob',
        added_at: '2026-03-30T00:00:00.000Z',
        containerConfig: {
          additionalMounts: [
            {
              hostPath: '/Users/nasen.you/Projects',
              containerPath: 'projects',
              readonly: false,
            },
          ],
        },
      },
    });

    buildVolumeMounts(
      {
        name: 'NanoClaw-GitOps',
        folder: 'rc-grp-nanoclaw-gitops',
        trigger: '@Bob',
        added_at: '2026-03-30T00:00:00.000Z',
      },
      true,
    );

    expect(mockValidateAdditionalMounts).toHaveBeenCalledWith(
      [
        {
          hostPath: '/Users/nasen.you/Projects',
          containerPath: 'projects',
          readonly: false,
        },
      ],
      'NanoClaw-GitOps',
      true,
    );
  });

  it('lets group-specific additional mounts override inherited rc-personal mounts', () => {
    mockIsMainFolder.mockImplementation(
      ((folder: string) => folder === 'rc-grp-nanoclaw-gitops') as any,
    );
    mockGetAllRegisteredGroups.mockReturnValue({
      'rcb:157530931206': {
        name: 'NanoClaw-Personal',
        folder: 'rc-personal',
        trigger: '@Bob',
        added_at: '2026-03-30T00:00:00.000Z',
        containerConfig: {
          additionalMounts: [
            {
              hostPath: '/Users/nasen.you/Projects',
              containerPath: 'projects',
              readonly: false,
            },
            {
              hostPath: '/Users/nasen.you/Shared',
              containerPath: 'shared',
              readonly: true,
            },
          ],
        },
      },
    });

    buildVolumeMounts(
      {
        name: 'NanoClaw-GitOps',
        folder: 'rc-grp-nanoclaw-gitops',
        trigger: '@Bob',
        added_at: '2026-03-30T00:00:00.000Z',
        containerConfig: {
          additionalMounts: [
            {
              hostPath: '/Users/nasen.you/Projects',
              containerPath: 'projects',
              readonly: true,
            },
          ],
        },
      },
      true,
    );

    expect(mockValidateAdditionalMounts).toHaveBeenCalledWith(
      [
        {
          hostPath: '/Users/nasen.you/Projects',
          containerPath: 'projects',
          readonly: true,
        },
        {
          hostPath: '/Users/nasen.you/Shared',
          containerPath: 'shared',
          readonly: true,
        },
      ],
      'NanoClaw-GitOps',
      true,
    );
  });

  it('does not inherit rc-personal additional mounts for non-main groups', () => {
    mockGetAllRegisteredGroups.mockReturnValue({
      'rcb:157530931206': {
        name: 'NanoClaw-Personal',
        folder: 'rc-personal',
        trigger: '@Bob',
        added_at: '2026-03-30T00:00:00.000Z',
        containerConfig: {
          additionalMounts: [
            {
              hostPath: '/Users/nasen.you/Projects',
              containerPath: 'projects',
              readonly: false,
            },
          ],
        },
      },
    });

    buildVolumeMounts(
      {
        name: 'External Group',
        folder: 'external-group',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      false,
    );

    expect(mockValidateAdditionalMounts).not.toHaveBeenCalled();
  });

  it('injects git auth env when the git auth mount is present', () => {
    const args = buildContainerArgs(
      [
        {
          hostPath: '/tmp/git-auth',
          containerPath: CONTAINER_GIT_AUTH_DIR,
          readonly: false,
        },
      ],
      'test-container',
      true,
    );

    expect(args).toContain(`GIT_CONFIG_GLOBAL=${CONTAINER_GIT_CONFIG_PATH}`);
    expect(args).toContain(
      `GIT_SSH_COMMAND=ssh -F ${CONTAINER_GIT_SSH_CONFIG_PATH}`,
    );
  });
});
