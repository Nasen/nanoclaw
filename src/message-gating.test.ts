import { describe, expect, it } from 'vitest';

import { groupNeedsTrigger, isPersonalRcDm } from './message-gating.js';

describe('message-gating', () => {
  it('does not require a trigger for configured main folders', () => {
    expect(
      groupNeedsTrigger({
        name: 'RC Team',
        folder: 'rc-grp-nanoclaw-jiraops',
        trigger: '@Bob',
        added_at: '2026-03-30T00:00:00.000Z',
        requiresTrigger: true,
      }),
    ).toBe(false);
  });

  it('still requires a trigger for ordinary groups', () => {
    expect(
      groupNeedsTrigger({
        name: 'Builds',
        folder: 'rc-grp-builds',
        trigger: '@Bob',
        added_at: '2026-03-30T00:00:00.000Z',
        requiresTrigger: true,
      }),
    ).toBe(true);
  });

  it('treats rc-personal as a personal RC DM', () => {
    expect(
      isPersonalRcDm('rc:12345', {
        name: 'Personal',
        folder: 'rc-personal',
        trigger: '@Bob',
        added_at: '2026-03-30T00:00:00.000Z',
      }),
    ).toBe(true);
  });
});
