import { describe, expect, it } from 'vitest';

import {
  hasExplicitOnBehalfIntent,
  hasExplicitOnBehalfIntentInMessages,
  resolveCrossChatRcDelivery,
  resolveCurrentChatRcDelivery,
} from './rc-delivery-policy.js';

describe('rc-delivery-policy', () => {
  it('detects explicit on-behalf intent phrases', () => {
    expect(
      hasExplicitOnBehalfIntent('Please reply as me and use my account.'),
    ).toBe(true);
    expect(hasExplicitOnBehalfIntent('Just answer normally.')).toBe(false);
  });

  it('detects on-behalf intent from the latest inbound message', () => {
    expect(
      hasExplicitOnBehalfIntentInMessages([
        { content: 'older', is_from_me: false },
        { content: 'please send as me', is_from_me: false },
      ]),
    ).toBe(true);
  });

  it('defaults RingCentral current-chat replies to bot delivery', () => {
    expect(
      resolveCurrentChatRcDelivery({
        chatJid: 'rc:12345',
        onBehalfIntent: false,
      }),
    ).toEqual({
      mode: 'bot',
      policyForced: true,
    });
  });

  it('forces current-chat personal delivery when on-behalf intent is explicit', () => {
    expect(
      resolveCurrentChatRcDelivery({
        chatJid: 'rcb:12345',
        requestedMode: 'bot',
        onBehalfIntent: true,
      }),
    ).toEqual({
      mode: 'personal',
      policyForced: true,
    });
  });

  it('honors explicit personal cross-chat RC sends without downgrading', () => {
    expect(
      resolveCrossChatRcDelivery({
        requestedMode: 'personal',
        onBehalfIntent: false,
      }),
    ).toEqual({
      mode: 'personal',
      policyForced: false,
    });
  });

  it('defaults cross-chat RC sends to bot when no mode or on-behalf intent is supplied', () => {
    expect(
      resolveCrossChatRcDelivery({
        requestedMode: 'auto',
        onBehalfIntent: false,
      }),
    ).toEqual({
      mode: 'bot',
      policyForced: true,
    });
  });

  it('forces personal delivery when on-behalf intent is explicit', () => {
    expect(
      resolveCrossChatRcDelivery({
        requestedMode: 'auto',
        onBehalfIntent: true,
      }),
    ).toEqual({
      mode: 'personal',
      policyForced: true,
    });
  });
});
