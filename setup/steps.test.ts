import { describe, expect, it } from 'vitest';

import { formatSetupUsage, getSetupStep, getSetupSteps } from './steps.js';

describe('setup steps registry', () => {
  it('lists core setup steps with summaries', () => {
    const steps = getSetupSteps();

    expect(steps.map((step) => step.name)).toEqual(
      expect.arrayContaining(['environment', 'container', 'service', 'verify']),
    );
    expect(steps.every((step) => step.summary.length > 0)).toBe(true);
  });

  it('can look up a registered step', () => {
    expect(getSetupStep('verify')).toMatchObject({
      name: 'verify',
    });
    expect(getSetupStep('unknown')).toBeUndefined();
  });

  it('formats help text with step descriptions', () => {
    const helpText = formatSetupUsage('npm run setup --');

    expect(helpText).toContain('npm run setup -- --step <name> [args...]');
    expect(helpText).toContain('environment');
    expect(helpText).toContain('verify');
  });
});
