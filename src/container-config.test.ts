import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockReadEnvFile, mockGetAgentBackendConfig } = vi.hoisted(() => ({
  mockReadEnvFile: vi.fn(() => ({})),
  mockGetAgentBackendConfig: vi.fn(() => ({
    backend: 'openai' as const,
    model: 'gpt-5-mini',
    upstreamBaseUrl: 'https://api.openai.com/v1',
    containerBaseUrlEnvVar: 'OPENAI_BASE_URL' as const,
    containerCredentialEnvVar: 'OPENAI_API_KEY' as const,
    authMode: 'api-key' as const,
  })),
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
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('./rc-auto-register.js', () => ({
  isPersonalFolder: vi.fn(() => false),
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
import fs from 'fs';

describe('buildContainerArgs', () => {
  beforeEach(() => {
    mockReadEnvFile.mockReset();
    mockGetAgentBackendConfig.mockClear();
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => candidate === '/tmp/corp-ca.pem',
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
});
