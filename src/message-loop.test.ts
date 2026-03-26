import { describe, expect, it } from 'vitest';

import { shouldPipeMessagesToActiveContainer } from './message-loop.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(folder: string): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '@NanoClaw',
    added_at: new Date().toISOString(),
  };
}

describe('shouldPipeMessagesToActiveContainer', () => {
  it('disables active-container piping for rc-personal', () => {
    expect(
      shouldPipeMessagesToActiveContainer(makeGroup('rc-personal')),
    ).toBe(false);
  });

  it('keeps active-container piping for other groups', () => {
    expect(
      shouldPipeMessagesToActiveContainer(makeGroup('rc-grp-builds')),
    ).toBe(true);
  });
});
