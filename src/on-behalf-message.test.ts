import { describe, expect, it } from 'vitest';

import {
  formatOnBehalfAssistantMessage,
  ON_BEHALF_PREFIX,
} from './on-behalf-message.js';

describe('on-behalf-message', () => {
  it('prefixes assistant text for on-behalf delivery', () => {
    expect(formatOnBehalfAssistantMessage('hello')).toBe(
      `${ON_BEHALF_PREFIX}hello`,
    );
  });

  it('does not double-prefix already marked text', () => {
    expect(
      formatOnBehalfAssistantMessage(`${ON_BEHALF_PREFIX}hello`),
    ).toBe(`${ON_BEHALF_PREFIX}hello`);
  });
});
