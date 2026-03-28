import { describe, expect, it } from 'vitest';

import {
  extractExplicitRcTarget,
  shouldSkipHistoryForRcLookup,
} from './openai.js';

describe('extractExplicitRcTarget', () => {
  it('extracts an exact bracketed team name from a RingCentral summary request', () => {
    expect(
      extractExplicitRcTarget(
        "Summarize today's messages in [mThor&mZeus] automation sync up team",
      ),
    ).toBe('[mThor&mZeus] automation sync up');
  });

  it('extracts an exact quoted team name from a RingCentral summary request', () => {
    expect(
      extractExplicitRcTarget(
        'Summarize today\'s messages in "[mThor&mZeus] automation sync up" team',
      ),
    ).toBe('[mThor&mZeus] automation sync up');
  });
});

describe('shouldSkipHistoryForRcLookup', () => {
  it('skips history when the latest prompt names an exact bracketed RingCentral team', () => {
    expect(
      shouldSkipHistoryForRcLookup(
        "Summarize today's messages in [mThor&mZeus] automation sync up team",
        true,
      ),
    ).toBe(true);
  });
});
