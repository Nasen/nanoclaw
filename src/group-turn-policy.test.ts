import { describe, expect, it } from 'vitest';

import {
  buildGroupTurnPrompt,
  shouldSkipGroupTurnForAutoAssist,
} from './group-turn-policy.js';

describe('shouldSkipGroupTurnForAutoAssist', () => {
  it('skips personal RC DM turns when auto-assist is off and there is no slash command', () => {
    expect(
      shouldSkipGroupTurnForAutoAssist({
        personalRcDm: true,
        autoAssistEnabled: false,
        hasSlashCommand: false,
      }),
    ).toBe(true);
  });

  it('does not skip when auto-assist is enabled', () => {
    expect(
      shouldSkipGroupTurnForAutoAssist({
        personalRcDm: true,
        autoAssistEnabled: true,
        hasSlashCommand: false,
      }),
    ).toBe(false);
  });
});

describe('buildGroupTurnPrompt', () => {
  it('passes raw slash command turns through unchanged', () => {
    const result = buildGroupTurnPrompt({
      chatJid: 'rc:123',
      groupFolder: 'rc-personal',
      messages: [{ content: '/compact' }],
      turnText: '/compact',
      turnMode: 'raw',
      personalRcDm: true,
      autoAssistEnabled: false,
    });

    expect(result.prompt).toBe('/compact');
  });

  it('adds NanoClaw RC policy prefixes for formatted personal DM turns', () => {
    const result = buildGroupTurnPrompt({
      chatJid: 'rc:123',
      groupFolder: 'rc-personal',
      messages: [{ content: 'please reply' }],
      turnText: 'formatted prompt',
      turnMode: 'formatted',
      personalRcDm: true,
      autoAssistEnabled: true,
    });

    expect(result.prompt).toContain('Auto-assistant mode is ON');
    expect(result.prompt).toContain('normal replies use bot delivery by policy');
    expect(result.prompt).toContain('formatted prompt');
  });
});
