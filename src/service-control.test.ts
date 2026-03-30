import { describe, expect, it } from 'vitest';

import {
  buildServiceToggleConfirmation,
  isAdminServiceControlGroup,
  parseServiceToggleCommand,
} from './service-control.js';

describe('parseServiceToggleCommand', () => {
  it('matches exact enable and disable commands', () => {
    expect(parseServiceToggleCommand('enable service')).toBe(true);
    expect(parseServiceToggleCommand('turn off NanoClaw')).toBe(false);
  });

  it('ignores non-exact phrases', () => {
    expect(parseServiceToggleCommand('please enable service')).toBeNull();
    expect(parseServiceToggleCommand('disable service now')).toBeNull();
  });
});

describe('isAdminServiceControlGroup', () => {
  it('allows isMain groups', () => {
    expect(
      isAdminServiceControlGroup({
        name: 'Main',
        folder: 'main',
        trigger: '@NanoClaw',
        added_at: '2026-01-01T00:00:00.000Z',
        isMain: true,
      }),
    ).toBe(true);
  });

  it('allows configured main folders', () => {
    expect(
      isAdminServiceControlGroup({
        name: 'RC Team',
        folder: 'rc-grp-nanoclaw-jiraops',
        trigger: '@Bob',
        added_at: '2026-03-30T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('rejects non-admin groups', () => {
    expect(
      isAdminServiceControlGroup({
        name: 'Builds',
        folder: 'rc-grp-builds',
        trigger: '@NanoClaw',
        added_at: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(false);
  });
});

describe('buildServiceToggleConfirmation', () => {
  it('distinguishes changed and unchanged state', () => {
    expect(buildServiceToggleConfirmation(false, true)).toContain(
      'Service disabled.',
    );
    expect(buildServiceToggleConfirmation(true, false)).toBe(
      'Service is already enabled.',
    );
  });
});
