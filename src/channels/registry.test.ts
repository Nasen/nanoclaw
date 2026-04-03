import { beforeEach, describe, expect, it } from 'vitest';

import {
  getChannelFactory,
  getChannelRegistration,
  getRegisteredChannelNames,
  registerChannel,
  resetChannelRegistry,
} from './registry.js';

describe('channel registry', () => {
  beforeEach(() => {
    resetChannelRegistry();
  });

  it('getChannelFactory returns undefined for unknown channel', () => {
    expect(getChannelFactory('nonexistent')).toBeUndefined();
  });

  it('registerChannel and getChannelFactory round-trip', () => {
    const factory = () => null;
    registerChannel({
      name: 'test-channel',
      displayName: 'Test Channel',
      requiredEnvVars: ['TEST_TOKEN'],
      factory,
    });

    expect(getChannelFactory('test-channel')).toBe(factory);
    expect(getChannelRegistration('test-channel')).toMatchObject({
      name: 'test-channel',
      displayName: 'Test Channel',
      requiredEnvVars: ['TEST_TOKEN'],
    });
  });

  it('getRegisteredChannelNames includes registered channels', () => {
    registerChannel('another-channel', () => null);
    registerChannel('test-channel', () => null);

    const names = getRegisteredChannelNames();
    expect(names).toContain('test-channel');
    expect(names).toContain('another-channel');
  });

  it('duplicate registration fails fast', () => {
    registerChannel('duplicate-test', () => null);

    expect(() => registerChannel('duplicate-test', () => null)).toThrow(
      'Channel "duplicate-test" is already registered.',
    );
  });
});
