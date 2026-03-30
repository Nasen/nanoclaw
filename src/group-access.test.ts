import { describe, expect, it } from 'vitest';

import {
  isMainGroup,
  isMainGroupFolder,
  isPersonalModeGroup,
} from './group-access.js';

describe('group-access', () => {
  it('treats configured main folders as main groups', () => {
    expect(isMainGroupFolder('rc-grp-nanoclaw-jiraops')).toBe(true);
    expect(
      isMainGroup({
        name: 'RC Team',
        folder: 'rc-grp-nanoclaw-jiraops',
        trigger: '@Bob',
        added_at: '2026-03-30T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('treats main folders as personal-mode groups', () => {
    expect(
      isPersonalModeGroup({
        name: 'RC Team',
        folder: 'rc-grp-nanoclaw-jiraops',
        trigger: '@Bob',
        added_at: '2026-03-30T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('keeps ordinary groups non-main by default', () => {
    expect(isMainGroupFolder('rc-grp-builds')).toBe(false);
    expect(
      isMainGroup({
        name: 'Builds',
        folder: 'rc-grp-builds',
        trigger: '@Bob',
        added_at: '2026-03-30T00:00:00.000Z',
      }),
    ).toBe(false);
  });
});
