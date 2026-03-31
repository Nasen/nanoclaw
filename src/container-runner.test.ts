import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;
const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(
    (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      cb?.(null);
      return new EventEmitter();
    },
  ),
}));

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: mockExec,
  };
});

import {
  ContainerOutput,
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
} from './container-contract.js';
import { runContainerAgent } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  proc.stdout.push(
    `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
  );
}

describe('container-runner lifecycle behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    mockExec.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves as kept alive when the container parks in idle waiting', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      lifecycle: 'query_started',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      lifecycle: 'idle_waiting',
      newSessionId: 'session-123',
    });

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'success',
      keptAlive: true,
      newSessionId: 'session-123',
    });
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: 'idle_waiting' }),
    );
  });

  it('does not time out while parked in idle waiting', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      lifecycle: 'query_started',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-789',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      lifecycle: 'idle_waiting',
      newSessionId: 'session-789',
    });

    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
    await vi.advanceTimersByTimeAsync(1800000);

    expect(mockExec).not.toHaveBeenCalled();
  });

  it('times out with no output while a query is running', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(1800000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('uses a shorter default timeout for rc-personal while a query is running', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        folder: 'rc-personal',
      },
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      lifecycle: 'query_started',
    });

    await vi.advanceTimersByTimeAsync(240000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
  });
});
