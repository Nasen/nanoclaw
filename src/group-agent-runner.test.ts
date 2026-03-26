import { describe, expect, it } from 'vitest';

import { shouldCloseContainerAfterTurn } from './group-agent-runner.js';
import type { ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(folder: string): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '@NanoClaw',
    added_at: new Date().toISOString(),
  };
}

describe('shouldCloseContainerAfterTurn', () => {
  it('closes rc-personal containers after the trailing success marker', () => {
    const result: ContainerOutput = {
      status: 'success',
      result: null,
    };

    expect(
      shouldCloseContainerAfterTurn(makeGroup('rc-personal'), result),
    ).toBe(true);
  });

  it('does not close normal groups after the trailing success marker', () => {
    const result: ContainerOutput = {
      status: 'success',
      result: null,
    };

    expect(
      shouldCloseContainerAfterTurn(makeGroup('rc-grp-builds'), result),
    ).toBe(false);
  });

  it('does not close rc-personal during a streamed result payload', () => {
    const result: ContainerOutput = {
      status: 'success',
      result: 'partial output',
    };

    expect(
      shouldCloseContainerAfterTurn(makeGroup('rc-personal'), result),
    ).toBe(false);
  });
});
